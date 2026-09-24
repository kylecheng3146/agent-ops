import assert from "node:assert/strict";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { claudeHookOutput } from "../../runtime/src/adapters/claude/output.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { FileCompletionGateStore } from "../../runtime/src/hooks/completion-gate.js";
import { doctorInstallation } from "../../runtime/src/install/doctor.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import type { FinishDependencies } from "../../runtime/src/parallel/finish.js";
import {
  idleWorktrees,
  listWorktrees,
  removeWorktree,
  RESUMED_BASELINE,
  resumeWorktree,
  worktreeDoctorResult,
  type WorktreeStatus
} from "../../runtime/src/parallel/manage.js";
import { addWorktree, readWorktreeRecord } from "../../runtime/src/parallel/service.js";
import { CONFIG, deps, gateFor, git, repository, stopEvent, write } from "./fixture.js";

const SESSION = "session-one";

function manageDeps() {
  const base = deps();
  const result: FinishDependencies & { revoked: string[] } = {
    ...base,
    tasks: (root) => new TaskService(new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root))
  };
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function rejectsWith(code: string) {
  return (error: unknown) => error instanceof AgentOpsError && error.code === code;
}

async function attachTask(root: string, sessionId: string): Promise<string> {
  const tasks = new TaskService(new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root));
  const task = await tasks.create({
    title: "Work",
    criteria: [
      { id: "one", description: "One holds", verifierIds: ["node-test"] },
      { id: "two", description: "Two holds", verifierIds: ["node-test"] }
    ]
  });
  await tasks.attach(sessionId, task.task.id);
  return task.task.id;
}

