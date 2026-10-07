import { createRunState, type RunState } from "../../runtime/src/run/service.js";

export const NOW = Date.parse("2026-10-07T01:00:00.000Z");

export function runFixture(): RunState {
  const base = createRunState({root: "/repo", commonDir: "/repo/.git", targetBranch: "main",
    goal: "# Goal: office view\n\nMore detail.", host: "claude", ownerSessionId: "owner", runId: "run-office-fixture",
    now: "2026-10-07T00:00:00.000Z", timeBudgetMs: 60 * 60 * 1000});
  const worker = (id: string, task: string, path: string, status: "running" | "stopped", phase?: "implementing" | "verifying") => ({
    workerId: id, taskId: task, host: "claude" as const, ownerSessionId: "owner", nativeSessionId: null, nativeJobId: null,
    worktree: path, processId: null, processIdentity: null, generation: 1, status, leaseExpiresAt: null, heartbeatAt: null,
    stopIntent: null, nativeGoalState: "active" as const, lastFailure: null, ...(phase === undefined ? {} : {phase})});
  return {...base, phase: "verifying",
    budget: {...base.budget, activeIntervals: [{startMs: NOW - 20 * 60 * 1000, endMs: null}]},
    tasks: [
      {taskId: "root", dependencies: [], status: "running", workerId: base.coordinatorId, deliveryDigest: null, sourceCommit: null,
        blockedReason: null, progress: {verify: "PASS", review: null, passed: 2, total: 6}},
      {taskId: "child", dependencies: [], status: "running", workerId: "w1", deliveryDigest: null, sourceCommit: null, blockedReason: null}],
    workers: [worker(base.coordinatorId, "root", "/repo/.worktrees/coord", "running", "verifying"),
      worker("w1", "child", "/repo/.worktrees/child", "running"),
      worker("w-old", "child", "/repo/.worktrees/old", "stopped")],
    questions: [{questionId: "q-1", prompt: "Which port?", askedAt: "2026-10-07T00:30:00.000Z", answeredAt: null, answerDigest: null}]};
}
