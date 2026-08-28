import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

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
  await writeFile(
    join(root, ".gitignore"),
    ".agent-ops/tasks/\n.agent-ops/reviews/\n"
  );
  await execFile("git", ["add", "source.txt", ".gitignore"], { cwd: root });
  await execFile("git", ["commit", "-m", "base"], { cwd: root });
  return root;
}

function setup(root: string) {
  const tasks = new TaskService(
    new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root),
    { generateId: () => "task-one", now: () => "2026-08-29T00:00:00Z" }
  );
  const evidence = new FileEvidenceStore(root, root);
  const runner = gitRunner(root);
  return {
    tasks,
    evidence,
    runner,
    gate: new CompletionGateService({
      root,
      config: CONFIG,
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
