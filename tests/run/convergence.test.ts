import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compareFailureObservations,
  deriveFailureObservation,
  type VerificationReportForConvergence
} from "../../runtime/src/run/convergence.js";
import {
  assertRunState,
  createRunState,
  FileRunRepository,
  type RunPolicyBinding
} from "../../runtime/src/run/service.js";
import { RunScheduler } from "../../runtime/src/run/scheduler.js";
import { RunSupervisor, type NativeGoalHost } from "../../runtime/src/run/supervisor.js";

function report(
  commandStatus: "PASS" | "FAIL" = "FAIL",
  acceptanceStatus: "PASS" | "FAIL" = "FAIL"
): VerificationReportForConvergence {
  return {
    taskId: "task-convergence",
    status: commandStatus === "PASS" && acceptanceStatus === "PASS" ? "PASS" : "FAIL",
    results: [
      { commandId: "node-test", required: true, status: commandStatus, failureClass: commandStatus === "PASS" ? "none" : "assertion" },
      { commandId: "optional-check", required: false, status: "FAIL", failureClass: "diagnostic-only" }
    ],
    acceptance: [
      { criterionId: "criterion-behavior", runnerId: "acceptance", phase: "candidate", status: acceptanceStatus, failureClass: acceptanceStatus === "PASS" ? "none" : "assertion" }
    ]
  };
}

test("derives semantic failure identity and recognizes check or pin progress", () => {
  const first = deriveFailureObservation(report(), { pendingPinIds: ["a".repeat(64) + ":0"] });
  const sameWithNoise = deriveFailureObservation({
    ...report(),
    sourceFingerprint: "source-changed",
    durationMs: 99,
    taskFailureFingerprint: "raw-task-failure",
    diagnostic: "wording changed"
  } as unknown as VerificationReportForConvergence, { pendingPinIds: ["a".repeat(64) + ":0"] });
  assert.equal(first.failureKey, sameWithNoise.failureKey);
  assert.equal(first.progressDigest, sameWithNoise.progressDigest);

  const checked = deriveFailureObservation(report("PASS"), { pendingPinIds: ["a".repeat(64) + ":0"] });
  const checkedDelta = compareFailureObservations(first, checked);
  assert.equal(checkedDelta.usefulProgress, true);
  assert.equal(checkedDelta.sameFailure, false);

  const discharged = deriveFailureObservation(report(), { pendingPinIds: [] });
  const pinDelta = compareFailureObservations(first, discharged);
  assert.equal(pinDelta.usefulProgress, true);

  const otherCheck = deriveFailureObservation({
    ...report(),
    results: [{ commandId: "different-check", required: true, status: "FAIL", failureClass: "assertion" }]
  });
  assert.equal(compareFailureObservations(first, otherCheck).sameFailure, false);
});

test("normalizes acceptance checks while preserving candidate failures and expected baseline red", () => {
  const baseline = deriveFailureObservation({
    taskId: "task-acceptance",
    status: "PASS",
    results: [],
    acceptance: [{
      criterionId: "criterion-behavior",
      runnerId: "acceptance",
      phase: "baseline",
      status: "PASS",
      failureClass: "none",
      requiredCheckIds: ["red-check"],
      redCheckIds: ["red-check"],
      checks: [{checkId: "red-check", status: "FAIL", failureClass: "assertion"}]
    }]
  });
  assert.deepEqual(baseline.checks, [{
    criterionId: "criterion-behavior", runnerId: "acceptance", checkId: "red-check",
    phase: "baseline", status: "PASS", failureClass: "none", pinId: null
  }]);

  const candidate = deriveFailureObservation({
    taskId: "task-acceptance",
    status: "FAIL",
    results: [],
    acceptance: [{
      criterionId: "criterion-behavior",
      runnerId: "acceptance",
      phase: "candidate",
      status: "FAIL",
      failureClass: "assertion",
      requiredCheckIds: ["red-check", "green-check"],
      checks: [
        {checkId: "red-check", status: "PASS", failureClass: "none"},
        {checkId: "green-check", status: "FAIL", failureClass: "assertion"}
      ]
    }]
  });
  assert.equal(candidate.checks.find((check) => check.checkId === "green-check")?.status, "FAIL");
  assert.equal(candidate.checks.find((check) => check.checkId === "green-check")?.failureClass, "assertion");

  const badBaseline = deriveFailureObservation({
    taskId: "task-acceptance",
    status: "FAIL",
    results: [],
    acceptance: [{
      criterionId: "criterion-behavior",
      runnerId: "acceptance",
      phase: "baseline",
      status: "FAIL",
      failureClass: "non-discriminating",
      requiredCheckIds: ["red-check"],
      redCheckIds: ["red-check"],
      checks: [{checkId: "red-check", status: "PASS", failureClass: "none"}]
    }]
  });
  assert.equal(badBaseline.checks[0]?.status, "FAIL");
  assert.equal(badBaseline.checks[0]?.failureClass, "non-discriminating");
});

