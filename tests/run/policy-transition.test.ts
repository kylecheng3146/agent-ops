import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {AgentOpsError} from "../../runtime/src/fs/paths.js";
import {
  beginPolicyTransition,
  completePolicyTransition,
  currentPolicyArtifact,
  discoverPendingPolicyTransition,
  markPolicyTransitionStage,
  policyTransitionAllowsRestart,
  policyTransitionBlocksWorker,
  readPolicyTransition,
  type PolicyTransitionArtifactRef,
  type PolicyTransitionJournal
} from "../../runtime/src/run/policy-transition.js";
import {FileRunRepository, createRunState, type RunState} from "../../runtime/src/run/service.js";

const OLD_POLICY = {
  configHash: "a".repeat(64),
  runtimeHash: "b".repeat(64),
  artifactDigest: "c".repeat(64),
  expiresAt: "2026-10-06T00:00:00.000Z"
};
const NEW_POLICY = {
  configHash: "d".repeat(64),
  runtimeHash: "b".repeat(64),
  artifactDigest: "e".repeat(64),
  expiresAt: "2026-10-07T00:00:00.000Z"
};
const CONTRACT = "f".repeat(64);
const NEW_CONTRACT = "1".repeat(64);
const COMMIT = "2".repeat(40);

type PolicyState = RunState & {readonly policyBinding?: typeof OLD_POLICY};

function artifactFor(state: RunState): PolicyTransitionArtifactRef {
  const artifact = currentPolicyArtifact(state);
  assert.ok(artifact);
  return artifact;
}

async function fixture(): Promise<{
  readonly root: string;
  readonly repository: FileRunRepository;
  readonly state: PolicyState;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-policy-transition-"));
  const repository = new FileRunRepository(join(root, "runs"), root);
  const state = createRunState({
    root,
    commonDir: root,
    targetBranch: "main",
    goal: "Synchronize the run policy safely.",
    host: "codex",
    ownerSessionId: "policy-owner",
    runId: "run-policy-transition",
    contractHash: CONTRACT,
    now: "2026-10-05T00:00:00.000Z"
  });
  const saved: PolicyState = {
    ...state,
    tasks: [
      {taskId: "task-a", dependencies: [], planDigest: "3".repeat(64), status: "running", workerId: "worker-a", deliveryDigest: null, sourceCommit: null, blockedReason: null},
      {taskId: "task-b", dependencies: [], planDigest: "4".repeat(64), status: "delivered", workerId: "worker-b", deliveryDigest: "5".repeat(64), sourceCommit: COMMIT, blockedReason: null}
    ],
    workers: [
      {workerId: "worker-a", taskId: "task-a", host: "codex", ownerSessionId: "policy-owner", nativeSessionId: "native-a", nativeJobId: "job-a", worktree: null,
        processId: null, processIdentity: null, generation: 3, status: "running", leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: "active", lastFailure: null},
      {workerId: "worker-b", taskId: "task-b", host: "codex", ownerSessionId: "policy-owner", nativeSessionId: null, nativeJobId: null, worktree: null,
        processId: null, processIdentity: null, generation: 4, status: "delivered", leaseExpiresAt: null, heartbeatAt: null,
        stopIntent: {runId: state.runId, workerId: "worker-b", generation: 4, nativeSessionId: null, reason: "handoff", deliveryDigest: "5".repeat(64), contractDigest: CONTRACT,
          sourceCommit: COMMIT, expiresAt: "2026-10-05T00:00:01.000Z", confirmedDeadAt: "2026-10-05T00:00:02.000Z"}, nativeGoalState: "inactive", lastFailure: null}
    ],
    policyBinding: OLD_POLICY
  };
  await repository.create(saved);
  return {root, repository, state: saved};
}

