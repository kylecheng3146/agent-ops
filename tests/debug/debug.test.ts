import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { AcceptanceCriterion, AgentOpsConfig } from "../../runtime/src/contracts.js";
import { CliArgumentError, parseArgs } from "../../packages/cli/src/args.js";
import { runHookProcess, type HookProcessIo } from "../../packages/cli/src/hook-process.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { validateConfig } from "../../runtime/src/schema/validate.js";
import { resolveCapabilities } from "../../runtime/src/install/profiles.js";
import { createInstallPlan } from "../../runtime/src/install/plan.js";
import { commonHarnessAdapters } from "../../runtime/src/install/harness.js";

const SESSION = "native-session";

function streams(input: unknown): { readonly io: HookProcessIo; readonly stdout: string[] } {
  const stdout: string[] = [];
  return {stdout, io: {stdin: Readable.from([JSON.stringify(input)]), writeStdout: value => stdout.push(value), writeStderr: () => undefined}};
}

async function fixture(gate: boolean) {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-debug-slim-"));
  const git = (...args: string[]) => execFileSync("git", args, {cwd: root, stdio: ["ignore", "pipe", "pipe"]});
  git("init", "-q");
  git("config", "user.name", "Debug fixture");
  git("config", "user.email", "fixture@example.invalid");
  const config: AgentOpsConfig = {
    schemaVersion: 3,
    profiles: ["core"],
    verification: {commands: [], acceptanceRunners: [{id: "regression", command: process.execPath, args: ["check.mjs"], cwd: ".", adapter: "generic"}]},
    // Pre-0.11 settings stay valid and are ignored.
    features: {completionGate: {enabled: gate}, stopVerification: {enabled: false}, debug: {enabled: true, budgetMs: 50, maxRounds: 1}},
    pathMappings: [],
    securityExceptions: []
  };
  await mkdir(join(root, ".agent-ops"), {recursive: true});
  await writeFile(join(root, ".agent-ops", "config.json"), JSON.stringify(config));
  await writeFile(join(root, ".gitignore"), ".agent-ops/\n");
  await writeFile(join(root, "product.mjs"), "export const value=0;\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  const baseline = git("rev-parse", "HEAD").toString().trim();
  const gitRunner = {run: async (args: readonly string[]) => {
    try { return {exitCode: 0, stdout: git(...args)}; } catch { return {exitCode: 1, stdout: Buffer.alloc(0)}; }
  }};
  const tasks = new TaskService(new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root),
    {completion: {root, gitRunner, loadConfig: async () => config}});
  const materials = [{path: "check.mjs", role: "test" as const}];
  const red = (redCheckIds: string[]): AcceptanceCriterion[] => [
    {id: "issue", description: "Original issue", verifierIds: [],
      acceptance: {mode: "behavioral", baselineCommit: baseline, bindings: [{runnerId: "regression", materials, checkIds: ["issue"], redCheckIds}]}},
    {id: "related", description: "Related invariant", verifierIds: [],
      acceptance: {mode: "invariant", baselineCommit: baseline, bindings: [{runnerId: "regression", materials, checkIds: ["related"]}]}}];
  return {root, config, tasks, red, close: async () => await rm(root, {recursive: true, force: true})};
}

test("task debug is removed for every former action", () => {
  for (const action of ["status", "hypothesis", "strategy", "investigate", "checkpoint", "resume", "extend", "origin"]) {
    assert.throws(() => parseArgs(["task", "debug", "--task", "task-id", "--debug-action", action]),
      (error: unknown) => error instanceof CliArgumentError && error.code === "TASK_DEBUG_REMOVED" && /task create --debug/u.test(error.message));
  }
  assert.equal(parseArgs(["task", "create", "--title", "Bug", "--goal", "It fails", "--debug"]).debug, true);
});

