import {writePrivateFile} from "../../runtime/src/security/permissions.js";
import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {createRunState, FileRunRepository} from "../../runtime/src/run/service.js";
import {recordNativeRunUsage, recordReviewRunUsage, recordSavedReviewRunUsage} from "../../runtime/src/run/usage.js";
import type {ReviewReportArtifact} from "../../runtime/src/review/attestation.js";
import type {NativeGoalEvent} from "../../runtime/src/run/hosts/types.js";

test("claude cumulative session cost counts once per native session while tokens keep summing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-usage-"));
  try {
    const repository = new FileRunRepository(join(root, "runs"), root);
    const state = createRunState({root, commonDir: root, targetBranch: "main", goal: "Count cost once.", host: "claude", ownerSessionId: "owner"});
    const worker = {workerId: "worker", taskId: "task", host: "claude" as const, ownerSessionId: "owner",
      nativeSessionId: "session-a", nativeJobId: null, worktree: root, processId: null, processIdentity: null,
      generation: 1, status: "running" as const, leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: "active" as const, lastFailure: null};
    await repository.create({...state, workers: [worker]});
    let n = 0;
    const result = (cost: number, tokens: number): NativeGoalEvent => ({runId: state.runId, workerId: "worker", generation: 1,
      contractHash: state.goalHash, host: "claude", type: "completed", at: "2026-11-25T00:00:00Z", nativeStatus: "active", proof: false,
      payload: {type: "result", uuid: `result-${++n}`, total_cost_usd: cost, usage: {input_tokens: tokens, output_tokens: 0}}});
    for (const [cost, tokens] of [[0.30, 100], [0.81, 50], [0.81, 0], [0.81, 0]] as const) await recordNativeRunUsage(repository, result(cost, tokens));
    let saved = (await repository.read(state.runId))!;
    assert.equal(saved.budget.usage.usd, 0.81, "A cumulative session cost is counted at its maximum, once");
    assert.equal(saved.budget.usage.tokens, 150, "Per-result tokens still add up");
    await repository.mutate(state.runId, current => ({...current, workers: current.workers.map(w => ({...w, nativeSessionId: "session-b"}))}));
    await recordNativeRunUsage(repository, result(0.20, 10));
    saved = (await repository.read(state.runId))!;
    assert.ok(Math.abs(saved.budget.usage.usd! - 1.01) < 1e-9, "Different native sessions add up");
  } finally {await rm(root, {recursive: true, force: true});}
});

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
      payload: {tokenUsage: {total: {inputTokens: total - 1, outputTokens: 1, totalTokens: total}}}});
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
    const failed: ReviewReportArtifact = {...report, schemaVersion: 2, goalHash: state.goalHash, taskId: "task-one", status: "FAIL",
      createdAt: new Date(Date.parse(state.createdAt) + 1000).toISOString(),
      attempts: [{target: "codex", status: "FAIL", sessionId: "review-failed", metrics: {promptBytes: 20, durationMs: 100, usage: {totalTokens: 4}}}],
      report: {summary: "Failure", results: [{criterionId: "one", status: "FAIL", summary: "Failure", evidence: []}], findings: [], residualRisks: [],
        changedFilesInspected: ["product.ts"], supportingFilesInspected: []}};
    await writePrivateFile(join(root, ".agent-ops/reviews", "a".repeat(64) + ".task-one.reports.json"), JSON.stringify(failed), root);
    await recordSavedReviewRunUsage(repository, state.runId, root);
    await recordSavedReviewRunUsage(repository, state.runId, root);
    assert.equal((await repository.read(state.runId))!.budget.usage.tokens, 22, "a failed review session is charged once as well");
    await repository.mutate(state.runId, current => ({...current, status: "paused"}));
    await assert.rejects(repository.write(saved), {code: "RUN_STATE_STALE"});
    assert.equal((await repository.read(state.runId))!.status, "paused", "stale snapshot cannot resurrect an active writer");
  } finally {await rm(root, {recursive: true, force: true});}
});
