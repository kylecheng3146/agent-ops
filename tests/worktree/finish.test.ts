import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { currentGateFingerprint, FileCompletionGateStore } from "../../runtime/src/hooks/completion-gate.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { collectBaseChangePaths } from "../../runtime/src/verify/change-surface.js";
import { buildVerificationEvidence, FileEvidenceStore } from "../../runtime/src/verify/evidence.js";
import { calculateSourceFingerprint } from "../../runtime/src/verify/source-fingerprint.js";
import type {
  ProcessCompletion,
  RunningVerificationProcess,
  VerificationProcessRunner
} from "../../runtime/src/verify/spawn.js";
import {
  finishWorktree,
  WorktreeConflictError,
  type FinishDependencies
} from "../../runtime/src/parallel/finish.js";
import { addWorktree, type WorktreeRecord } from "../../runtime/src/parallel/service.js";
import { saveFixtureReviewAttestation } from "../review/attestation-fixture.js";
import { CONFIG, deps, gateFor, git, gitRunner, loadConfig as loadFixtureConfig, repository, stopEvent, write } from "./fixture.js";

const SESSION = "session-one";

class ExitRunner implements VerificationProcessRunner {
  calls = 0;
  constructor(readonly exitCode: number) {}
  start(): RunningVerificationProcess {
    this.calls += 1;
    const completion: ProcessCompletion = { exitCode: this.exitCode, signal: null };
    return {
      pid: 1,
      stdout: (async function* () { /* no output */ })(),
      stderr: (async function* () { /* no output */ })(),
      completion: Promise.resolve(completion),
      terminateTree: async () => undefined
    };
  }
}

function finishDeps(options: { readonly exitCode?: number; readonly sleep?: (ms: number) => Promise<void>; readonly lockWaitMs?: number } = {}) {
  const base = deps();
  const processRunner = new ExitRunner(options.exitCode ?? 0);
  const result: FinishDependencies & { granted: string[]; revoked: string[]; processRunner: ExitRunner } = {
    ...base,
    tasks: (root, completionBase) => new TaskService(
      new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root),
      completionBase === undefined ? {} : { completion: {
        root, gitRunner: gitRunner(root), base: completionBase, loadConfig: async () => loadFixtureConfig(root)
      } }
    ),
    processRunner,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.lockWaitMs === undefined ? {} : { lockWaitMs: options.lockWaitMs })
  };
  return result;
}

/** Commits `content` in the worktree and completes a reviewed task for it. */
async function completeWork(record: WorktreeRecord, file: string, content: string, config: AgentOpsConfig = CONFIG): Promise<string> {
  await write(record.path, file, content);
  await git(record.path, "add", file);
  await git(record.path, "commit", "-qm", `work on ${file}`);
  const runner = gitRunner(record.path);
  const base = record.base;
  const tasks = new TaskService(
    new FileTaskStore(join(record.path, ".agent-ops", "tasks", "state.json"), record.path),
    { completion: { root: record.path, gitRunner: runner, loadConfig: async () => config, base } }
  );
  const fingerprint = await calculateSourceFingerprint(record.path, {
    mode: "base", baseRef: base, resolvedBase: base,
    changedFiles: await collectBaseChangePaths(runner, base)
  }, runner);
  const task = await tasks.create({
    title: `Change ${file}`,
    criteria: [
      { id: "behavior", description: "The behavior holds", verifierIds: ["node-test"] },
      { id: "regression", description: "Nothing else broke", verifierIds: ["node-test"] }
    ],
    policyConfigHash: calculateConfigHash(config)
  });
  await tasks.attach(record.sessionId, task.task.id);
  const evidence = new FileEvidenceStore(record.path, record.path);
  const references: Record<string, string[]> = {};
  for (const criterion of task.task.criteria) {
    references[criterion.id] = [await evidence.save(buildVerificationEvidence({
      taskId: task.task.id, criterionId: criterion.id, command: config.verification.commands[0]!,
      scope: "project", startedAt: "2026-09-24T00:00:00Z", finishedAt: "2026-09-24T00:00:01Z",
      exitCode: 0, testCount: 1, status: "PASS", failureClass: "none",
      sourceFingerprint: fingerprint, toolVersions: {}, config
    }))];
  }
  await saveFixtureReviewAttestation(record.path, fingerprint, task.task.id);
  await tasks.complete(task.task.id, references);
  return task.task.id;
}