test("list reports each worktree's session, state, task and activity", async () => {
  const root = await repository();
  try {
    const d = manageDeps();
    const alpha = await addWorktree(d, { cwd: root, name: "alpha", sessionId: SESSION });
    const beta = await addWorktree(d, { cwd: root, name: "beta", sessionId: "session-two" });
    await write(alpha.record.path, "source.txt", "uncommitted\n");
    await write(beta.record.path, "beta.txt", "beta\n");
    await git(beta.record.path, "add", "beta.txt");
    await git(beta.record.path, "commit", "-qm", "beta");
    const taskId = await attachTask(beta.record.path, "session-two");

    const listed = await listWorktrees(d, alpha.record.path);

    assert.deepEqual(listed.map(({ record, dirty, ahead, taskStatus }) =>
      ({ name: record.name, session: record.sessionId, dirty, ahead, taskStatus })), [
      { name: "alpha", session: SESSION, dirty: true, ahead: 0, taskStatus: "none" },
      { name: "beta", session: "session-two", dirty: false, ahead: 1, taskStatus: `${taskId} active` }
    ]);
    for (const { lastActivity } of listed) assert.ok(Number.isFinite(Date.parse(lastActivity)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume hands the worktree, its task and its gate to a new session", async () => {
  const root = await repository();
  try {
    const d = manageDeps();
    const { record } = await addWorktree(d, { cwd: root, name: "alpha", sessionId: SESSION });
    const taskId = await attachTask(record.path, SESSION);

    const resumed = await resumeWorktree(d, { cwd: root, name: "alpha", sessionId: "session-new" });

    assert.equal(resumed.sessionId, "session-new");
    assert.equal((await readWorktreeRecord(record.path))?.sessionId, "session-new");
    const tasks = d.tasks(record.path);
    assert.equal((await tasks.status({ sessionId: "session-new" })).task.id, taskId);
    const main = new FileCompletionGateStore(root);
    assert.equal((await main.read(SESSION))?.root, undefined);
    assert.equal((await main.read("session-new"))?.root, record.path);
    assert.equal((await new FileCompletionGateStore(record.path).read("session-new"))?.baselineFingerprint, RESUMED_BASELINE);
    // Nothing changed since resume, yet the inherited worktree must be accounted for.
    assert.equal((await gateFor(root, CONFIG).handle(stopEvent("session-new")))?.code, "COMPLETION_GATE_TASK_INCOMPLETE");

    await assert.rejects(resumeWorktree(d, { cwd: root, name: "alpha", sessionId: undefined }), rejectsWith("WORKTREE_SESSION_REQUIRED"));
    await assert.rejects(resumeWorktree(d, { cwd: root, name: "gone", sessionId: "s" }), rejectsWith("WORKTREE_NOT_FOUND"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remove keeps unmerged work unless forced, and the gate asks before forcing", async () => {
  const root = await repository();
  try {
    const d = manageDeps();
    const clean = await addWorktree(d, { cwd: root, name: "clean", sessionId: "session-clean" });
    const removed = await removeWorktree(d, { cwd: root, name: "clean", force: false });
    assert.equal(removed.record.name, "clean");
    assert.equal(await exists(clean.record.path), false);
    assert.equal(await git(root, "branch", "--list", "agent-ops/clean"), "");
    assert.deepEqual(d.revoked, [clean.record.path]);
    assert.equal((await new FileCompletionGateStore(root).read("session-clean"))?.root, undefined);

    const dirty = await addWorktree(d, { cwd: root, name: "dirty", sessionId: SESSION });
    await write(dirty.record.path, "source.txt", "unsaved\n");
    await assert.rejects(removeWorktree(d, { cwd: root, name: "dirty", force: false }), rejectsWith("WORKTREE_UNMERGED"));
    const ahead = await addWorktree(d, { cwd: root, name: "ahead", sessionId: "session-ahead" });
    await write(ahead.record.path, "new.txt", "new\n");
    await git(ahead.record.path, "add", "new.txt");
    await git(ahead.record.path, "commit", "-qm", "unmerged");
    await assert.rejects(removeWorktree(d, { cwd: root, name: "ahead", force: false }), rejectsWith("WORKTREE_UNMERGED"));
    await removeWorktree(d, { cwd: root, name: "ahead", force: true });
    assert.equal(await exists(ahead.record.path), false);
    assert.equal(await git(root, "branch", "--list", "agent-ops/ahead"), "");

    const asked = await gateFor(root, CONFIG).handle({
      event: "command", projectRoot: root, sessionId: SESSION,
      command: "agent-ops", args: ["worktree", "remove", "dirty", "--force"], scope: "."
    });
    assert.equal(asked?.code, "WORKTREE_REMOVE_CONFIRMATION");
    const output = JSON.parse(claudeHookOutput("PreToolUse", asked!).stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    assert.equal(output.hookSpecificOutput.permissionDecision, "ask");
    assert.equal(await gateFor(root, CONFIG).handle({
      event: "command", projectRoot: root, sessionId: SESSION,
      command: "agent-ops", args: ["worktree", "remove", "dirty"], scope: "."
    }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor names worktrees idle for more than seven days", async () => {
  const now = Date.parse("2026-09-24T00:00:00Z");
  const status = (name: string, lastActivity: string): WorktreeStatus => ({
    record: {
      schemaVersion: 1, name, branch: `agent-ops/${name}`, path: `/r/.worktrees/${name}`, mainRoot: "/r",
      targetBranch: "main", base: "a".repeat(40), sessionId: "s", createdAt: lastActivity
    },
    dirty: false, ahead: 0, taskStatus: "none", lastActivity
  });
  const fresh = status("fresh", "2026-09-20T00:00:00Z");
  const stale = status("stale", "2026-09-10T00:00:00Z");
  assert.deepEqual(idleWorktrees([fresh, stale], now).map(({ record }) => record.name), ["stale"]);
  assert.equal(worktreeDoctorResult([fresh], now).status, "PASS");
  const degraded = worktreeDoctorResult([fresh, stale], now);
  assert.equal(degraded.status, "DEGRADED");
  assert.match(degraded.message, /stale/u);

  const root = await repository();
  try {
    const report = await doctorInstallation({ root, probes: { worktrees: () => degraded } });
    const check = report.checks.find(({ id }) => id === "worktrees");
    assert.equal(check?.status, "DEGRADED");
    assert.equal((await doctorInstallation({ root })).checks.some(({ id }) => id === "worktrees"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree list, resume and remove parse their own options", () => {
  assert.equal(parseArgs(["worktree", "list"]).action, "list");
  assert.equal(parseArgs(["worktree", "resume", "a", "--session", "s"]).sessionId, "s");
  assert.equal(parseArgs(["worktree", "remove", "a", "--force"]).force, true);
  for (const argv of [
    ["worktree", "list", "a"],
    ["worktree", "remove", "a", "--session", "s"],
    ["worktree", "finish", "a", "--force"],
    ["task", "status", "--force"]
  ]) {
    assert.throws(() => parseArgs(argv), argv.join(" "));
  }
});
