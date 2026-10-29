import assert from "node:assert/strict";
import { access, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { runAdvanceCommand, type AdvanceStep } from "../../packages/cli/src/commands/advance.js";
import { runRunCommand, type RunCommandService } from "../../packages/cli/src/commands/run.js";
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import type { FinishDependencies } from "../../runtime/src/parallel/finish.js";
import { listWorktrees } from "../../runtime/src/parallel/manage.js";
import { addWorktree, sessionWorktreeName, type WorktreeRecord } from "../../runtime/src/parallel/service.js";
import { assertLandable, landingSessionId, landRun } from "../../runtime/src/run/land.js";
import {
  createRunState, FileRunRepository, RunService, type RunState, type RunTaskNode, type RunWorkerRecord
} from "../../runtime/src/run/service.js";
import { reviewReportDigest, saveReviewAttestation, saveReviewReportArtifact } from "../../runtime/src/review/attestation.js";
import type { ReviewRunResult } from "../../runtime/src/review/runner.js";
import { resolveReviewScope } from "../../runtime/src/review/scope.js";
import { taskContractHash } from "../../runtime/src/task/contract.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { collectBaseChangePaths } from "../../runtime/src/verify/change-surface.js";
import { buildVerificationEvidence, FileEvidenceStore } from "../../runtime/src/verify/evidence.js";
import { calculateSourceFingerprint } from "../../runtime/src/verify/source-fingerprint.js";
import { reportFor } from "../review/report-fixture.js";
import { CONFIG, deps, git, gitRunner, repository, write } from "../worktree/fixture.js";

const SESSION = "land-owner-session";
const criteria = [
  { id: "behavior", description: "Delivered behavior works", verifierIds: ["node-test"] },
  { id: "regression", description: "Existing behavior remains", verifierIds: ["node-test"] }
];

function service(root: string, base?: string): TaskService {
  return new TaskService(new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root),
    base === undefined ? {} : { completion: { root, gitRunner: gitRunner(root), base, loadConfig: async () => CONFIG } });
}

function finishDeps(): FinishDependencies {
  return { ...deps(), tasks: (root, base) => service(root, base) };
}

async function evidenceFor(cwd: string, taskId: string, base: string, ids: readonly string[],
  contractHash?: string): Promise<Record<string, string[]>> {
  const runner = gitRunner(cwd);
  const scope = { mode: "base" as const, baseRef: base, resolvedBase: base, changedFiles: await collectBaseChangePaths(runner, base) };
  const fingerprint = await calculateSourceFingerprint(cwd, scope, runner);
  const store = new FileEvidenceStore(cwd, cwd);
  const refs: Record<string, string[]> = {};
  for (const id of ids) refs[id] = [await store.save(buildVerificationEvidence({
    taskId, criterionId: id, command: CONFIG.verification.commands[0]!, scope: "project",
    startedAt: "2026-10-29T00:00:00.000Z", finishedAt: "2026-10-29T00:00:01.000Z",
    exitCode: 0, testCount: null, status: "PASS", failureClass: "none", sourceFingerprint: fingerprint,
    toolVersions: {}, config: CONFIG, ...(contractHash === undefined ? {} : { taskContractHash: contractHash })
  }))];
  return refs;
}

/** A worker's committed, locally verified delivery; returns its task id and head. */
async function deliver(record: WorktreeRecord, file: string, content: string): Promise<{ taskId: string; head: string }> {
  const tasks = service(record.path);
  const task = await tasks.create({ title: `Deliver ${file}`, intent: `Add ${file} only.`, criteria,
    policyConfigHash: calculateConfigHash(CONFIG), sessionId: record.sessionId });
  await write(record.path, file, content);
  await git(record.path, "add", file);
  await git(record.path, "commit", "-qm", `deliver ${file}`);
  await tasks.recordEvidence(task.task.id, await evidenceFor(record.path, task.task.id, record.base, criteria.map(c => c.id)));
  return { taskId: task.task.id, head: await git(record.path, "rev-parse", "HEAD") };
}

