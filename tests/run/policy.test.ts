import assert from "node:assert/strict";
import {mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import type {AgentOpsConfig} from "../../runtime/src/contracts.js";
import {calculateConfigHash} from "../../runtime/src/config/hash.js";
import {sha256} from "../../runtime/src/fs/hash.js";
import {bindRunPolicy, readRunPolicy, runRuntimeHash, validateRunPolicyChange} from "../../runtime/src/run/policy.js";
import {FileRunRepository, createRunState} from "../../runtime/src/run/service.js";
import {RunControlService, type RunCommandAuthorization} from "../../runtime/src/run/controls.js";
import {recordNativeRunAuthorization} from "../../runtime/src/run/authorization.js";
import type {NativeGoalEvent} from "../../runtime/src/run/hosts/types.js";
import {readPrivateFile} from "../../runtime/src/security/permissions.js";
import {writeWorktreeRecord, ensureSessionWorktree} from "../../runtime/src/parallel/service.js";
import {loadEffectiveConfig, repositoryTrust, runPolicyContext} from "../../packages/cli/src/context.js";
import {worktreeDependencies, trustStore} from "../../packages/cli/src/parallel-deps.js";
import {runBuiltCli} from "../e2e/helpers.js";
import {runWorktreeDependencies} from "../../packages/cli/src/run-deps.js";

const config: AgentOpsConfig = {schemaVersion: 3, profiles: ["core"], verification: {commands: []},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [],
  worktree: {mode: "auto", setup: []}};
const candidate: AgentOpsConfig = {...config, verification: {commands: [{id: "smoke", command: "node", args: ["tests/smoke.mjs"],
  cwd: ".", required: true, evidence: {kind: "exit-code"}}]}};
const approvals = [{capabilityId: "command:smoke", classification: "non-dangerous" as const, reason: "Runs the committed local smoke test without external writes."}];

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ops-run-policy-")));
  const common = join(root, ".git");
  const repository = new FileRunRepository(join(common, "agent-ops/runs"), common);
  const now = Date.now();
  const state = createRunState({root, commonDir: common, targetBranch: "main", goal: "Preserve the original goal", host: "codex", ownerSessionId: "owner", now: new Date(now).toISOString()});
  await repository.create(state);
  const baseTrustBinding = {canonicalPath: root, remoteIdentity: "local:fixture", configHash: calculateConfigHash(config), runtimeHash: "a".repeat(64)};
  await bindRunPolicy(repository, state.runId, {config, baseTrustBinding, runtimeHash: "b".repeat(64), now});
  return {root, repository, state: (await repository.read(state.runId))!, baseTrustBinding, now};
}

test("run policy requires a full capability assessment and preserves mandatory security policy", () => {
  assert.throws(() => validateRunPolicyChange(config, candidate, []), {code: "RUN_POLICY_APPROVAL_REQUIRED"});
  assert.throws(() => validateRunPolicyChange(config, candidate, [null as never]), {code: "RUN_POLICY_APPROVAL_REQUIRED"});
  assert.throws(() => validateRunPolicyChange(config, candidate, [{...approvals[0]!, shell: true} as never]), {code: "RUN_POLICY_APPROVAL_REQUIRED"});
  assert.equal(calculateConfigHash(validateRunPolicyChange(config, candidate, approvals)), calculateConfigHash(candidate));
  assert.throws(() => validateRunPolicyChange(config, {...candidate, features: {...config.features, completionGate: {enabled: false}}}, approvals), {code: "RUN_POLICY_GUARDRAIL_CHANGED"});
  assert.throws(() => validateRunPolicyChange(config, {...candidate, verification: {commands: [{...candidate.verification.commands[0]!, command: "git", args: ["reset", "--hard"]}]}}, approvals), {code: "RUN_POLICY_COMMAND_DENIED"});
});

