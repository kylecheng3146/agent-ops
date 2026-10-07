import assert from "node:assert/strict";
import {mkdtemp, realpath, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import type {AgentOpsConfig} from "../../runtime/src/contracts.js";
import {calculateConfigHash} from "../../runtime/src/config/hash.js";
import {bindRunPolicy, readRunPolicy, runRuntimeHash} from "../../runtime/src/run/policy.js";
import {createRunState, FileRunRepository, RunService} from "../../runtime/src/run/service.js";
import {beginPolicyTransition, markPolicyTransitionStage, currentPolicyArtifact} from "../../runtime/src/run/policy-transition.js";
import {renewPendingRunPolicy} from "../../packages/cli/src/run-deps.js";

const config: AgentOpsConfig = {schemaVersion: 3, profiles: ["core"], verification: {commands: []},
  features: {completionGate: {enabled: false}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [], worktree: {mode: "auto", setup: []}};

for (const crashGap of ["none", "fresh", "expired", "repeated-expired", "missing-history"]) test(`explicit resume recovers bound policy renewal (${crashGap})`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ops-policy-recovery-")));
  try {
    const commonDir = join(root, ".git"), repository = new FileRunRepository(join(commonDir, "agent-ops/runs"), commonDir);
    const oldTime = Date.now() - 3700000, runtimeHash = await runRuntimeHash();
    const state = createRunState({root, commonDir, targetBranch: "main", goal: "Preserve expired policy history", host: "codex", ownerSessionId: "owner", now: new Date(oldTime).toISOString()});
    await repository.create(state);
    const trust = {canonicalPath: root, remoteIdentity: "local:fixture", configHash: calculateConfigHash(config), runtimeHash: "a".repeat(64)};
    const first = await bindRunPolicy(repository, state.runId, {config, runtimeHash, baseTrustBinding: trust, now: oldTime});
    const journal = await beginPolicyTransition(repository, state.runId, {now: new Date(oldTime + 1).toISOString()});
    await markPolicyTransitionStage(repository, state.runId, journal.transitionId, {stage: "fenced", now: new Date(oldTime + 2).toISOString()});
    const bound = await bindRunPolicy(repository, state.runId, {config, runtimeHash, baseTrustBinding: trust, expectedDigest: first.policyBinding!.artifactDigest, now: oldTime + 3});
    const pending = await markPolicyTransitionStage(repository, state.runId, journal.transitionId, {stage: "bound", now: new Date(oldTime + 4).toISOString()});
    await assert.rejects(readRunPolicy(bound, runtimeHash), {code: "RUN_POLICY_EXPIRED"});
    await assert.rejects(renewPendingRunPolicy(repository, state.runId, pending), {code: "RUN_POLICY_RECOVERY_REQUIRED"});
    const lifecycle = new RunService(repository);
    await lifecycle.stop(state.runId); await lifecycle.resume(state.runId);
    let gapDigest: string | undefined;
    if (crashGap !== "none") {
      gapDigest = (await bindRunPolicy(repository, state.runId, {config, runtimeHash, baseTrustBinding: trust,
        expectedDigest: bound.policyBinding!.artifactDigest, ...(crashGap.includes("expired") ? {now: oldTime + 5} : {})})).policyBinding!.artifactDigest;
      if (crashGap === "repeated-expired") gapDigest = (await bindRunPolicy(repository, state.runId, {
        config, runtimeHash, baseTrustBinding: trust, expectedDigest: gapDigest, now: oldTime + 6})).policyBinding!.artifactDigest;
    }
    if (crashGap === "missing-history") {
      await rm(join(commonDir, "agent-ops/runs", state.runId, "policies", bound.policyBinding!.artifactDigest + ".json"));
      await assert.rejects(renewPendingRunPolicy(repository, state.runId, pending), {code: "RUN_POLICY_CHANGED"});
      assert.equal((await repository.read(state.runId))!.policyBinding!.artifactDigest, gapDigest);
      return;
    }
    const recovered = await renewPendingRunPolicy(repository, state.runId, pending);
    const latest = (await repository.read(state.runId))!;
    const policy = (await readRunPolicy(latest, runtimeHash))!;
    assert.equal(policy.previousDigest, crashGap.includes("expired") ? gapDigest : bound.policyBinding!.artifactDigest);
    assert.equal(recovered.renewals.length, 1);
    assert.deepEqual(recovered.renewals[0]!.previousPolicyArtifact, pending.newPolicyArtifact);
    assert.deepEqual(recovered.newPolicyArtifact, currentPolicyArtifact(latest));
    assert.equal(latest.goalHash, state.goalHash);
    assert.equal(latest.budget.limitMs, state.budget.limitMs);
    assert.equal(latest.workers.length, 0, "read-only renewal reconciliation cannot activate a writer");
    if (crashGap === "fresh") assert.equal(latest.policyBinding!.artifactDigest, gapDigest, "recovery must not bind a second allowance after a fresh crash gap");
  } finally {await rm(root, {recursive: true, force: true});}
});
