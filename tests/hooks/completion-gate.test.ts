import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runHookCommand } from "../../packages/cli/src/commands/hook.js";
import { normalizeClaudeHookInput } from "../../runtime/src/adapters/claude/input.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import {
  CompletionGateService,
  FileCompletionGateStore
} from "../../runtime/src/hooks/completion-gate.js";
import { saveReviewAttestation } from "../../runtime/src/review/attestation.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import {
  buildVerificationEvidence,
  FileEvidenceStore
} from "../../runtime/src/verify/evidence.js";
import {
  collectChangeSurface,
  type GitRunResult,
  type GitRunner
} from "../../runtime/src/verify/change-surface.js";
import { calculateSourceFingerprint } from "../../runtime/src/verify/source-fingerprint.js";
import { createFailureFingerprint } from "../../runtime/src/verify/fingerprint.js";
import { passingCompletionEvidence } from "../task/completion-fixture.js";

const execFile = promisify(execFileCallback);
const SESSION = "conversation-one";
const CONFIG: AgentOpsConfig = {
  schemaVersion: 3,
  profiles: ["core", "loop"],
  verification: {
    commands: [{
      id: "node-test",
      command: "node",
      args: ["--test"],
      cwd: ".",
      required: true,
      evidence: { kind: "test-count", minimum: 1 }
    }]
  },
  features: {
    completionGate: { enabled: true },
    stopVerification: { enabled: false }
  },
  pathMappings: [],
  securityExceptions: []
};

function gitRunner(root: string): GitRunner {
  return {
    async run(args: readonly string[]): Promise<GitRunResult> {
      try {
        const result = await execFile("git", [...args], { cwd: root, encoding: "buffer" });
        return { exitCode: 0, stdout: result.stdout as Buffer };
      } catch (error) {
        const failure = error as { status?: number; stdout?: Uint8Array };
        return { exitCode: failure.status ?? 1, stdout: failure.stdout ?? new Uint8Array() };
      }
    }
  };
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-completion-gate-"));
  await execFile("git", ["init"], { cwd: root });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await execFile("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "source.txt"), "base\n");
  await execFile("git", ["add", "source.txt"], { cwd: root });
  await execFile("git", ["commit", "-m", "base"], { cwd: root });
  return root;
}

function setup(root: string, config = CONFIG) {
  const tasks = new TaskService(
    new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root),
    { generateId: () => "task-one", now: () => "2026-08-29T00:00:00Z",
      completion: { root, gitRunner: gitRunner(root), loadConfig: async () => config } }
  );
  const evidence = new FileEvidenceStore(root, root);
  const runner = gitRunner(root);
  return {
    tasks,
    evidence,
    runner,
    gate: new CompletionGateService({
      root,
      config,
      gitRunner: runner,
      taskService: tasks,
      evidenceStore: evidence,
      stateStore: new FileCompletionGateStore(root)
    })
  };
}

async function fingerprint(root: string, runner: GitRunner): Promise<string> {
  const surface = await collectChangeSurface(runner);
  return await calculateSourceFingerprint(
    root,
    { mode: "worktree", changedFiles: surface.paths },
    runner
  );
}

function stop() {
  return {
    event: "stop" as const,
    projectRoot: ".",
    sessionId: SESSION,
    terminationReason: "model_stop",
    fullyIdle: true
  };
}