test("production context uses only current run checkout identity, leaves permanent trust unchanged and blocks permanent grant", async () => {
  const f = await fixture();
  const keys = ["AGENT_OPS_HOME", "AGENT_OPS_RUN_ID", "AGENT_OPS_WORKER_ID", "AGENT_OPS_WORKER_GENERATION", "AGENT_OPS_RUN_PROOF_PID"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.AGENT_OPS_HOME = f.root;
    for (const key of keys.filter(k => k !== "AGENT_OPS_HOME")) delete process.env[key];
    const git = (args: string[]) => execFileSync("git", args, {cwd: f.root, stdio: ["ignore", "pipe", "pipe"]}).toString().trim();
    git(["init", "-q", "-b", "main"]); git(["config", "user.name", "Policy fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(f.root, "product.txt"), "fixture\n"); git(["add", "product.txt"]); git(["commit", "-qm", "Fixture"]);
    // Replace the synthetic unit-test runtime identity with the actual built toolkit.
    await f.repository.mutate(f.state.runId, state => {const {policyBinding: _binding, ...legacy} = state; return legacy;});
    await bindRunPolicy(f.repository, f.state.runId, {config, baseTrustBinding: f.baseTrustBinding, runtimeHash: await runRuntimeHash()});
    await f.repository.mutate(f.state.runId, state => ({...state, workers: [{workerId: state.coordinatorId, taskId: "task", host: "codex", ownerSessionId: "owner",
      nativeSessionId: "native", nativeJobId: "thread", worktree: f.root, processId: null, processIdentity: null, generation: 1,
      status: "stopped", leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: "inactive", lastFailure: null}]}));
    await writeWorktreeRecord({schemaVersion: 1, name: "session-fixture", branch: "main", path: f.root, mainRoot: f.root, targetBranch: "main", base: git(["rev-parse", "HEAD"]),
      sessionId: "owner", createdAt: new Date().toISOString(), runId: f.state.runId, coordinatorId: f.state.coordinatorId, workerId: f.state.coordinatorId, ownerSessionId: "owner", workerGeneration: 1});
    await trustStore().grant(f.baseTrustBinding);
    assert.equal(await repositoryTrust(f.root, (await loadEffectiveConfig(f.root, "project")).config, "0.5.3"), "TRUSTED");
    const snapshot = (await trustStore().status(f.baseTrustBinding)).status;
    await worktreeDependencies().trust.grant(f.root, config);
    await worktreeDependencies().trust.revoke(f.root, config);
    assert.equal((await trustStore().status(f.baseTrustBinding)).status, snapshot);
    const constructed = await ensureSessionWorktree(await runWorktreeDependencies(worktreeDependencies(), (await f.repository.read(f.state.runId))!),
      {cwd: f.root, sessionId: randomUUID()});
    const {repositoryTrustBinding} = await import("../../packages/cli/src/context.js");
    assert.notEqual((await trustStore().status(await repositoryTrustBinding(constructed.path, config, "0.5.3"))).status, "TRUSTED",
      "run worktree construction must not persist a global checkout grant");
    const attempt = runBuiltCli(["trust", "grant", "--yes", "--json"], f.root, f.root, {AGENT_OPS_RUN_ID: f.state.runId});
    assert.equal(JSON.parse(attempt.result.stdout).code, "RUN_POLICY_COORDINATOR_REQUIRED");
    process.env.AGENT_OPS_WORKER_ID = "another-worker"; process.env.AGENT_OPS_WORKER_GENERATION = "1";
    await assert.rejects(runPolicyContext(f.root), {code: "RUN_WORKER_STALE"});
    delete process.env.AGENT_OPS_WORKER_ID; delete process.env.AGENT_OPS_WORKER_GENERATION;
    await f.repository.mutate(f.state.runId, state => ({...state, disableRestart: true, status: "paused"}));
    await assert.rejects(loadEffectiveConfig(f.root, "project"), {code: "RUN_POLICY_DISABLED"});
  } finally {
    for (const [key, value] of Object.entries(original)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}
    await rm(f.root, {recursive: true, force: true});
  }
});

test("run policy has immutable lineage, runtime and expiry binding and rejects active writers", async () => {
  const f = await fixture();
  try {
    const oldDigest = f.state.policyBinding!.artifactDigest;
    const revised = await bindRunPolicy(f.repository, f.state.runId, {config: candidate, approvals, baseTrustBinding: f.baseTrustBinding,
      runtimeHash: "b".repeat(64), expectedDigest: oldDigest, now: f.now + 1});
    const policy = (await readRunPolicy(revised, "b".repeat(64), f.now + 2))!;
    assert.equal(policy.previousDigest, oldDigest);
    assert.equal(policy.baseTrustBinding.configHash, calculateConfigHash(config));
    assert.equal(revised.goal, f.state.goal);
    await assert.rejects(readRunPolicy(revised, "c".repeat(64)), {code: "RUN_RUNTIME_CHANGED"});
    await assert.rejects(readRunPolicy(revised, "b".repeat(64), Date.parse(policy.expiresAt)), {code: "RUN_POLICY_EXPIRED"});
    await assert.rejects(bindRunPolicy(f.repository, f.state.runId, {config: candidate, baseTrustBinding: f.baseTrustBinding,
      runtimeHash: "b".repeat(64), expectedDigest: oldDigest}), {code: "RUN_POLICY_STALE"});
    await f.repository.mutate(f.state.runId, s => ({...s, workers: [{workerId: "writer", taskId: "task", host: "codex", ownerSessionId: "owner",
      nativeSessionId: "native", nativeJobId: "thread", worktree: f.root, processId: null, processIdentity: null, generation: 1,
      status: "running", leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: "active", lastFailure: null}]}));
    await assert.rejects(bindRunPolicy(f.repository, f.state.runId, {config: candidate, baseTrustBinding: f.baseTrustBinding,
      runtimeHash: "b".repeat(64), expectedDigest: revised.policyBinding!.artifactDigest}), {code: "RUN_POLICY_WRITER_ACTIVE"});
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("authorization audits full redacted scope, is idempotent, binds the current lineage and saves explicit denial", async () => {
  const f = await fixture();
  try {
    await f.repository.mutate(f.state.runId, s => ({...s, workers: [{workerId: "writer", taskId: "task", host: "codex", ownerSessionId: "owner",
      nativeSessionId: "native", nativeJobId: "thread", worktree: f.root, processId: null, processIdentity: null, generation: 1,
      status: "running", leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: "active", lastFailure: null}]}));
    const service = new RunControlService(f.repository);
    const command = "node test.mjs --token=synthetic-secret", resource = "local fixture";
    const authorization: RunCommandAuthorization = {authorizationId: "decision-1", workerId: "writer", generation: 1, nativeSessionId: "native",
      command, resource, commandDigest: sha256(command), resourceDigest: sha256(resource), operation: "command", result: "auto-approved",
      reason: "The native host approved this local check", source: "codex-auto-review", expiresAt: f.state.policyBinding!.expiresAt,
      runtimeHash: "b".repeat(64), policyConfigHash: calculateConfigHash(config), policyArtifactDigest: f.state.policyBinding!.artifactDigest};
    await service.recordAuthorization(f.state.runId, authorization);
    const saved = await service.recordAuthorization(f.state.runId, authorization);
    assert.equal(saved.events.filter(e => e.code === "RUN_COMMAND_AUTO_APPROVED").length, 1);
    const detail = JSON.parse(saved.events.at(-1)!.detail!);
    const artifact = (await readPrivateFile(detail.artifact, f.state.commonDir))!;
    assert.equal(sha256(artifact), detail.digest);
    assert.ok(artifact.includes("node test.mjs"));
    assert.ok(!artifact.includes("synthetic-secret"));
    await assert.rejects(service.recordAuthorization(f.state.runId, {...authorization, authorizationId: "wrong-generation", generation: 2}), {code: "RUN_AUTHORIZATION_STALE"});
    await assert.rejects(service.recordAuthorization(f.state.runId, {...authorization, authorizationId: "wrong-lineage", policyArtifactDigest: "d".repeat(64)}), {code: "RUN_AUTHORIZATION_STALE"});
    await assert.rejects(service.recordAuthorization(f.state.runId, {...authorization, authorizationId: "denied", result: "denied"}), {code: "RUN_COMMAND_DENIED"});
    assert.equal((await f.repository.read(f.state.runId))!.events.at(-1)!.code, "RUN_COMMAND_DENIED");
    const event = (host: "codex" | "claude", payload: NativeGoalEvent["payload"], transportMethod?: string): NativeGoalEvent => ({host, payload,
      ...(transportMethod === undefined ? {} : {transportMethod}), runId: f.state.runId, workerId: "writer", generation: 1,
      contractHash: f.state.goalHash, type: "message", nativeStatus: "active", at: new Date().toISOString(), proof: false});
    await recordNativeRunAuthorization(f.repository, event("claude", {type: "assistant", message: {content: [{type: "tool_use", id: "tool-1", name: "Bash", input: {command: "npm test"}}]}}));
    assert.equal(JSON.parse((await f.repository.read(f.state.runId))!.events.at(-1)!.detail!).result, "unknown");
    await recordNativeRunAuthorization(f.repository, event("codex", {reviewId: "review-1", threadId: "thread", decisionSource: "agent", action: {type: "command", command: "npm test", cwd: f.root}, review: {status: "approved", rationale: "Local tests"}}, "item/autoApprovalReview/completed"));
    assert.equal((await f.repository.read(f.state.runId))!.events.at(-1)!.code, "RUN_COMMAND_AUTO_APPROVED");
  } finally {await rm(f.root, {recursive: true, force: true});}
});
