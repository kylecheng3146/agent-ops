import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { RunControlService } from "../../runtime/src/run/controls.js";
import { activeWallTimeMs, noProgressForTwoRounds, planSchedule, RunScheduler, validateRunDag } from "../../runtime/src/run/scheduler.js";
import { FileRunRepository, createRunState, RunService, type RunState } from "../../runtime/src/run/service.js";
import { RunSupervisor, type NativeGoalHost } from "../../runtime/src/run/supervisor.js";
import { validateWorkerStopHandoff } from "../../runtime/src/run/worker-gate.js";

async function repositoryFixture(): Promise<{ readonly root: string; readonly repository: FileRunRepository; readonly state: RunState }> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-run-"));
  const repository = new FileRunRepository(join(root, ".git", "agent-ops", "runs"), root);
  const state = createRunState({
    root,
    commonDir: join(root, ".git"),
    targetBranch: "main",
    goal: "Implement the bounded run loop.",
    host: "codex",
    ownerSessionId: "session-run",
    now: "2026-10-04T00:00:00.000Z"
  });
  await repository.write(state);
  return { root, repository, state };
}

test("run state persists a fixed goal and whole-run budget", async () => {
  const fixture = await repositoryFixture();
  try {
    const service = new RunService(fixture.repository, () => "2026-10-04T00:00:01.000Z");
    const started = await service.status(fixture.state.runId);
    assert.equal(started.goalHash.length, 64);
    assert.equal(started.budget.limitMs, 60 * 60 * 1_000);
    assert.equal(started.jobs, 2);
    await assert.rejects(
      service.start({
        root: fixture.root,
        commonDir: join(fixture.root, ".git"),
        targetBranch: "main",
        goal: "another run",
        host: "codex",
        ownerSessionId: "session-run",
        runId: fixture.state.runId
      }),
      (cause: unknown) => cause instanceof AgentOpsError && cause.code === "RUN_EXISTS"
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("scheduler validates DAGs and counts overlapping writer time once", async () => {
  assert.throws(() => validateRunDag([
    { taskId: "a", dependencies: ["b"], status: "planned", workerId: null, deliveryDigest: null, sourceCommit: null, blockedReason: null },
    { taskId: "b", dependencies: ["a"], status: "planned", workerId: null, deliveryDigest: null, sourceCommit: null, blockedReason: null }
  ]), (cause: unknown) => cause instanceof AgentOpsError && cause.code === "RUN_DAG_CYCLE");
  assert.equal(activeWallTimeMs([{ startMs: 0, endMs: 10 }, { startMs: 5, endMs: 20 }, { startMs: 30, endMs: 35 }], 40), 25);
  assert.equal(noProgressForTwoRounds([
    { taskId: "a", failureId: "f", failureClass: "assertion", diagnosticDigest: "d", usefulProgress: false },
    { taskId: "a", failureId: "f", failureClass: "assertion", diagnosticDigest: "d", usefulProgress: false }
  ]), true);
  const fixture = await repositoryFixture();
  try {
    const scheduler = new RunScheduler({ repository: fixture.repository, now: () => "2026-10-04T00:00:01.000Z" });
    await scheduler.addTasks(fixture.state.runId, [
      { taskId: "a", dependencies: [], status: "planned", workerId: null, deliveryDigest: null, sourceCommit: null, blockedReason: null },
      { taskId: "b", dependencies: ["a"], status: "planned", workerId: null, deliveryDigest: null, sourceCommit: null, blockedReason: null },
      { taskId: "c", dependencies: [], status: "planned", workerId: null, deliveryDigest: null, sourceCommit: null, blockedReason: null }
    ]);
    const plan = await scheduler.plan(fixture.state.runId);
    assert.deepEqual(plan.ready.map((task) => task.taskId), ["a", "c"]);
    assert.equal(plan.availableSlots, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("supervisor fences a worker before publishing delivery and requires final proof", async () => {
  const fixture = await repositoryFixture();
  try {
    const scheduler = new RunScheduler({ repository: fixture.repository });
    await scheduler.addTasks(fixture.state.runId, [
      { taskId: "a", dependencies: [], status: "planned", workerId: null, deliveryDigest: null, sourceCommit: null, blockedReason: null }
    ]);
    const host: NativeGoalHost = {
      host: "codex",
      async start() { return { nativeSessionId: "native-a", nativeJobId: "job-a", processId: null, processIdentity: null, instance: "codex-test" }; },
      async inspect() { return { nativeGoalState: "complete", processAlive: false, processIdentity: null, stateDigest: null }; },
      async resume() {},
      async send() {},
      async stop() {}
    };
    const supervisor = new RunSupervisor({ repository: fixture.repository, host, now: () => "2026-10-04T00:00:01.000Z", leaseMs: 5_000 });
    const registration = await supervisor.registerWorker(fixture.state.runId, { taskId: "a", ownerSessionId: "session-run", worktree: null });
    await supervisor.startWorker(fixture.state.runId, registration.workerId, registration.generation, "finish task a");
    await supervisor.beginHandoff(fixture.state.runId, {
      workerId: registration.workerId,
      generation: registration.generation,
      deliveryDigest: "a".repeat(64),
      contractDigest: "b".repeat(64),
      sourceCommit: "c".repeat(40)
    });
    const delivery = await supervisor.confirmHandoff(fixture.state.runId, {
      workerId: registration.workerId,
      generation: registration.generation,
      deliveryDigest: "a".repeat(64),
      contractDigest: "b".repeat(64),
      sourceCommit: "c".repeat(40)
    }, { processDead: true });
    const repeated = await supervisor.beginHandoff(fixture.state.runId, {
      workerId: registration.workerId,
      generation: registration.generation,
      deliveryDigest: "a".repeat(64),
      contractDigest: "b".repeat(64),
      sourceCommit: "c".repeat(40)
    });
    assert.equal(repeated.confirmedDeadAt, delivery.worker.stopIntent?.confirmedDeadAt);
    await supervisor.publishDelivery(fixture.state.runId, {
      workerId: registration.workerId,
      generation: registration.generation,
      deliveryDigest: delivery.deliveryDigest,
      contractDigest: "b".repeat(64),
      sourceCommit: delivery.sourceCommit
    }, { noChange: false, artifactRefs: [] });
    await assert.rejects(
      supervisor.finalize(fixture.state.runId, {
        targetCommit: "d".repeat(40), candidateCommit: "c".repeat(40), verificationPass: false,
        reviewPass: true, taskStateComplete: true, receiptWritten: true, receiptDigest: "e".repeat(64)
      }),
      (cause: unknown) => cause instanceof AgentOpsError && cause.code === "RUN_FINAL_PROOF_REQUIRED"
    );
    const final = await supervisor.finalize(fixture.state.runId, {
      targetCommit: "d".repeat(40), candidateCommit: "c".repeat(40), verificationPass: true,
      reviewPass: true, taskStateComplete: true, receiptWritten: true, receiptDigest: "e".repeat(64)
    });
    assert.equal(final.status, "complete");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("run controls remain scoped and expose stop as a terminal-intent request", async () => {
  const fixture = await repositoryFixture();
  try {
    const controls = new RunControlService(fixture.repository, () => "2026-10-04T00:00:02.000Z");
    const stopped = await controls.request(fixture.state.runId, { action: "stop", actor: "user", reason: "test stop" });
    assert.equal(stopped.status, "stopping");
    assert.equal(stopped.disableRestart, true);
    const resumed = await controls.request(fixture.state.runId, { action: "resume", actor: "user" });
    assert.equal(resumed.status, "active");
    assert.equal(resumed.disableRestart, false, "an explicit resume re-enables supervised reconciliation");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("supervisor records structured failures and fences a worker after two stagnant rounds", async () => {
  const fixture = await repositoryFixture();
  try {
    const scheduler = new RunScheduler({ repository: fixture.repository });
    await scheduler.addTasks(fixture.state.runId, [
      { taskId: "a", dependencies: [], status: "planned", workerId: null, deliveryDigest: null, sourceCommit: null, blockedReason: null }
    ]);
    const host: NativeGoalHost = {
      host: "codex",
      async start() { return { nativeSessionId: "native-failure", nativeJobId: null, processId: null, processIdentity: null, instance: null }; },
      async inspect() { return { nativeGoalState: "active" as const, processAlive: false, processIdentity: null, stateDigest: null }; },
      async resume() {}, async send() {}, async stop() {}
    };
    const supervisor = new RunSupervisor({ repository: fixture.repository, host, now: () => "2026-10-04T00:00:01.000Z", leaseMs: 5_000 });
    const registration = await supervisor.registerWorker(fixture.state.runId, { taskId: "a", ownerSessionId: "session-run" });
    await supervisor.startWorker(fixture.state.runId, registration.workerId, registration.generation, "repair task a");
    const failure = {
      checkId: "check-a", pinId: "pin-a", failureClass: "assertion", fingerprint: "c".repeat(64), diagnosticDigest: "d".repeat(64), usefulProgress: false
    };
    assert.equal((await supervisor.recordFailure(fixture.state.runId, registration.workerId, registration.generation, { ...failure, round: 1 })).noProgress, false);
    const result = await supervisor.recordFailure(fixture.state.runId, registration.workerId, registration.generation, { ...failure, round: 2 });
    assert.equal(result.noProgress, true);
    assert.equal(result.state.workers[0]?.status, "blocked");
    assert.equal(result.state.tasks[0]?.status, "blocked");
    assert.equal(result.state.events.at(-1)?.code, "RUN_NO_PROGRESS_REPEAT");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("schedule plan leaves independent work ready when another task is blocked", async () => {
  const fixture = await repositoryFixture();
  try {
    const state = {
      ...fixture.state,
      tasks: [
        { taskId: "blocked", dependencies: [], status: "blocked" as const, workerId: null, deliveryDigest: null, sourceCommit: null, blockedReason: "failed" },
        { taskId: "independent", dependencies: [], status: "planned" as const, workerId: null, deliveryDigest: null, sourceCommit: null, blockedReason: null }
      ]
    };
    await fixture.repository.write(state);
    const plan = planSchedule(state);
    assert.deepEqual(plan.ready.map((task) => task.taskId), ["independent"]);
    assert.deepEqual(plan.blocked.map((task) => task.taskId), ["blocked"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("worker Stop gate accepts only a fenced coordinator handoff", async () => {
  const fixture = await repositoryFixture();
  try {
    const repository = fixture.repository;
    const runId = fixture.state.runId;
    await repository.mutate(runId, (state) => ({
      ...state,
      workers: [{
        workerId: "worker-a", taskId: "a", host: "codex", ownerSessionId: "session-run", nativeSessionId: "native-a", nativeJobId: null,
        worktree: fixture.root, processId: null, processIdentity: null, generation: 1, status: "handing-off" as const,
        leaseExpiresAt: null, heartbeatAt: null, stopIntent: {
          runId, workerId: "worker-a", generation: 1, nativeSessionId: "native-a", reason: "handoff" as const,
          deliveryDigest: "a".repeat(64), contractDigest: "b".repeat(64), sourceCommit: "c".repeat(40), expiresAt: "2026-10-04T00:01:00.000Z", confirmedDeadAt: null
        }, nativeGoalState: "complete" as const, lastFailure: null
      }]
    }));
    const record = {
      schemaVersion: 1 as const, name: "worker", branch: "agent-ops/worker", path: fixture.root,
      mainRoot: fixture.root, targetBranch: "main", base: "c".repeat(40), sessionId: "session-run", agentId: "agent-a",
      runId, workerId: "worker-a", ownerSessionId: "session-run", workerGeneration: 1, createdAt: "2026-10-04T00:00:00.000Z"
    };
    const blockedResult = await validateWorkerStopHandoff(repository, {
      root: fixture.root, sessionId: "session-run", agentId: "agent-a", runId, workerId: "worker-a", generation: 1,
      deliveryDigest: "a".repeat(64), contractDigest: "b".repeat(64)
    }, async () => record);
    assert.equal(blockedResult?.code, "RUN_WORKER_HANDOFF_PENDING");
    await repository.mutate(runId, (state) => ({ ...state, workers: state.workers.map((worker) => ({ ...worker, status: "fenced" as const, stopIntent: worker.stopIntent === null ? null : { ...worker.stopIntent, confirmedDeadAt: "2026-10-04T00:00:02.000Z" } })) }));
    const allowed = await validateWorkerStopHandoff(repository, {
      root: fixture.root, sessionId: "session-run", agentId: "agent-a", runId, workerId: "worker-a", generation: 1,
      deliveryDigest: "a".repeat(64), contractDigest: "b".repeat(64)
    }, async () => record);
    assert.equal(allowed?.code, "RUN_WORKER_HANDOFF_ALLOWED");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