async function stopWorker(repository: FileRunRepository, runId: string): Promise<void> {
  await repository.mutate(runId, current => ({
    ...current,
    workers: current.workers.map(worker => worker.workerId === "worker-a" ? {
      ...worker,
      status: "stopped" as const,
      nativeGoalState: "inactive" as const,
      stopIntent: {
        runId,
        workerId: worker.workerId,
        generation: worker.generation,
        nativeSessionId: worker.nativeSessionId,
        reason: "stop" as const,
        deliveryDigest: "0".repeat(64),
        contractDigest: CONTRACT,
        sourceCommit: "0".repeat(40),
        expiresAt: "2026-10-05T00:00:10.000Z",
        confirmedDeadAt: "2026-10-05T00:00:03.000Z"
      }
    } : worker)
  }));
}

async function bindNewPolicy(repository: FileRunRepository, runId: string): Promise<void> {
  await repository.mutate(runId, current => ({...current, policyBinding: NEW_POLICY} as PolicyState));
}

test("policy transition journals fencing, binding, synchronization and historical delivery", async () => {
  const f = await fixture();
  try {
    const prepared = await beginPolicyTransition(f.repository, f.state.runId, {transitionId: "policy-transition-test", now: "2026-10-05T00:00:03.000Z"});
    assert.equal(prepared.stages.at(-1)?.stage, "prepared");
    assert.equal(prepared.oldPolicyArtifact?.artifactDigest, OLD_POLICY.artifactDigest);
    assert.deepEqual(prepared.resumeIds, [{workerId: "worker-a", generation: 3, nativeSessionId: "native-a", nativeJobId: "job-a"}]);
    assert.deepEqual(prepared.deliveredMarkers, [{workerId: "worker-b", taskId: "task-b", generation: 4, deliveryDigest: "5".repeat(64), sourceCommit: COMMIT}]);
    assert.equal(policyTransitionBlocksWorker(prepared, "worker-a", 3), true);

    await assert.rejects(
      completePolicyTransition(f.repository, f.state.runId, prepared.transitionId),
      (cause: unknown) => cause instanceof AgentOpsError && cause.code === "RUN_POLICY_TRANSITION_SYNC_REQUIRED"
    );
    await stopWorker(f.repository, f.state.runId);
    const fenced = await markPolicyTransitionStage(f.repository, f.state.runId, prepared.transitionId, {stage: "fenced", now: "2026-10-05T00:00:04.000Z"});
    assert.equal(fenced.stages.at(-1)?.stage, "fenced");

    await bindNewPolicy(f.repository, f.state.runId);
    const boundState = await f.repository.read(f.state.runId);
    assert.ok(boundState);
    const bound = await markPolicyTransitionStage(f.repository, f.state.runId, prepared.transitionId, {
      stage: "bound", newPolicyArtifact: artifactFor(boundState), now: "2026-10-05T00:00:05.000Z"
    });
    assert.equal(bound.newPolicyArtifact?.artifactDigest, NEW_POLICY.artifactDigest);

    await f.repository.mutate(f.state.runId, current => ({...current, currentContractHash: NEW_CONTRACT, contractRevision: 1}));
    const synchronized = await markPolicyTransitionStage(f.repository, f.state.runId, prepared.transitionId, {
      stage: "synchronized", contractHash: NEW_CONTRACT, contractRevision: 1,
      taskIds: ["task-a", "task-b"], now: "2026-10-05T00:00:06.000Z"
    });
    assert.equal(synchronized.stages.at(-1)?.stage, "synchronized");
    assert.equal(synchronized.stages.at(-1)?.synchronizationDigest?.length, 64);
    const complete = await completePolicyTransition(f.repository, f.state.runId, prepared.transitionId, {now: "2026-10-05T00:00:07.000Z"});
    assert.equal(complete.stages.at(-1)?.stage, "complete");
    assert.equal(policyTransitionAllowsRestart(complete), true);
    assert.equal(policyTransitionBlocksWorker(complete, "worker-a", 3), false);

    const saved = await f.repository.read(f.state.runId);
    assert.ok(saved);
    assert.equal(saved.workers.find(worker => worker.workerId === "worker-b")?.status, "delivered");
    assert.equal(saved.tasks.find(task => task.taskId === "task-b")?.deliveryDigest, "5".repeat(64));
    assert.deepEqual(saved.events.filter(event => event.code.startsWith("RUN_POLICY_TRANSITION_")).map(event => event.code), [
      "RUN_POLICY_TRANSITION_PREPARED",
      "RUN_POLICY_TRANSITION_FENCED",
      "RUN_POLICY_TRANSITION_BOUND",
      "RUN_POLICY_TRANSITION_SYNCHRONIZED",
      "RUN_POLICY_TRANSITION_COMPLETE"
    ]);
    assert.deepEqual((await readPolicyTransition(f.repository, f.state.runId, prepared.transitionId))?.stages.map(stage => stage.stage), [
      "prepared", "fenced", "bound", "synchronized", "complete"
    ]);
  } finally {
    await rm(f.root, {recursive: true, force: true});
  }
});

