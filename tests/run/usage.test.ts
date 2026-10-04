import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createRunState, FileRunRepository} from "../../runtime/src/run/service.js";
import {recordNativeRunUsage, recordReviewRunUsage} from "../../runtime/src/run/usage.js";
import type {ReviewReportArtifact} from "../../runtime/src/review/attestation.js";
import type {NativeGoalEvent} from "../../runtime/src/run/hosts/types.js";

test("native usage deduplicates thread totals, preserves resumed sessions and rejects stale writers", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-usage-"));
  try {
    const repository = new FileRunRepository(join(root, "runs"), root);
    const state = createRunState({root, commonDir: root, targetBranch: "main", goal: "Bound usage.", host: "codex", ownerSessionId: "owner"});
    await repository.create({...state, workers: [{workerId: "worker", taskId: "task", host: "codex", ownerSessionId: "owner",
      nativeSessionId: "thread-a", nativeJobId: "thread-a", worktree: root, processId: null, processIdentity: null,
      generation: 1, status: "running", leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: "active", lastFailure: null}]});
    const event = (total: number, generation = 1): NativeGoalEvent => ({runId: state.runId, workerId: "worker", generation,
      contractHash: state.goalHash, host: "codex", type: "usage", at: "2026-10-04T00:00:00Z", nativeStatus: "active", proof: false,
      payload: {params: {tokenUsage: {total: {inputTokens: total - 1, outputTokens: 1, totalTokens: total}}}}});
    await recordNativeRunUsage(repository, event(10));
    await recordNativeRunUsage(repository, event(10));
    await recordNativeRunUsage(repository, event(4));
    assert.equal((await repository.read(state.runId))!.budget.usage.tokens, 10);
    assert.equal((await repository.read(state.runId))!.budget.usage.usd, null);
    await repository.mutate(state.runId, current => ({...current, workers: current.workers.map(worker =>
      ({...worker, nativeSessionId: "thread-b", generation: 2}))}));
    await recordNativeRunUsage(repository, event(100, 1));
    await recordNativeRunUsage(repository, event(3, 2));
    const saved = (await repository.read(state.runId))!;
    assert.equal(saved.budget.usage.tokens, 13);
    assert.equal(saved.budget.usage.completeness, "partial");
    assert.equal(saved.usage?.length, 2);
    const report: ReviewReportArtifact = {schemaVersion: 1, sourceFingerprint: "a".repeat(64), status: "PASS", harness: "codex",
      plannedTargets: ["codex", "codex"], preflight: [], createdAt: "2026-10-04T00:00:01Z",
      attempts: [{target: "codex", status: "PASS", sessionId: "review-one",
        metrics: {promptBytes: 20, durationMs: 100, usage: {totalTokens: 5}}}]};
    await recordReviewRunUsage(repository, state.runId, report);
    await recordReviewRunUsage(repository, state.runId, {...report, taskId: "copied-tree-report"});
    assert.equal((await repository.read(state.runId))!.budget.usage.tokens, 18);
    assert.equal((await repository.read(state.runId))!.budget.usage.usd, null);
    await repository.mutate(state.runId, current => ({...current, status: "paused"}));
    await assert.rejects(repository.write(saved), {code: "RUN_STATE_STALE"});
    assert.equal((await repository.read(state.runId))!.status, "paused", "stale snapshot cannot resurrect an active writer");
  } finally {await rm(root, {recursive: true, force: true});}
});
