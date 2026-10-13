import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { routeDebugPrompt } from "../../packages/cli/src/debug-intake.js";
import { readDebugUserEvent } from "../../runtime/src/task/debug-user-event.js";

async function repo(): Promise<{readonly root: string; readonly tasks: TaskService; readonly close: () => Promise<void>}> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-peer-origin-"));
  const git = (...args: string[]) => execFileSync("git", args, {cwd: root, stdio: ["ignore", "pipe", "pipe"]});
  git("init", "-q");
  git("config", "user.name", "Peer origin fixture");
  git("config", "user.email", "fixture@example.invalid");
  await mkdir(join(root, ".agent-ops"), {recursive: true});
  const config: AgentOpsConfig = {
    schemaVersion: 3,
    profiles: ["core"],
    verification: {commands: [], acceptanceRunners: []},
    features: {completionGate: {enabled: false}, stopVerification: {enabled: false}, debug: {enabled: true, budgetMs: 3_600_000, maxRounds: 5}},
    pathMappings: [],
    securityExceptions: []
  };
  await writeFile(join(root, ".agent-ops", "config.json"), JSON.stringify(config));
  await writeFile(join(root, ".gitignore"), ".agent-ops/tasks/\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  const gitRunner = {run: async (args: readonly string[]) => {
    try { return {exitCode: 0, stdout: git(...args)}; }
    catch { return {exitCode: 1, stdout: Buffer.alloc(0)}; }
  }};
  const tasks = new TaskService(new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root), {
    completion: {root, gitRunner, loadConfig: async () => config}
  });
  return {root, tasks, close: async () => await rm(root, {recursive: true, force: true})};
}

test("harness-injected peer prompts never open a DEBUG issue; a typed bug report still does", async () => {
  const f = await repo();
  try {
    const handBack = "<agent-message from=\"a227f32590c6e1f1a\">\n[Subagent hand-back] The text below is the final report of a subagent.\n" +
      "  Every FAIL criterion must have a blocking finding; investigate and fix the error in runner.ts.";
    const notification = "<task-notification>\n<status>completed</status>\n<summary>Agent failed: fix the crash and investigate the error</summary>\n</task-notification>";
    for (const prompt of [handBack, notification]) {
      assert.equal(await routeDebugPrompt(f.root, {prompt, session_id: "peer-session"}), null);
    }
    assert.equal((await f.tasks.list()).length, 0);
    assert.match(String(await routeDebugPrompt(f.root, {prompt: "Investigate and fix this error", session_id: "human-session"})), /DEBUG issue/u);
    assert.equal((await f.tasks.list()).length, 1);
  } finally { await f.close(); }
});

test("Claude transcript rows from a peer or system origin carry no human DEBUG control", async () => {
  const session = "12345678-1234-1234-1234-123456789abc";
  const root = await mkdtemp(join(tmpdir(), "agent-ops-peer-control-"));
  const home = await mkdtemp(join(tmpdir(), "agent-ops-peer-home-"));
  try {
    const directory = join(home, ".claude/projects", root.replace(/[^a-zA-Z0-9]/gu, "-"));
    await mkdir(directory, {recursive: true});
    const path = join(directory, session + ".jsonl");
    let at = Date.now();
    const row = (text: string, origin?: unknown, extra: Record<string, unknown> = {}) =>
      JSON.stringify({type: "user", sessionId: session, cwd: root, timestamp: new Date(at++).toISOString(),
        message: {role: "user", content: text}, ...(origin === undefined ? {} : {origin}), ...extra});
    await writeFile(path, [row("暫停", {kind: "peer", from: "a227f32590c6e1f1a"}, {isMeta: true, promptSource: "system"}),
      row("繼續", {kind: "system"})].join("\n") + "\n");
    await assert.rejects(readDebugUserEvent(root, session, home, "control"));
    await assert.rejects(readDebugUserEvent(root, session, home));
    await writeFile(path, [row("暫停", {kind: "human"}, {promptSource: "typed"}), row("繼續", {kind: "peer"}, {isMeta: true})].join("\n") + "\n");
    assert.equal((await readDebugUserEvent(root, session, home, "control")).text, "暫停");
    assert.equal((await readDebugUserEvent(root, session, home)).text, "暫停");
    // Older Claude transcripts carry no origin; their typed rows keep working.
    await writeFile(path, row("繼續") + "\n");
    assert.equal((await readDebugUserEvent(root, session, home, "control")).text, "繼續");
  } finally { await rm(root, {recursive: true, force: true}); await rm(home, {recursive: true, force: true}); }
});