async function supervisorFixture(): Promise<{
  readonly root: string;
  readonly repository: FileRunRepository;
  readonly runId: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-convergence-"));
  const repository = new FileRunRepository(join(root, "runs"), root);
  const state = createRunState({
    root,
    commonDir: root,
    targetBranch: "main",
    goal: "repair the checked failure",
    host: "codex",
    ownerSessionId: "session-convergence",
    runId: "run-convergence",
    now: "2026-10-05T00:00:00.000Z"
  });
  await repository.create(state);
  await new RunScheduler({ repository }).addTasks(state.runId, [
    { taskId: "task-convergence", dependencies: [], status: "planned", workerId: null, deliveryDigest: null, sourceCommit: null, blockedReason: null }
  ]);
  return { root, repository, runId: state.runId };
}

test("supervisor ignores diagnostic changes for the same semantic failure", async () => {
  const fixture = await supervisorFixture();
  try {
    const host: NativeGoalHost = {
      host: "codex",
      async start() {
        return { nativeSessionId: "native-convergence", nativeJobId: null, processId: null, processIdentity: null, instance: null };
      },
      async inspect() {
        return { nativeGoalState: "active" as const, processAlive: false, processIdentity: null, stateDigest: null };
      },
      async resume() {},
      async send() {},
      async stop() {}
    };
    const supervisor = new RunSupervisor({ repository: fixture.repository, host, now: () => "2026-10-05T00:00:01.000Z", leaseMs: 5_000 });
    const registration = await supervisor.registerWorker(fixture.runId, { taskId: "task-convergence", ownerSessionId: "session-convergence" });
    await supervisor.startWorker(fixture.runId, registration.workerId, registration.generation, "repair checked failure");
    const semantic = "a".repeat(64);
    const progress = "b".repeat(64);
    const first = await supervisor.recordFailure(fixture.runId, registration.workerId, registration.generation, {
      checkId: "node-test",
      pinId: null,
      failureClass: "assertion",
      fingerprint: semantic,
      diagnosticDigest: "c".repeat(64),
      phase: "verification",
      progressDigest: progress,
      round: 1,
      usefulProgress: false
    });
    assert.equal(first.noProgress, false);
    const repeated = await supervisor.recordFailure(fixture.runId, registration.workerId, registration.generation, {
      checkId: "node-test",
      pinId: null,
      failureClass: "assertion",
      fingerprint: semantic,
      diagnosticDigest: "d".repeat(64),
      phase: "verification",
      progressDigest: progress,
      round: 2,
      usefulProgress: false
    });
    assert.equal(repeated.noProgress, true);
    assert.equal(repeated.state.workers[0]?.status, "blocked");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("run policy binding is optional for legacy state and strict when present", () => {
  const state = createRunState({
    root: "/tmp/project",
    commonDir: "/tmp/project/.git",
    targetBranch: "main",
    goal: "bind policy",
    host: "claude",
    ownerSessionId: "session-policy",
    runId: "run-policy",
    now: "2026-10-05T00:00:00.000Z"
  });
  assert.doesNotThrow(() => assertRunState(state));
  const binding: RunPolicyBinding = {
    configHash: "a".repeat(64),
    runtimeHash: "b".repeat(64),
    artifactDigest: "c".repeat(64),
    expiresAt: "2026-10-06T00:00:00.000Z"
  };
  assert.doesNotThrow(() => assertRunState({ ...state, policyBinding: binding }));
  assert.throws(
    () => assertRunState({ ...state, policyBinding: { ...binding, runtimeHash: "not-a-sha" } }),
    { code: "RUN_STATE_INVALID" }
  );
  assert.throws(
    () => assertRunState({ ...state, policyBinding: { ...binding, extra: "field" } as RunPolicyBinding & { extra: string } }),
    { code: "RUN_STATE_INVALID" }
  );
  assert.throws(
    () => assertRunState({ ...state, policyBinding: { ...binding, expiresAt: "10/06/2026" } }),
    { code: "RUN_STATE_INVALID" }
  );
});
