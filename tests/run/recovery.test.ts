import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createRunState, FileRunRepository, RunService} from "../../runtime/src/run/service.js";
import {RunSupervisor} from "../../runtime/src/run/supervisor.js";

test("explicit recovery keeps budget and stop lineage and never revives denied or stagnant work", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-run-recovery-"));
  try {
    const repository = new FileRunRepository(join(root, "runs"), root);
    const state = createRunState({root, commonDir: root, goal: "Fixed goal", host: "codex", targetBranch: "main", ownerSessionId: "owner"});
    await repository.create({...state, status: "blocked", disableRestart: true, budget: {...state.budget, activeIntervals: [{startMs: 0, endMs: 100}]},
      workers: [{workerId: "writer", taskId: "task", host: "codex", ownerSessionId: "owner", nativeSessionId: null, nativeJobId: null, worktree: null,
        processId: null, processIdentity: null, generation: 1, status: "blocked", leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: "inactive", lastFailure: null}]});
    const service = new RunService(repository);
    await repository.appendEvent(state.runId, {type: "diagnostic", code: "RUN_RECOVERY_DIRTY", workerId: "writer", taskId: "task", detail: "Preserved dirty checkout"});
    const resumed = (await service.resume(state.runId)).state;
    assert.equal(resumed.status, "active"); assert.equal(resumed.workers[0]!.status, "stopped");
    assert.equal(resumed.budget.limitMs, state.budget.limitMs); assert.deepEqual(resumed.budget.activeIntervals, [{startMs: 0, endMs: 100}]);
    assert.equal(resumed.goalHash, state.goalHash);
    assert.ok(resumed.events.some(e => e.code === "RUN_RECOVERY_DIRTY"));
    for (const code of ["RUN_COMMAND_DENIED", "RUN_NO_PROGRESS_REPEAT"]) {
      await repository.mutate(state.runId, s => ({...s, status: "blocked", disableRestart: true}));
      await repository.appendEvent(state.runId, {type: "diagnostic", code, workerId: "writer", taskId: "task", detail: "Explicit blocker"});
      await assert.rejects(service.resume(state.runId), {code: "RUN_NOT_RESUMABLE"});
    }
    await service.stop(state.runId);
    await assert.rejects(service.resume(state.runId), {code: "RUN_NOT_RESUMABLE"}, "Stop cannot turn an explicit denial into resumable permission");
    await repository.mutate(state.runId, s => ({...s, events: s.events.filter(e => e.code !== "RUN_COMMAND_DENIED")}));
    await repository.mutate(state.runId, s => ({...s, status: "paused", budget: {...s.budget, activeIntervals: [{startMs: 0, endMs: s.budget.limitMs}]}}));
    await assert.rejects(service.resume(state.runId), {code: "RUN_BUDGET_EXHAUSTED"});
    const supervisor = new RunSupervisor({repository, host: {host: "codex", start: async () => {throw new Error("Must not start");},
      inspect: async () => ({processAlive: false, processIdentity: null, nativeGoalState: "inactive", stateDigest: null}), resume: async () => {}, send: async () => {}, stop: async () => {}}});
    for (const status of ["blocked", "delivered"] as const) {
      await repository.mutate(state.runId, s => ({...s, workers: s.workers.map(w => ({...w, status}))}));
      assert.equal((await supervisor.stopWorker(state.runId, "writer", 1, "stop")).status, status,
        "reconciling process death must not turn a historical delivery or no-progress block into resumable work");
    }
  } finally {await rm(root, {recursive: true, force: true});}
});
