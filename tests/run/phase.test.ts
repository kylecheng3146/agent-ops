import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertRunState, createRunState, FileRunRepository, type RunState } from "../../runtime/src/run/service.js";
import { criteriaProgress, recordRunPhase, withRunPhase, withTaskProgress } from "../../runtime/src/run/phase.js";

function state(): RunState {
  const base = createRunState({root: "/repo", commonDir: "/repo/.git", targetBranch: "main", goal: "Show progress.",
    host: "claude", ownerSessionId: "session-phase", runId: "run-phase-test", now: "2026-10-07T00:00:00.000Z"});
  return {...base,
    tasks: [{taskId: "task-a", dependencies: [], status: "running", workerId: base.coordinatorId, deliveryDigest: null, sourceCommit: null, blockedReason: null}],
    workers: [{workerId: base.coordinatorId, taskId: "task-a", host: "claude", ownerSessionId: "session-phase", nativeSessionId: null,
      nativeJobId: null, worktree: "/repo/.worktrees/a", processId: null, processIdentity: null, generation: 1, status: "running",
      leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: "active", lastFailure: null}]};
}

test("run state written before phases existed still validates and has no phase", () => {
  const legacy = state();
  assert.doesNotThrow(() => assertRunState(JSON.parse(JSON.stringify(legacy))));
  assert.equal(legacy.phase, undefined);
  assert.equal(legacy.workers[0]!.phase, undefined);
  assert.equal(legacy.tasks[0]!.progress, undefined);
});

test("phase and progress are validated when present", () => {
  assert.throws(() => assertRunState({...state(), phase: "dreaming"}), /phase/u);
  const bad = withTaskProgress(state(), "task-a", {passed: 3, total: 2});
  assert.throws(() => assertRunState(bad), /progress/u);
  assert.throws(() => assertRunState(withTaskProgress(state(), "task-a", {verify: "MAYBE" as "PASS"})), /progress/u);
});

test("a worker transition moves the worker and the run, and progress merges", () => {
  const s = state();
  const moved = withRunPhase(s, s.coordinatorId, "verifying");
  assert.equal(moved.phase, "verifying");
  assert.equal(moved.workers[0]!.phase, "verifying");
  assert.equal(withRunPhase(s, "nobody", "verifying"), s);
  const verified = withTaskProgress(moved, "task-a", {verify: "PASS", passed: 2, total: 6});
  const reviewed = withTaskProgress(verified, "task-a", {review: "FAIL"});
  assert.deepEqual(reviewed.tasks[0]!.progress, {verify: "PASS", review: "FAIL", passed: 2, total: 6});
  assert.doesNotThrow(() => assertRunState(reviewed));
});

test("criteria progress counts command and typed acceptance criteria", () => {
  const criteria = [{id: "a"}, {id: "b", acceptance: {mode: "behavioral" as const, baselineCommit: "x", bindings: []}},
    {id: "c", acceptance: {mode: "behavioral" as const, baselineCommit: "x", bindings: []}}];
  assert.deepEqual(criteriaProgress(criteria, {results: [{status: "PASS"}],
    acceptance: [{criterionId: "b", status: "PASS"}, {criterionId: "c", status: "FAIL"}]}), {passed: 2, total: 3});
  assert.deepEqual(criteriaProgress(criteria, {results: [{status: "FAIL"}]}), {passed: 0, total: 3});
  assert.deepEqual(criteriaProgress([{id: "a"}], {}), {passed: 0, total: 1});
});

test("recorded phases persist, and a failed write never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-ops-phase-"));
  try {
    const repository = new FileRunRepository(join(dir, "runs"), dir);
    const s = state();
    await repository.create({...s, root: dir, commonDir: dir});
    await recordRunPhase(repository, s.runId, s.coordinatorId, "reviewing", {taskId: "task-a", update: {review: "PASS"}});
    const saved = (await repository.read(s.runId))!;
    assert.equal(saved.phase, "reviewing");
    assert.equal(saved.tasks[0]!.progress?.review, "PASS");
    await recordRunPhase(repository, "run-missing-x", s.coordinatorId, "reviewing");
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
