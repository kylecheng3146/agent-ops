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