test("pending journal recovery is visible after a crash and rejects unsafe stage changes", async () => {
  const f = await fixture();
  try {
    const prepared = await beginPolicyTransition(f.repository, f.state.runId, {transitionId: "policy-transition-recovery", now: "2026-10-05T01:00:00.000Z"});
    await f.repository.mutate(f.state.runId, current => ({...current, events: []}));
    const recovered = await discoverPendingPolicyTransition(f.repository, f.state.runId);
    assert.equal(recovered?.transitionId, prepared.transitionId);
    assert.equal(policyTransitionAllowsRestart(recovered!), false);
    assert.equal(policyTransitionBlocksWorker(recovered!, "worker-a", 99), true, "a replacement generation is blocked before complete");

    await assert.rejects(
      markPolicyTransitionStage(f.repository, f.state.runId, prepared.transitionId, {stage: "bound", newPolicyArtifact: prepared.oldPolicyArtifact ?? undefined}),
      (cause: unknown) => cause instanceof AgentOpsError && cause.code === "RUN_POLICY_TRANSITION_STAGE_ORDER"
    );
    await assert.rejects(
      markPolicyTransitionStage(f.repository, f.state.runId, prepared.transitionId, {stage: "fenced", now: "2026-10-05T01:00:01.000Z"}),
      (cause: unknown) => cause instanceof AgentOpsError && cause.code === "RUN_POLICY_TRANSITION_FENCE_REQUIRED"
    );
    await stopWorker(f.repository, f.state.runId);
    const fenced = await markPolicyTransitionStage(f.repository, f.state.runId, prepared.transitionId, {stage: "fenced", now: "2026-10-05T01:00:02.000Z"});
    assert.equal(fenced.stages.at(-1)?.stage, "fenced");
    const repaired = await discoverPendingPolicyTransition(f.repository, f.state.runId);
    assert.ok(repaired);
    assert.equal((await f.repository.read(f.state.runId))?.events.some(event => event.code === "RUN_POLICY_TRANSITION_FENCED"), true);
  } finally {
    await rm(f.root, {recursive: true, force: true});
  }
});

test("legacy runs can record a fence snapshot without inventing an old policy", async () => {
  const f = await fixture();
  try {
    await f.repository.mutate(f.state.runId, current => {
      const {policyBinding: _policyBinding, ...legacy} = current as PolicyState;
      return legacy;
    });
    const prepared = await beginPolicyTransition(f.repository, f.state.runId, {transitionId: "policy-transition-legacy", now: "2026-10-05T02:00:00.000Z"});
    assert.equal(prepared.oldPolicyArtifact, null);
    await stopWorker(f.repository, f.state.runId);
    const fenced = await markPolicyTransitionStage(f.repository, f.state.runId, prepared.transitionId, {stage: "fenced", now: "2026-10-05T02:00:01.000Z"});
    assert.equal(fenced.oldPolicyArtifact, null);
    assert.equal(fenced.newPolicyArtifact, null);
  } finally {
    await rm(f.root, {recursive: true, force: true});
  }
});