/** verify records PASS evidence (or fails when told to); review attests the whole tree with two fresh sessions. */
function fixtureStep(options: { failVerify?: () => boolean } = {}): AdvanceStep {
  return async (cwd, args) => {
    const taskId = args[2]!;
    const base = args[args.indexOf("--base") + 1]!;
    const scope = await resolveReviewScope({ root: cwd, runner: gitRunner(cwd), base });
    const fingerprint = await calculateSourceFingerprint(cwd, scope, gitRunner(cwd));
    const tasks = service(cwd);
    if (args[0] === "verify") {
      if (options.failVerify?.() === true) return { code: "VERIFICATION_FAILED", status: "error", data: { report: { status: "FAIL" } } };
      const task = await tasks.status({ taskId });
      await tasks.recordEvidence(taskId, await evidenceFor(cwd, taskId, base, task.task.criteria.map(c => c.id), taskContractHash(task.task)));
      return { code: "VERIFICATION_PASSED", status: "ok", data: { report: { status: "PASS" } } };
    }
    const all = await tasks.list();
    const root = all.find(({ task }) => task.parentTaskId === undefined)!;
    const tree = { rootTaskId: root.task.id, taskIds: all.map(({ task }) => task.id),
      criterionIds: all.flatMap(({ task }) => task.criteria.map(({ id }) => `${task.id}:${id}`)) };
    const report = reportFor(tree.criterionIds.map(id => ({ id, description: id })), "PASS", scope.changedFiles);
    const result: ReviewRunResult = {
      status: "PASS", harness: "codex", model: "fixture", effort: "fixture", prompt: "fixture",
      plannedTargets: ["codex", "codex"], sourceFingerprint: fingerprint, sessionIsolation: "fresh",
      attempts: [{ target: "codex", status: "PASS", sessionId: "primary" }, { target: "codex", status: "PASS", sessionId: "adversarial" }],
      preflight: [], report, adversarial: { target: "codex", refuted: false, report }
    };
    const taskContracts = Object.fromEntries(all.map(({ task }) => [task.id, taskContractHash(task)]));
    const candidateCommit = await git(cwd, "rev-parse", "HEAD");
    for (const { task } of all) {
      const binding = { taskContractHash: taskContracts[task.id]!, taskContracts, goalHash: "e".repeat(64), candidateCommit, coverageDigest: "f".repeat(64) };
      const reportArtifact = await saveReviewReportArtifact(cwd, result, fingerprint, task.id, tree, binding);
      await saveReviewAttestation(cwd, { schemaVersion: 3, taskId: task.id, tree, harness: "codex", status: "PASS", ...binding,
        sourceFingerprint: fingerprint, reviewTargets: ["codex", "codex"], reviewSessionIds: ["primary", "adversarial"],
        sessionIsolation: "fresh", primaryReportDigest: reviewReportDigest(report),
        adversarialReportDigest: reviewReportDigest(report), reportArtifact, createdAt: "2026-10-29T00:00:02.000Z" });
    }
    return { code: "REVIEW_RESULT", status: "ok", data: { result: { status: "PASS" } } };
  };
}

interface Child { readonly name: string; readonly file?: string; readonly content?: string; readonly dependsOn?: string }
interface Fixture {
  readonly root: string;
  readonly d: FinishDependencies;
  readonly runs: FileRunRepository;
  readonly runId: string;
  readonly coordinator: WorktreeRecord;
  readonly rootTaskId: string;
  readonly children: Map<string, { record: WorktreeRecord; taskId: string; head: string | null }>;
}

function worker(workerId: string, taskId: string, worktree: string, status: RunWorkerRecord["status"]): RunWorkerRecord {
  return { workerId, taskId, host: "codex", ownerSessionId: SESSION, nativeSessionId: null, nativeJobId: null, worktree,
    processId: null, processIdentity: null, generation: 1, status, leaseExpiresAt: null, heartbeatAt: null, stopIntent: null,
    nativeGoalState: "inactive", lastFailure: null } as RunWorkerRecord;
}