test("preexisting Git-visible changes and read-only turns stop normally", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "source.txt"), "preexisting\n");
    const { gate } = setup(root);
    assert.equal((await gate.initialize(SESSION)).code, "COMPLETION_GATE_READY");
    assert.equal((await gate.handle(stop()))?.code, "COMPLETION_GATE_ALLOWED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a session change blocks without a task and non-final stops stay allowed", async () => {
  const root = await repository();
  try {
    const { gate } = setup(root);
    await gate.initialize(SESSION);
    await writeFile(join(root, "source.txt"), "changed\n");
    assert.equal((await gate.handle(stop()))?.code, "COMPLETION_GATE_TASK_REQUIRED");
    const { fullyIdle: _fullyIdle, ...missingIdle } = stop();
    assert.equal((await gate.handle(missingIdle))?.code, "COMPLETION_GATE_STOP_INPUT_INVALID");
    assert.equal((await gate.handle({ ...stop(), fullyIdle: false }))?.code, "COMPLETION_GATE_NON_FINAL_STOP");
    assert.equal((await gate.handle({
      ...stop(),
      terminationReason: "error"
    }))?.action, "continue");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current task evidence and review allow Stop and checkpoint the source", async () => {
  const root = await repository();
  try {
    const { gate, tasks, evidence, runner } = setup(root);
    await gate.initialize(SESSION);
    await writeFile(join(root, "source.txt"), "changed\n");
    const sourceFingerprint = await fingerprint(root, runner);
    const task = await tasks.create({
      title: "Change source",
      criteria: [
        { id: "behavior", description: "Behavior passes", verifierIds: ["node-test"] },
        { id: "regression", description: "Regression passes", verifierIds: ["node-test"] }
      ],
      policyConfigHash: calculateConfigHash(CONFIG)
    });
    await tasks.attach(SESSION, task.task.id);
    const references: Record<string, string[]> = {};
    for (const criterion of task.task.criteria) {
      const reference = await evidence.save(buildVerificationEvidence({
        taskId: task.task.id,
        criterionId: criterion.id,
        command: CONFIG.verification.commands[0]!,
        scope: "project",
        startedAt: "2026-08-29T00:00:00Z",
        finishedAt: "2026-08-29T00:00:01Z",
        exitCode: 0,
        testCount: 1,
        status: "PASS",
        failureClass: "none",
        sourceFingerprint,
        toolVersions: {},
        config: CONFIG
      }));
      references[criterion.id] = [reference];
    }
    await saveReviewAttestation(root, {
      schemaVersion: 1,
      taskId: task.task.id,
      harness: "self-review",
      status: "PASS",
      sourceFingerprint,
      createdAt: "2026-08-29T00:00:02Z"
    });
    await tasks.complete(task.task.id, references);
    assert.equal(await fingerprint(root, runner), sourceFingerprint);
    await tasks.recordFailure(task.task.id, createFailureFingerprint({
      commandId: "node-test", failureClass: "nonzero-exit", exitCategory: "nonzero", diagnostics: "later failure"
    }));
    assert.equal((await gate.handle(stop()))?.code, "COMPLETION_GATE_VERIFICATION_FAILED");
    await tasks.clearFailure(task.task.id);
    assert.equal((await gate.handle(stop()))?.code, "COMPLETION_GATE_ALLOWED");
    assert.equal((await gate.handle(stop()))?.code, "COMPLETION_GATE_ALLOWED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fingerprint-bound permit is consumed by one allowed Stop", async () => {
  const root = await repository();
  try {
    const { gate } = setup(root);
    await gate.initialize(SESSION);
    await writeFile(join(root, "source.txt"), "first\n");
    await gate.grantPermit(SESSION);
    assert.equal((await gate.handle(stop()))?.code, "COMPLETION_GATE_ALLOWED");
    await writeFile(join(root, "source.txt"), "second\n");
    assert.equal((await gate.handle(stop()))?.code, "COMPLETION_GATE_TASK_REQUIRED");
    assert.equal((await gate.handle({
      event: "command",
      projectRoot: root,
      sessionId: SESSION,
      command: "agent-ops",
      args: ["allow-stop", "--session", SESSION],
      scope: root
    }))?.code, "COMPLETION_GATE_PERMIT_CONFIRMATION");
    assert.equal((await gate.handle({
      event: "command",
      projectRoot: root,
      sessionId: SESSION,
      command: "node",
      args: ["/opt/agent-ops/bin.js", "allow-stop", "--session", SESSION],
      scope: root
    }))?.code, "COMPLETION_GATE_PERMIT_CONFIRMATION");
    assert.equal((await gate.handle({
      event: "command-batch", projectRoot: root, scope: root,
      commands: [
        { command: "echo", args: ["ready"] },
        { command: "agent-ops", args: ["allow-stop", "--json", "--session", "other-session"] }
      ]
    }))?.code, "COMPLETION_GATE_PERMIT_CONFIRMATION");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional-only criteria cannot satisfy completion", async () => {
  const root = await repository();
  try {
    const config = { ...CONFIG, verification: { commands: CONFIG.verification.commands.map((command) => ({ ...command, required: false })) } };
    const { gate, tasks } = setup(root, config);
    await gate.initialize(SESSION);
    await writeFile(join(root, "source.txt"), "changed\n");
    const task = await tasks.create({ title: "Optional checks", policyConfigHash: calculateConfigHash(config), criteria: [
      { id: "behavior", description: "Behavior passes", verifierIds: ["node-test"] },
      { id: "regression", description: "Regression passes", verifierIds: ["node-test"] }
    ] });
    await tasks.attach(SESSION, task.task.id);
    await assert.rejects(tasks.complete(task.task.id, await passingCompletionEvidence(root, task, config, gitRunner(root))),
      { code: "TASK_COMPLETION_REQUIRED_VERIFIER_MISSING" });
    // The gate must also reject a legacy record written before completion was enforced.
    await new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root).mutate((state) => {
      state.tasks = state.tasks.map((current) => current.task.id === task.task.id
        ? { ...task, status: "complete", completedAt: "2026-08-29T00:00:00Z",
          evidence: { behavior: ["fake"], regression: ["fake"] } } : current);
    });
    assert.equal((await gate.handle(stop()))?.code, "COMPLETION_GATE_REQUIRED_VERIFIER_MISSING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy completed parents and children cannot hide an unfinished grandchild", async () => {
  const root = await repository();
  try {
    const { gate, tasks } = setup(root);
    await gate.initialize(SESSION);
    await writeFile(join(root, "source.txt"), "changed\n");
    const parent = await tasks.create({ title: "Parent", policyConfigHash: calculateConfigHash(CONFIG), criteria: [
      { id: "behavior", description: "Behavior passes", verifierIds: ["node-test"] },
      { id: "regression", description: "Regression passes", verifierIds: ["node-test"] }
    ] });
    await tasks.attach(SESSION, parent.task.id);
    const store = new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root);
    const children = new TaskService(store);
    const child = await children.create({ title: "Child", criteria: parent.task.criteria, parentTaskId: parent.task.id });
    const grandchild = await children.create({ title: "Grandchild", criteria: parent.task.criteria, parentTaskId: child.task.id });
    await store.mutate((state) => {
      state.tasks = state.tasks.map((record) => record.task.id === grandchild.task.id ? record : {
        ...record, status: "complete", completedAt: record.createdAt,
        evidence: { behavior: ["legacy"], regression: ["legacy"] }
      });
    });
    assert.equal((await gate.handle(stop()))?.code, "COMPLETION_GATE_SUBTASK_INCOMPLETE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tracked runtime blocks native agy Stop with actionable recovery instead of a generic hook error", async () => {
  const root = await repository();
  try {
    const { gate, tasks } = setup(root);
    await gate.initialize(SESSION);
    await tasks.create({ title: "Runtime guard", criteria: [
      { id: "one", description: "One passes", verifierIds: ["node-test"] },
      { id: "two", description: "Two passes", verifierIds: ["node-test"] }
    ] });
    await execFile("git", ["add", "-f", ".agent-ops/tasks/state.json"], { cwd: root });
    const output = await runHookCommand({ harness: "agy", event: "Stop", trusted: true, config: CONFIG,
      stdin: JSON.stringify({ workspacePaths: [root], conversationId: SESSION, terminationReason: "model_stop", fullyIdle: true }),
      completionGate: gate });
    assert.match(output.stdout, /COMPLETION_GATE_TRACKED_RUNTIME/u);
    assert.match(output.stdout, /git rm -r --cached/u);
    assert.equal(JSON.parse(output.stdout).decision, "continue");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a real gate reaches its session state from Claude's own Stop payload", async () => {
  const root = await repository();
  try {
    const { gate } = setup(root);
    const claudeStop = normalizeClaudeHookInput({
      hook_event_name: "Stop",
      cwd: root,
      session_id: SESSION
    });
    const claudeStart = normalizeClaudeHookInput({
      hook_event_name: "SessionStart",
      cwd: root,
      session_id: SESSION
    });

    // Not COMPLETION_GATE_SESSION_REQUIRED and not STOP_INPUT_INVALID: those
    // are what a payload missing the session or the termination metadata gets,
    // and Claude publishes neither field under those names.
    const started = await gate.handle(claudeStart);
    assert.equal(started?.code, "COMPLETION_GATE_READY");
    const stopped = await gate.handle(claudeStop);
    assert.ok(stopped);
    assert.ok(
      stopped.code !== "COMPLETION_GATE_SESSION_REQUIRED" &&
      stopped.code !== "COMPLETION_GATE_STOP_INPUT_INVALID" &&
      stopped.code !== "COMPLETION_GATE_NOT_INITIALIZED",
      stopped.code
    );

    // Claude's recursion marker is the not-yet-idle case, which passes through.
    const recursive = await gate.handle(normalizeClaudeHookInput({
      hook_event_name: "Stop",
      cwd: root,
      session_id: SESSION,
      stop_hook_active: true
    }));
    assert.equal(recursive?.code, "COMPLETION_GATE_NON_FINAL_STOP");
    assert.equal(recursive?.action, "continue");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
