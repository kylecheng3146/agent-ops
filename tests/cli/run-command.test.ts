import assert from "node:assert/strict";
import test from "node:test";

import { createRunState, type RunLifecycleResult, type RunState } from "../../runtime/src/run/service.js";
import { runRunCommand, type RunCommandService, type RunParsedArgs } from "../../packages/cli/src/commands/run.js";

function args(overrides: Partial<RunParsedArgs> = {}): RunParsedArgs {
  return {
    command: "run",
    profiles: [],
    dryRun: false,
    json: true,
    yes: false,
    rerun: false,
    ...overrides
  } as RunParsedArgs;
}

function service(state: RunState): RunCommandService {
  const result = (message: string): RunLifecycleResult => ({ state, message });
  return {
    start: async () => result(`Run ${state.runId} started.`),
    status: async () => state,
    logs: async () => state.events,
    resume: async () => result(`Run ${state.runId} resumed.`),
    stop: async () => result(`Run ${state.runId} stopping.`),
    respond: async () => result(`Run ${state.runId} answered.`)
  };
}

test("run command exposes start and keeps native completion below final proof", async () => {
  const state = createRunState({
    root: "/repo", commonDir: "/repo/.git", targetBranch: "main", goal: "Ship the bounded loop.",
    host: "codex", ownerSessionId: "session-run", runId: "run-cli-test", now: "2026-10-04T00:00:00.000Z"
  });
  const result = await runRunCommand({
    args: args({ goal: "Ship the bounded loop." }), service: service(state), root: "/repo", commonDir: "/repo/.git",
    targetBranch: "main", ownerSessionId: "session-run"
  });
  assert.equal(result.status, "ok");
  assert.equal(result.code, "RUN_STARTED");
  assert.match(result.data?.text ?? "", /Native goal completion is not final proof/u);
});

test("run command rejects conflicting goal and answer sources", async () => {
  const state = createRunState({
    root: "/repo", commonDir: "/repo/.git", targetBranch: "main", goal: "Ship it.",
    host: "codex", ownerSessionId: "session-run", runId: "run-cli-test-2", now: "2026-10-04T00:00:00.000Z"
  });
  const start = await runRunCommand({
    args: args({ goal: "Ship it.", goalFile: "goal.txt" }), service: service(state), root: "/repo", commonDir: "/repo/.git",
    targetBranch: "main", ownerSessionId: "session-run"
  });
  assert.equal(start.code, "RUN_GOAL_CONFLICT");
  const respond = await runRunCommand({
    args: args({ runAction: "respond", runId: state.runId, questionId: "q", answer: "yes", answerFile: "answer.txt" }),
    service: service(state), root: "/repo", commonDir: "/repo/.git", targetBranch: "main", ownerSessionId: "session-run"
  });
  assert.equal(respond.code, "RUN_ANSWER_CONFLICT");
});

test("run status reports recovery without treating a recorded proof as validated authority", async () => {
  const initial = createRunState({root: "/repo", commonDir: "/repo/.git", targetBranch: "main", goal: "Recover safely",
    host: "codex", ownerSessionId: "owner"});
  const state: RunState = {...initial, status: "blocked", phase: "integrating", events: [{id: "denial", at: initial.createdAt,
    type: "diagnostic", code: "RUN_COMMAND_DENIED", workerId: null, taskId: null, detail: "Explicit organization denial"}],
    integration: {transactionId: "sealed", status: "receipt-written", expectedTarget: "a".repeat(40), candidate: "b".repeat(40),
      completedSteps: ["target", "tasks", "receipt", "note"], childDeliveries: [], receiptPath: "/receipt", receiptDigest: "d".repeat(64),
      proofDigest: "e".repeat(64), updatedAt: initial.updatedAt}};
  const result = await runRunCommand({args: args({runAction: "status", runId: state.runId}), service: service(state),
    root: state.root, commonDir: state.commonDir, targetBranch: state.targetBranch, ownerSessionId: state.ownerSessionId});
  assert.equal(result.data?.recovery.phase, "integrating");
  assert.equal(result.data?.recovery.cause?.code, "RUN_COMMAND_DENIED");
  assert.equal(result.data?.recovery.sealedProof, "recorded-unchecked");
  assert.equal(result.data?.recovery.cleanup, "pending");
  assert.equal(result.data?.recovery.resumable, false);
  assert.match(result.data?.text ?? "", /genuine new authorization/u);
});

test("run status and logs JSON omit the event history and goal text that polling would reread", async () => {
  const initial = createRunState({root: "/repo", commonDir: "/repo/.git", targetBranch: "main", goal: "A long goal ".repeat(200),
    host: "codex", ownerSessionId: "owner"});
  const state: RunState = {...initial, events: Array.from({length: 3}, (_, index) => ({id: `event-${index}`, at: initial.createdAt,
    type: "diagnostic" as const, code: "RUN_COMMAND_AUTO_APPROVED", workerId: null, taskId: null, detail: "approved"}))};
  const call = (runAction: "status" | "logs") => runRunCommand({args: args({runAction, runId: state.runId}), service: service(state),
    root: state.root, commonDir: state.commonDir, targetBranch: state.targetBranch, ownerSessionId: state.ownerSessionId});
  for (const runAction of ["status", "logs"] as const) {
    const brief = (await call(runAction)).data?.state as unknown as Record<string, unknown>;
    assert.equal("events" in brief, false, runAction);
    assert.equal("goal" in brief, false, runAction);
    assert.equal(brief.eventCount, 3, runAction);
    assert.equal(brief.goalHash, state.goalHash, runAction);
    assert.equal(brief.status, state.status, runAction);
  }
  const logs = (await call("logs")).data as unknown as {events: unknown[]};
  assert.equal(logs.events.length, 3, "run logs still returns the events");
});