/** A paused run: children with `file` are delivered (after merging their dependency), the rest blocked. */
async function pausedRun(children: readonly Child[]): Promise<Fixture> {
  const root = await repository();
  const d = finishDeps();
  const commonDir = await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const runs = new FileRunRepository(join(commonDir, "agent-ops", "runs"), commonDir);
  const run = createRunState({ root, commonDir, targetBranch: "main", goal: "Build A, B and C", host: "codex", ownerSessionId: SESSION });
  await runs.create(run);
  const ownership = (workerId: string) => ({ runId: run.runId, coordinatorId: run.coordinatorId, workerId, ownerSessionId: SESSION, generation: 1 });
  const coordinator = (await addWorktree(d, { cwd: root, name: sessionWorktreeName(SESSION), sessionId: SESSION,
    runOwnership: ownership(run.coordinatorId) })).record;
  const rootTask = await service(coordinator.path).create({ title: "Build A, B and C", goal: "Build A, B and C", criteria,
    policyConfigHash: calculateConfigHash(CONFIG), sessionId: SESSION });
  const made = new Map<string, { record: WorktreeRecord; taskId: string; head: string | null }>();
  for (const child of children) {
    const record = (await addWorktree(d, { cwd: root, name: `child-${child.name}`, sessionId: SESSION,
      agentId: `worker-${child.name}`, runOwnership: ownership(`worker-${child.name}`) })).record;
    if (child.dependsOn !== undefined) await git(record.path, "merge", "-q", "--no-edit", made.get(child.dependsOn)!.head!);
    if (child.file === undefined) {
      made.set(child.name, { record, taskId: `task-${child.name}-blocked`, head: null });
      continue;
    }
    const delivered = await deliver(record, child.file, child.content ?? `${child.name}\n`);
    made.set(child.name, { record, ...delivered });
  }
  await runs.mutate(run.runId, current => ({
    ...current, status: "paused", rootTaskId: rootTask.task.id,
    tasks: children.map((child): RunTaskNode => {
      const item = made.get(child.name)!;
      return { taskId: item.taskId, dependencies: child.dependsOn === undefined ? [] : [made.get(child.dependsOn)!.taskId],
        status: item.head === null ? "blocked" : "delivered", workerId: `worker-${child.name}`,
        deliveryDigest: item.head === null ? null : "d".repeat(64), sourceCommit: item.head, blockedReason: item.head === null ? "fixture" : null };
    }),
    workers: [worker(run.coordinatorId, rootTask.task.id, coordinator.path, "stopped"),
      ...children.map(child => worker(`worker-${child.name}`, made.get(child.name)!.taskId, made.get(child.name)!.record.path,
        made.get(child.name)!.head === null ? "blocked" : "delivered"))]
  }));
  return { root, d, runs, runId: run.runId, coordinator, rootTaskId: rootTask.task.id, children: made };
}

function land(f: Fixture, taskIds?: readonly string[], step: AdvanceStep = fixtureStep()) {
  return landRun({ repository: f.runs, runId: f.runId, deps: f.d, ...(taskIds === undefined ? {} : { taskIds }),
    advance: async input => {
      const result = await runAdvanceCommand({ ...input, deps: f.d, step });
      return { receipt: (result.data as { receipt: string }).receipt };
    } });
}

/** Checkouts of landing attempts for this run that are still on disk. */
const landings = async (f: Fixture) => (await listWorktrees(f.d, f.root)).filter(({ record }) => record.sessionId.endsWith(`-land-${f.runId}`)).length;
const exists = async (path: string) => await access(path).then(() => true, () => false);
const subjects = async (root: string) => (await git(root, "log", "main", "--format=%s")).split("\n");

async function unchanged(f: Fixture, action: () => Promise<unknown>, code: string): Promise<void> {
  const target = await git(f.root, "rev-parse", "main");
  const before = await f.runs.read(f.runId);
  await assert.rejects(action(), { code });
  assert.equal(await git(f.root, "rev-parse", "main"), target);
  const after = (await f.runs.read(f.runId))!;
  assert.deepEqual({ ...after, revision: 0, updatedAt: "" }, { ...before!, revision: 0, updatedAt: "" });
}

