import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {TaskService} from "../../runtime/src/task/service.js";
import {FileTaskStore} from "../../runtime/src/task/store.js";
import {createRunState, FileRunRepository} from "../../runtime/src/run/service.js";
import {recordRunVerification, observeRunFailure} from "../../runtime/src/run/verification.js";
import {compareFailureObservations} from "../../runtime/src/run/convergence.js";
import type {VerificationReport} from "../../runtime/src/verify/service.js";

test("production verifier observations preserve command failures and ignore changed diagnostics and source hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-run-verification-"));
  try {
    const tasks = new TaskService(new FileTaskStore(join(root, ".agent-ops/tasks/state.json"), root));
    const task = await tasks.create({title: "Verify semantics", sessionId: "owner", criteria: [
      {id: "one", description: "Local checks pass", verifierIds: ["smoke"]}, {id: "two", description: "Other checks pass", verifierIds: ["other"]}]});
    const commonDir = join(root, ".git");
    const repository = new FileRunRepository(join(commonDir, "agent-ops/runs"), commonDir);
    const state = createRunState({root, commonDir, goal: "Fixed goal", targetBranch: "main", host: "codex", ownerSessionId: "owner"});
    await repository.create({...state, policyBinding: {configHash: "a".repeat(64), runtimeHash: "b".repeat(64), artifactDigest: "c".repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString()},
      workers: [{workerId: "writer", taskId: task.task.id, host: "codex", ownerSessionId: "owner", nativeSessionId: "native", nativeJobId: "thread", worktree: root,
        processId: null, processIdentity: null, generation: 1, status: "running", leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: "active", lastFailure: null}]});
    const report = (diagnostic: string, sourceFingerprint: string, smoke: "PASS" | "FAIL" = "FAIL"): VerificationReport => ({taskId: task.task.id, status: "FAIL",
      surface: {staged: [], unstaged: [], untracked: [], paths: []}, selection: {verifierIds: ["smoke", "other"], fallback: true, reason: "no-changes", evidence: {changedPaths: [], mappings: [], requiredVerifierIds: ["smoke", "other"]}},
      results: ["smoke", "other"].map(id => ({commandId: id, status: id === "smoke" ? smoke : "FAIL", required: true, failureClass: id === "smoke" && smoke === "PASS" ? "none" : "assertion", diagnostic,
        exitCode: 1, timedOut: false, testCount: 1, evidenceReferences: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString()})),
      reviewScope: {mode: "worktree", changedFiles: ["product.ts"]}, sourceFingerprint, signal: null});
    await recordRunVerification(repository, (await repository.read(state.runId))!, "writer", task, report("first timing", "d".repeat(64)));
    const first = await observeRunFailure((await repository.read(state.runId))!, root, [task], task.task.id, "VERIFICATION_FAILED", []);
    await recordRunVerification(repository, (await repository.read(state.runId))!, "writer", task, report("different timing", "e".repeat(64)));
    const repeated = await observeRunFailure((await repository.read(state.runId))!, root, [task], task.task.id, "VERIFICATION_FAILED", []);
    assert.equal(repeated.failureKey, first.failureKey);
    assert.equal(compareFailureObservations(first, repeated).usefulProgress, false);
    assert.ok(repeated.checks.some(c => c.checkId.endsWith(":smoke") && c.status === "FAIL"));
    await recordRunVerification(repository, (await repository.read(state.runId))!, "writer", task, report("fixed smoke", "f".repeat(64), "PASS"));
    const progress = await observeRunFailure((await repository.read(state.runId))!, root, [task], task.task.id, "VERIFICATION_FAILED", []);
    assert.equal(compareFailureObservations(repeated, progress).usefulProgress, true);
    const changed = {...task, task: {...task.task, criteria: task.task.criteria.map(c => ({...c, description: c.description + " revised"}))}};
    const stale = await observeRunFailure((await repository.read(state.runId))!, root, [changed], task.task.id, "VERIFICATION_FAILED", []);
    assert.ok(stale.checks.every(c => c.checkId === "VERIFICATION_FAILED"), "previous contract cannot contribute current progress");
  } finally {await rm(root, {recursive: true, force: true});}
});
