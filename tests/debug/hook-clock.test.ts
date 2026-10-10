import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { runHookProcess, type HookProcessIo } from "../../packages/cli/src/hook-process.js";

const SESSION = "native-session";

function io(input: unknown): { readonly io: HookProcessIo; readonly stdout: string[] } {
  const stdout: string[] = [];
  return {
    stdout,
    io: {
      stdin: Readable.from([JSON.stringify(input)]),
      writeStdout: value => stdout.push(value),
      writeStderr: () => undefined
    }
  };
}

async function fixture(): Promise<{
  readonly root: string;
  readonly config: AgentOpsConfig;
  readonly tasks: TaskService;
  readonly taskId: string;
  readonly close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-hook-clock-"));
  const git = (...args: string[]) => execFileSync("git", args, {cwd: root, stdio: ["ignore", "pipe", "pipe"]});
  git("init", "-q");
  git("config", "user.name", "Hook clock fixture");
  git("config", "user.email", "fixture@example.invalid");
  await mkdir(join(root, ".agent-ops"), {recursive: true});
  const config: AgentOpsConfig = {
    schemaVersion: 3,
    profiles: ["core"],
    verification: {commands: [], acceptanceRunners: []},
    features: {
      completionGate: {enabled: true},
      stopVerification: {enabled: false},
      debug: {enabled: true, budgetMs: 3_600_000, maxRounds: 5}
    },
    pathMappings: [],
    securityExceptions: []
  };
  await writeFile(join(root, ".agent-ops", "config.json"), JSON.stringify(config));
  await writeFile(join(root, "product.mjs"), "export const value=0;\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  const baseline = git("rev-parse", "HEAD").toString().trim();
  const gitRunner = {run: async (args: readonly string[]) => {
    try { return {exitCode: 0, stdout: git(...args)}; }
    catch { return {exitCode: 1, stdout: Buffer.alloc(0)}; }
  }};
  const tasks = new TaskService(new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root), {
    completion: {root, gitRunner, loadConfig: async () => config}
  });
  const record = await tasks.create({
    title: "Hook clock fixture",
    goal: "Investigate the original issue",
    criteria: [
      {id: "issue", description: "Issue", verifierIds: [], acceptance: {mode: "review-only", baselineCommit: baseline, bindings: [], reviewOnlyReason: "Fixture"}},
      {id: "related", description: "Related", verifierIds: [], acceptance: {mode: "review-only", baselineCommit: baseline, bindings: [], reviewOnlyReason: "Fixture"}}
    ],
    debug: {facts: ["reported"], unknowns: ["root cause"]},
    sessionId: SESSION,
    policyConfigHash: calculateConfigHash(config)
  });
  return {root, config, tasks, taskId: record.task.id, close: async () => await rm(root, {recursive: true, force: true})};
}

test("a blocked or errored Stop keeps foreground timing active until an accepted idle Stop", async () => {
  const f = await fixture();
  try {
    const debug = f.tasks.debugService();
    await debug.foregroundStart(f.taskId, SESSION);
    let allow = false;
    const stop = () => ({hook_event_name: "Stop", session_id: SESSION, cwd: f.root, stop_hook_active: false});
    const run = async (input: unknown) => {
      const streams = io(input);
      await runHookProcess(["claude", "Stop", "--completion-gate"], streams.io, "0.8.1", {
        root: f.root,
        loadConfig: async () => f.config,
        trust: async () => "TRUSTED",
        completionGate: {
          handle: async () => allow
            ? {action: "continue", status: "PASS", code: "COMPLETION_GATE_ALLOWED"}
            : {action: "block", status: "FAIL", code: "COMPLETION_GATE_TASK_DEBUG_ACTIVE"}
        }
      });
      return streams.stdout;
    };

    await run(stop());
    assert.equal((await debug.root(f.taskId)).debug.foreground?.sessionId, SESSION);
    allow = true;
    await run(stop());
    assert.equal((await debug.root(f.taskId)).debug.foreground, null);

    await debug.foregroundStart(f.taskId, SESSION);
    await run({...stop(), stop_hook_active: true});
    assert.equal((await debug.root(f.taskId)).debug.foreground?.sessionId, SESSION);
    await run(stop());
    assert.equal((await debug.root(f.taskId)).debug.foreground, null);

    await debug.foregroundStart(f.taskId, SESSION);
    const errorStreams = io(stop());
    await runHookProcess(["claude", "Stop", "--completion-gate"], errorStreams.io, "0.8.1", {
      root: f.root,
      loadConfig: async () => f.config,
      trust: async () => "TRUSTED",
      completionGate: {handle: async () => { throw new Error("gate unavailable"); }}
    });
    assert.equal((await debug.root(f.taskId)).debug.foreground?.sessionId, SESSION);

    await debug.foregroundStop(f.taskId, SESSION);
    await debug.foregroundStart(f.taskId, SESSION);
    const codexStreams = io({hook_event_name: "Stop", session_id: SESSION, cwd: f.root, stop_hook_active: false});
    await runHookProcess(["codex", "Stop"], codexStreams.io, "0.8.1", {
      root: f.root,
      loadConfig: async () => f.config,
      trust: async () => "TRUSTED"
    });
    assert.equal((await debug.root(f.taskId)).debug.foreground, null);

    await debug.foregroundStart(f.taskId, SESSION);
    const agyStart = io({invocationNum: 1, conversationId: SESSION, workspacePaths: [f.root]});
    await runHookProcess(["agy", "SessionStart"], agyStart.io, "0.8.1", {
      root: f.root,
      loadConfig: async () => f.config,
      trust: async () => "TRUSTED"
    });
    assert.equal((await debug.root(f.taskId)).debug.foreground?.sessionId, SESSION);
    const agyStop = io({terminationReason: "model_stop", fullyIdle: true, conversationId: SESSION, workspacePaths: [f.root]});
    await runHookProcess(["agy", "Stop", "--completion-gate"], agyStop.io, "0.8.1", {
      root: f.root,
      loadConfig: async () => f.config,
      trust: async () => "TRUSTED",
      completionGate: {handle: async () => ({action: "continue", status: "PASS", code: "COMPLETION_GATE_ALLOWED"})}
    });
    assert.equal((await debug.root(f.taskId)).debug.foreground, null);
  } finally {
    await f.close();
  }
});