test("run land lands delivered A and B, keeps the run paused and resumable, and leaves child checkouts", async () => {
  const f = await pausedRun([{ name: "a", file: "a.txt" }, { name: "b", file: "b.txt" }, { name: "c" }]);
  try {
    const a = f.children.get("a")!, b = f.children.get("b")!;
    const fake = { land: async (runId: string, taskIds?: readonly string[]) => {
      assert.equal(runId, f.runId);
      return await land(f, taskIds);
    } } as unknown as RunCommandService;
    assert.throws(() => parseArgs(["run", "land", f.runId]), { code: "CLI_OPTION_NOT_ALLOWED" });
    const args = parseArgs(["run", "land", f.runId, "--yes"]);
    const envelope = await runRunCommand({ args, service: fake, root: f.root, commonDir: "", targetBranch: "main", ownerSessionId: SESSION });
    assert.equal(envelope.status, "ok", JSON.stringify(envelope.errors));
    assert.equal(envelope.code, "RUN_LANDED");
    const text = envelope.data!.text;
    for (const needle of [a.taskId, b.taskId, envelope.data!.receipt!, `agent-ops run resume ${f.runId}`]) assert.ok(text.includes(needle), needle);
    assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "a\n");
    assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "b\n");
    assert.deepEqual((await subjects(f.root)).filter(s => s.startsWith("deliver")).sort(), ["deliver a.txt", "deliver b.txt"]);
    const state = (await f.runs.read(f.runId))!;
    assert.equal(state.status, "paused");
    assert.deepEqual(state.tasks.map(t => t.status), ["delivered", "delivered", "blocked"]);
    assert.deepEqual(state.landings?.map(l => [...l.taskIds].sort()), [[a.taskId, b.taskId].sort()]);
    assert.equal(state.landings?.[0]?.receipt, envelope.data!.receipt);
    assert.equal(state.landing, null);
    assert.ok(state.events.some(e => e.code === "RUN_PARTIAL_LANDED"));
    assert.equal((await service(f.coordinator.path).status({ taskId: f.rootTaskId })).status, "active");
    assert.equal(await git(a.record.path, "rev-parse", "HEAD"), a.head);
    assert.equal(await git(b.record.path, "rev-parse", "HEAD"), b.head);
    assert.equal(await landings(f), 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("run land selects a subset only with its dependencies selected or already landed", async () => {
  const f = await pausedRun([{ name: "a", file: "a.txt" }, { name: "b", file: "b.txt", dependsOn: "a" }, { name: "c" }]);
  try {
    const a = f.children.get("a")!, b = f.children.get("b")!;
    await unchanged(f, () => land(f, [b.taskId]), "RUN_LAND_DEPENDENCY_OPEN");
    await unchanged(f, () => land(f, ["task-not-in-run"]), "RUN_LAND_TASK_INVALID");
    await unchanged(f, () => land(f, [f.children.get("c")!.taskId]), "RUN_LAND_TASK_INVALID");
    await land(f, [a.taskId]);
    assert.equal(await exists(join(f.root, "a.txt")), true);
    assert.equal(await exists(join(f.root, "b.txt")), false);
    await land(f, [b.taskId]);
    assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "b\n");
    assert.deepEqual((await f.runs.read(f.runId))!.landings?.map(l => l.taskIds), [[a.taskId], [b.taskId]]);
    await unchanged(f, () => land(f), "RUN_LAND_NOTHING");
  } finally { await rm(f.root, { recursive: true, force: true }); }
  const none = await pausedRun([{ name: "c" }]);
  try { await unchanged(none, () => land(none), "RUN_LAND_NOTHING"); }
  finally { await rm(none.root, { recursive: true, force: true }); }
});

test("run land needs a stopped run without live workers, and its marker excludes every restart", async () => {
  const f = await pausedRun([{ name: "a", file: "a.txt" }]);
  try {
    for (const status of ["active", "awaiting-input"] as const) {
      await f.runs.mutate(f.runId, s => ({ ...s, status }));
      await unchanged(f, () => land(f), "RUN_LAND_STATE_INVALID");
    }
    await f.runs.mutate(f.runId, s => ({ ...s, status: "paused", workers: s.workers.map(w => w.workerId === "worker-a" ? { ...w, status: "running" as const } : w) }));
    await unchanged(f, () => land(f), "RUN_LAND_STATE_INVALID");
    await f.runs.mutate(f.runId, s => ({ ...s, workers: s.workers.map(w => w.workerId === "worker-a" ? { ...w, status: "delivered" as const } : w) }));
    const stopped: RunState = (await f.runs.read(f.runId))!;
    for (const status of ["blocked", "budget-limited"] as const) assert.doesNotThrow(() => assertLandable({ ...stopped, status }));

    await f.runs.mutate(f.runId, s => ({ ...s, status: "awaiting-input",
      questions: [{ questionId: "q1", prompt: "Which?", askedAt: s.createdAt, answeredAt: null, answerDigest: null }],
      landing: { processId: process.pid, hostname: hostname(), startedAt: s.createdAt } }));
    const runs = new RunService(f.runs);
    await assert.rejects(runs.respond(f.runId, "q1", "This one"), { code: "RUN_LANDING_IN_PROGRESS" });
    await f.runs.mutate(f.runId, s => ({ ...s, status: "paused" }));
    await assert.rejects(runs.resume(f.runId), { code: "RUN_LANDING_IN_PROGRESS" });
    await unchanged(f, () => land(f), "RUN_LANDING_IN_PROGRESS");

    // A process that no longer exists cannot hold the run.
    await f.runs.mutate(f.runId, s => ({ ...s, landing: { processId: 99_999_999, hostname: hostname(), startedAt: s.createdAt } }));
    await land(f);
    assert.equal((await f.runs.read(f.runId))!.landing, null);
    assert.equal((await f.runs.read(f.runId))!.landings?.length, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("a failed landing leaves the target, clears the marker and keeps its worktree for the next land to rebuild", async () => {
  const conflict = await pausedRun([{ name: "a", file: "same.txt", content: "A\n" }, { name: "b", file: "same.txt", content: "B\n" }]);
  try {
    const target = await git(conflict.root, "rev-parse", "main");
    await assert.rejects(land(conflict), { code: "WORKTREE_INTEGRATION_CONFLICT" });
    assert.equal(await git(conflict.root, "rev-parse", "main"), target);
    const state = (await conflict.runs.read(conflict.runId))!;
    assert.equal(state.landing, null);
    assert.equal(state.landings, undefined);
    assert.equal(await landings(conflict), 1);
  } finally { await rm(conflict.root, { recursive: true, force: true }); }

  const f = await pausedRun([{ name: "a", file: "a.txt" }, { name: "b", file: "b.txt" }]);
  try {
    const target = await git(f.root, "rev-parse", "main");
    await assert.rejects(land(f, undefined, fixtureStep({ failVerify: () => true })), { code: "VERIFICATION_FAILED" });
    assert.equal(await git(f.root, "rev-parse", "main"), target);
    assert.equal((await f.runs.read(f.runId))!.landing, null);
    assert.equal((await f.runs.read(f.runId))!.landings, undefined);
    assert.equal(await landings(f), 1);
    await land(f);
    assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "a\n");
    assert.equal((await f.runs.read(f.runId))!.landings?.length, 1);
    assert.equal(await landings(f), 0, "the kept attempt was removed and the new one finished");
  } finally { await rm(f.root, { recursive: true, force: true }); }

  // A checkout that claims this run's landing session but carries no owner record of the run.
  const foreign = await pausedRun([{ name: "a", file: "a.txt" }]);
  try {
    const claimed = landingSessionId(foreign.runId);
    const occupied = (await addWorktree(foreign.d, { cwd: foreign.root,
      name: sessionWorktreeName(claimed), sessionId: claimed })).record;
    await assert.rejects(land(foreign), { code: "RUN_LAND_WORKTREE_FOREIGN" });
    assert.equal(await exists(occupied.path), true);
    assert.equal((await foreign.runs.read(foreign.runId))!.landing, null);
  } finally { await rm(foreign.root, { recursive: true, force: true }); }
});

test("after a partial landing the run resumes and finalizes with every delivery exactly once", async () => {
  const f = await pausedRun([{ name: "a", file: "a.txt" }, { name: "b", file: "b.txt" }, { name: "c" }]);
  try {
    await land(f);
    const resumed = await new RunService(f.runs).resume(f.runId);
    assert.equal(resumed.state.status, "active");
    const c = f.children.get("c")!;
    const delivered = await deliver(c.record, "c.txt", "c\n");
    await f.runs.mutate(f.runId, s => ({ ...s,
      tasks: s.tasks.map(t => t.taskId === c.taskId ? { ...t, taskId: delivered.taskId, status: "delivered" as const,
        sourceCommit: delivered.head, deliveryDigest: "d".repeat(64), blockedReason: null } : t),
      workers: s.workers.map(w => w.workerId === "worker-c" ? { ...w, taskId: delivered.taskId, status: "delivered" as const } : w) }));
    const result = await runAdvanceCommand({ cwd: f.root, sessionId: SESSION, parentTaskId: f.rootTaskId, deps: f.d, step: fixtureStep() });
    assert.equal(result.status, "ok");
    assert.equal(typeof (result.data as { receipt?: unknown }).receipt, "string");
    for (const file of ["a.txt", "b.txt", "c.txt"]) assert.equal(await readFile(join(f.root, file), "utf8"), `${file[0]}\n`);
    const delivers = (await subjects(f.root)).filter(s => s.startsWith("deliver")).sort();
    assert.deepEqual(delivers, ["deliver a.txt", "deliver b.txt", "deliver c.txt"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