test("a DEBUG task needs a red check and a surface like any task", async () => {
  const f = await fixture(false);
  try {
    const base = {title: "Bug", goal: "Value should be one", debug: {}, sessionId: SESSION};
    await assert.rejects(f.tasks.create({...base, criteria: f.red([])}), {code: "TASK_DEBUG_RED_CHECK_REQUIRED"});
    await assert.rejects(f.tasks.create({...base, criteria: f.red(["issue"]), requireSurface: true}), {code: "SURFACE_MISSING"});
    const created = await f.tasks.create({...base, criteria: f.red(["issue"])});
    assert.equal(created.task.debug?.rootTaskId, created.task.id);
    assert.equal(created.task.originRequired, undefined);
  } finally {
    await f.close();
  }
});

test("hooks neither open DEBUG tasks nor hold Stop for one", async () => {
  for (const gate of [false, true]) {
    const f = await fixture(gate);
    try {
      await f.tasks.create({title: "Bug", goal: "Value should be one", debug: {}, sessionId: SESSION, criteria: f.red(["issue"])});
      const deps = {root: f.root, loadConfig: async () => f.config, trust: async () => "TRUSTED" as const};
      // The gated Stop is Claude's; it needs the session baseline its SessionStart records.
      if (gate) await runHookProcess(["claude", "SessionStart", "--completion-gate"], streams({hook_event_name: "SessionStart", session_id: SESSION, cwd: f.root}).io, "0.11.0", deps);
      const stops: [string, unknown][] = gate ? [["claude", {hook_event_name: "Stop", session_id: SESSION, cwd: f.root, stop_hook_active: false}]] : [
        ["claude", {hook_event_name: "Stop", session_id: SESSION, cwd: f.root, stop_hook_active: false}],
        ["codex", {hook_event_name: "Stop", session_id: SESSION, cwd: f.root, stop_hook_active: true}],
        ["agy", {terminationReason: "model_stop", fullyIdle: true, conversationId: SESSION, workspacePaths: [f.root]}]
      ];
      for (const [harness, input] of stops) {
        const s = streams(input);
        await runHookProcess([harness, "Stop", ...(gate ? ["--completion-gate"] : [])], s.io, "0.11.0", deps);
        const out = s.stdout.join("");
        assert.doesNotMatch(out, /DEBUG|checkpoint/u, `${harness} gate=${gate}: ${out}`);
        assert.notEqual(out.length > 0 ? JSON.parse(out).decision : undefined, "block", `${harness} gate=${gate}: ${out}`);
      }
      for (const harness of ["claude", "codex"]) {
        const s = streams({hook_event_name: "UserPromptSubmit", session_id: "other-session", cwd: f.root, prompt: "登入偶爾會失敗，請找出原因並修復。"});
        await runHookProcess([harness, "UserPromptSubmit"], s.io, "0.11.0", deps);
        assert.equal(s.stdout.join(""), "", harness);
      }
      const interrupt = streams({session_id: SESSION, cwd: f.root});
      assert.equal(await runHookProcess(["codex", "Interrupt"], interrupt.io, "0.11.0", deps), 0);
      assert.equal(interrupt.stdout.join(""), "");
      assert.equal((await f.tasks.list()).length, 1, "no prompt created a task");
    } finally {
      await f.close();
    }
  }
});

test("install neither resolves task-debug nor writes features.debug", async () => {
  const f = await fixture(false);
  try {
    assert.ok(validateConfig(f.config).ok, "legacy features.debug still validates");
    assert.equal((resolveCapabilities(f.config).capabilities as string[]).includes("task-debug"), false);
    const fresh = await mkdtemp(join(tmpdir(), "agent-ops-debug-install-"));
    const plan = await createInstallPlan({root: fresh, scope: "project", harness: ["claude", "codex"], profiles: ["core", "loop"], adapters: commonHarnessAdapters(),
      hookRuntimePath: "/opt/agent-ops/hook-entry.js"})
      .finally(async () => await rm(fresh, {recursive: true, force: true}));
    assert.equal(plan.config.features.debug, undefined);
    const written = plan.operations.filter(o => o.kind === "write").map(o => "content" in o ? String(o.content) : "").join("\n");
    assert.match(written, /task create --debug --goal/u);
    assert.doesNotMatch(written, /60 cumulative active minutes|只診斷|debug-action|"Interrupt"/u);
  } finally {
    await f.close();
  }
});