/**
 * A task verified and (unless `reviewed` is false) reviewed over `base..HEAD`
 * in the worktree, left active for `worktree finish` to complete. `reviewBase`
 * records the base the way a PASS review does; omitted, finish falls back to
 * the worktree's own base.
 */
async function reviewedTask(record: WorktreeRecord, options: {
  readonly title: string;
  readonly base: string;
  readonly parentTaskId?: string;
  readonly reviewBase?: boolean;
  readonly reviewed?: boolean;
}): Promise<string> {
  const runner = gitRunner(record.path);
  const tasks = new TaskService(new FileTaskStore(join(record.path, ".agent-ops", "tasks", "state.json"), record.path));
  const fingerprint = await calculateSourceFingerprint(record.path, {
    mode: "base", baseRef: options.base, resolvedBase: options.base,
    changedFiles: await collectBaseChangePaths(runner, options.base)
  }, runner);
  const task = await tasks.create({
    title: options.title,
    criteria: [
      { id: "behavior", description: `${options.title} holds`, verifierIds: ["node-test"] },
      { id: "regression", description: "Nothing else broke", verifierIds: ["node-test"] }
    ],
    policyConfigHash: calculateConfigHash(CONFIG),
    ...(options.parentTaskId === undefined ? {} : { parentTaskId: options.parentTaskId }),
    sessionId: record.sessionId
  });
  const evidence = new FileEvidenceStore(record.path, record.path);
  const references: Record<string, string[]> = {};
  for (const criterion of task.task.criteria) {
    references[criterion.id] = [await evidence.save(buildVerificationEvidence({
      taskId: task.task.id, criterionId: criterion.id, command: CONFIG.verification.commands[0]!,
      scope: "project", startedAt: "2026-09-24T00:00:00Z", finishedAt: "2026-09-24T00:00:01Z",
      exitCode: 0, testCount: 1, status: "PASS", failureClass: "none",
      sourceFingerprint: fingerprint, toolVersions: {}, config: CONFIG
    }))];
  }
  if (options.reviewed !== false) {
    await saveFixtureReviewAttestation(record.path, fingerprint, task.task.id);
  }
  await tasks.recordEvidence(task.task.id, references, options.reviewBase === true ? options.base : undefined);
  return task.task.id;
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

async function numbered(root: string): Promise<void> {
  await write(root, "lines.txt", Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
  await git(root, "add", "lines.txt");
  await git(root, "commit", "-qm", "lines");
}

function replaceLine(source: string, line: number, value: string): string {
  return source.split("\n").map((text, index) => index === line - 1 ? value : text).join("\n");
}

test("finish fast-forwards, records the task in notes and retires the worktree", async () => {
  const root = await repository();
  try {
    const d = finishDeps();
    const { record } = await addWorktree(d, { cwd: root, name: "alpha", sessionId: SESSION });
    const idle = gateFor(root, CONFIG);
    await idle.seed("idle-session");
    const taskId = await completeWork(record, "source.txt", "alpha work\n");
    const head = await git(record.path, "rev-parse", "HEAD");

    const result = await finishWorktree(d, { cwd: root, name: "alpha" });

    assert.equal(result.rebased, false);
    assert.equal(result.mergedHead, head);
    assert.deepEqual(result.warnings, []);
    assert.equal(await git(root, "rev-parse", "main"), head);
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), "alpha work\n");
    const note = await git(root, "notes", "--ref=agent-ops", "show", head);
    assert.match(note, new RegExp(`^agent-ops task ${taskId}: Change source.txt$`, "mu"));
    assert.match(note, /^- behavior: The behavior holds$/mu);
    assert.equal(await exists(record.path), false);
    assert.equal(await git(root, "branch", "--list", "agent-ops/alpha"), "");
    assert.deepEqual(d.revoked, [record.path]);
    const store = new FileCompletionGateStore(root);
    const now = await currentGateFingerprint(root, gitRunner(root));
    assert.equal((await store.read(SESSION))?.root, undefined);
    assert.equal((await store.read(SESSION))?.baselineFingerprint, now);
    assert.equal((await store.read("idle-session"))?.baselineFingerprint, now);
    assert.equal((await gateFor(root, CONFIG).handle(stopEvent("idle-session")))?.code, "COMPLETION_GATE_ALLOWED");
    assert.equal((await gateFor(root, CONFIG).handle(stopEvent(SESSION)))?.code, "COMPLETION_GATE_ALLOWED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finish completes the worktree's whole task tree, subtasks first, and records it", async () => {
  const root = await repository();
  try {
    const d = finishDeps();
    const { record } = await addWorktree(d, { cwd: root, name: "alpha", sessionId: SESSION });
    await write(record.path, "source.txt", "parent work\n");
    await git(record.path, "add", "source.txt");
    await git(record.path, "commit", "-qm", "parent work");
    const middle = await git(record.path, "rev-parse", "HEAD");
    await write(record.path, "child.txt", "child work\n");
    await git(record.path, "add", "child.txt");
    await git(record.path, "commit", "-qm", "child work");
    // The parent has no recorded base, so finish falls back to the worktree's;
    // the subtask was reviewed over its own, narrower range.
    const parent = await reviewedTask(record, { title: "Parent", base: record.base });
    const child = await reviewedTask(record, { title: "Child", base: middle, parentTaskId: parent, reviewBase: true });
    const head = await git(record.path, "rev-parse", "HEAD");

    const result = await finishWorktree(d, { cwd: root, name: "alpha" });

    assert.deepEqual(result.taskIds, [parent, child]);
    assert.equal(await git(root, "rev-parse", "main"), head);
    const note = await git(root, "notes", "--ref=agent-ops", "show", head);
    assert.match(note, new RegExp(`^agent-ops task ${parent}: Parent$`, "mu"));
    assert.match(note, /^- behavior: Parent holds$/mu);
    assert.match(note, new RegExp(`^  agent-ops task ${child}: Child$`, "mu"));
    assert.match(note, /^ {2}- behavior: Child holds$/mu);
    assert.ok(note.indexOf(parent) < note.indexOf(child), note);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finish merges nothing when a task in the worktree cannot complete", async () => {
  const root = await repository();
  try {
    const d = finishDeps();
    const { record } = await addWorktree(d, { cwd: root, name: "alpha", sessionId: SESSION });
    await write(record.path, "source.txt", "work\n");
    await git(record.path, "add", "source.txt");
    await git(record.path, "commit", "-qm", "work");
    const parent = await reviewedTask(record, { title: "Parent", base: record.base });
    const child = await reviewedTask(record, { title: "Child", base: record.base, parentTaskId: parent, reviewed: false });
    const main = await git(root, "rev-parse", "main");

    await assert.rejects(finishWorktree(d, { cwd: root, name: "alpha" }), (error: unknown) =>
      rejectsWith("WORKTREE_TASK_INCOMPLETE")(error) &&
      (error as Error).message.includes(`Task ${child} (Child) could not be completed against ${record.base}`) &&
      /agent-ops review --task/u.test((error as Error).message));

    assert.equal(await git(root, "rev-parse", "main"), main);
    assert.equal(await exists(record.path), true);
    const tasks = d.tasks(record.path);
    assert.equal((await tasks.status({ taskId: child })).status, "active");
    assert.equal((await tasks.status({ taskId: parent })).status, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finish changes nothing unless the main checkout, worktree and task are all ready", async () => {
  const root = await repository();
  try {
    const d = finishDeps();
    const { record } = await addWorktree(d, { cwd: root, name: "alpha", sessionId: SESSION });
    const mainHead = await git(root, "rev-parse", "HEAD");

    await assert.rejects(finishWorktree(d, { cwd: root, name: "alpha" }), rejectsWith("WORKTREE_NOTHING_TO_MERGE"));

    await write(record.path, "source.txt", "uncommitted\n");
    await assert.rejects(finishWorktree(d, { cwd: root, name: "alpha" }), rejectsWith("WORKTREE_DIRTY"));
    await git(record.path, "commit", "-qam", "unreviewed");
    await assert.rejects(finishWorktree(d, { cwd: root, name: "alpha" }), rejectsWith("WORKTREE_TASK_INCOMPLETE"));

    await completeWork(record, "source.txt", "reviewed\n");
    // A commit after completion leaves the evidence describing another source.
    await write(record.path, "source.txt", "after review\n");
    await git(record.path, "commit", "-qam", "after review");
    await assert.rejects(finishWorktree(d, { cwd: root, name: "alpha" }), rejectsWith("WORKTREE_TASK_INCOMPLETE"));
    await git(record.path, "reset", "-q", "--hard", "HEAD~1");

    await write(root, "stray.txt", "main edit\n");
    await assert.rejects(finishWorktree(d, { cwd: root, name: "alpha" }), rejectsWith("WORKTREE_MAIN_DIRTY"));
    await rm(join(root, "stray.txt"));

    await git(root, "checkout", "-qb", "elsewhere");
    await assert.rejects(finishWorktree(d, { cwd: root, name: "alpha" }), rejectsWith("WORKTREE_TARGET_MOVED"));
    await git(root, "checkout", "-q", "main");

    await assert.rejects(finishWorktree(d, { cwd: record.path, name: "alpha" }), rejectsWith("WORKTREE_NESTED"));
    await assert.rejects(finishWorktree(d, { cwd: root, name: "missing" }), rejectsWith("WORKTREE_NOT_FOUND"));
    assert.equal(await git(root, "rev-parse", "main"), mainHead);
    assert.equal(await exists(record.path), true);

    await finishWorktree(d, { cwd: root, name: "alpha" });
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), "reviewed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a moved target is rebased, re-verified and fast-forwarded", async () => {
  const root = await repository();
  try {
    await numbered(root);
    const d = finishDeps();
    const { record } = await addWorktree(d, { cwd: root, name: "alpha", sessionId: SESSION });
    await completeWork(record, "source.txt", "alpha work\n");
    await write(root, "other.txt", "landed first\n");
    await git(root, "add", "other.txt");
    await git(root, "commit", "-qm", "another task landed");

    const result = await finishWorktree(d, { cwd: root, name: "alpha" });

    assert.equal(result.rebased, true);
    assert.equal(d.processRunner.calls, 1);
    assert.equal(await readFile(join(root, "source.txt"), "utf8"), "alpha work\n");
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "landed first\n");
    assert.equal(await git(root, "rev-list", "--count", "HEAD"), "4");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing re-verification or a changed patch resets the branch", async () => {
  const failing = await repository();
  const changed = await repository();
  try {
    await numbered(failing);
    const bad = finishDeps({ exitCode: 1 });
    const one = await addWorktree(bad, { cwd: failing, name: "alpha", sessionId: SESSION });
    await completeWork(one.record, "source.txt", "alpha work\n");
    const head = await git(one.record.path, "rev-parse", "HEAD");
    await write(failing, "other.txt", "landed first\n");
    await git(failing, "add", "other.txt");
    await git(failing, "commit", "-qm", "another task landed");
    const mainHead = await git(failing, "rev-parse", "HEAD");
    await assert.rejects(finishWorktree(bad, { cwd: failing, name: "alpha" }), rejectsWith("WORKTREE_REVERIFY_FAILED"));
    assert.equal(await git(one.record.path, "rev-parse", "HEAD"), head);
    assert.equal(await git(failing, "rev-parse", "HEAD"), mainHead);

    // The target edits line 7 and the work line 5: no conflict, but the
    // work's own diff now carries different context than was reviewed.
    await numbered(changed);
    const d = finishDeps();
    const two = await addWorktree(d, { cwd: changed, name: "alpha", sessionId: SESSION });
    const lines = await readFile(join(changed, "lines.txt"), "utf8");
    await completeWork(two.record, "lines.txt", replaceLine(lines, 5, "work five"));
    const workHead = await git(two.record.path, "rev-parse", "HEAD");
    await write(changed, "lines.txt", replaceLine(lines, 7, "target seven"));
    await git(changed, "commit", "-qam", "target edits nearby");
    await assert.rejects(finishWorktree(d, { cwd: changed, name: "alpha" }), rejectsWith("WORKTREE_REBASE_CHANGED"));
    assert.equal(await git(two.record.path, "rev-parse", "HEAD"), workHead);
    assert.equal(d.processRunner.calls, 0);
  } finally {
    await rm(failing, { recursive: true, force: true });
    await rm(changed, { recursive: true, force: true });
  }
});

test("a conflict aborts the rebase and reports the files and the target's intent", async () => {
  const root = await repository();
  try {
    const d = finishDeps();
    const { record } = await addWorktree(d, { cwd: root, name: "alpha", sessionId: SESSION });
    await completeWork(record, "source.txt", "alpha version\n");
    const head = await git(record.path, "rev-parse", "HEAD");
    await write(root, "source.txt", "beta version\n");
    await git(root, "commit", "-qam", "beta landed");
    await git(root, "notes", "--ref=agent-ops", "add", "-m", "agent-ops task task-beta: Beta wording", "HEAD");

    const error = await finishWorktree(d, { cwd: root, name: "alpha" }).then(
      () => assert.fail("finish should conflict"),
      (caught: unknown) => caught
    );
    assert.ok(error instanceof WorktreeConflictError);
    assert.deepEqual(error.files, ["source.txt"]);
    assert.equal(error.intents.length, 1);
    assert.match(error.intents[0]?.note ?? "", /task-beta: Beta wording/u);
    assert.match(error.message, /One attempt only/u);
    assert.equal(await git(record.path, "rev-parse", "HEAD"), head);
    assert.equal(await git(record.path, "status", "--porcelain"), "");
    assert.equal(await exists(join(root, ".git", "agent-ops-finish.lock")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finish waits for a live lock, reclaims a dead one and gives up when told to", async () => {
  const root = await repository();
  try {
    const lock = join(root, ".git", "agent-ops-finish.lock");
    const hold = async (pid: number) => {
      await mkdir(lock, { recursive: true });
      await writeFile(join(lock, "owner.json"), JSON.stringify({ pid, at: Date.now() }));
    };
    const setupWork = async (name: string, d: FinishDependencies) => {
      const { record } = await addWorktree(d, { cwd: root, name, sessionId: `session-${name}` });
      await completeWork(record, `${name}.txt`, `${name}\n`);
    };

    const busy = finishDeps({ lockWaitMs: 0 });
    await setupWork("alpha", busy);
    await hold(process.pid);
    await assert.rejects(finishWorktree(busy, { cwd: root, name: "alpha" }), rejectsWith("WORKTREE_FINISH_BUSY"));

    let slept = 0;
    const waiting = finishDeps({ sleep: async () => { slept += 1; await rm(lock, { recursive: true, force: true }); } });
    await finishWorktree(waiting, { cwd: root, name: "alpha" });
    assert.equal(slept, 1);

    const dead = finishDeps({ lockWaitMs: 0 });
    await setupWork("beta", dead);
    await hold(2_147_483_646);
    await finishWorktree(dead, { cwd: root, name: "beta" });
    assert.equal(await exists(lock), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
