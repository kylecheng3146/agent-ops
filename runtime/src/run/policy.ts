import {readdir, readFile, lstat} from "node:fs/promises";
import {isAbsolute, join} from "node:path";
import {fileURLToPath} from "node:url";
import type {AgentOpsConfig} from "../contracts.js";
import {canonicalJson, calculateConfigHash} from "../config/hash.js";
import {mergeConfigLayers} from "../config/merge.js";
import {sha256} from "../fs/hash.js";
import {AgentOpsError} from "../fs/paths.js";
import {evaluateGuardrail} from "../guardrails/evaluate.js";
import {validateConfig} from "../schema/validate.js";
import {readPrivateFile, writePrivateFile} from "../security/permissions.js";
import type {TrustBinding} from "../security/trust.js";
import {redactSecrets} from "../security/redact.js";
import {remainingRunTimeMs} from "./scheduler.js";
import {MAX_EVENTS, type RunRepository, type RunState} from "./service.js";

export interface RunPolicyApproval {readonly capabilityId: string; readonly classification: "non-dangerous"; readonly reason: string;}
export interface RunPolicyArtifact {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly config: AgentOpsConfig;
  readonly baseConfig: AgentOpsConfig;
  readonly baseTrustBinding: TrustBinding;
  readonly runtimeHash: string;
  readonly expiresAt: string;
  readonly issuedAt?: string;
  readonly approvals: readonly RunPolicyApproval[];
  readonly previousDigest: string | null;
}
export const RUN_POLICY_TTL_MS = 60 * 60 * 1000;
function fail(code: string, message: string): never {throw new AgentOpsError(code, message);}
const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function validApprovals(value: unknown): value is readonly RunPolicyApproval[] {
  return Array.isArray(value) && value.length <= 100 && value.every(a => plain(a) &&
    Object.keys(a).every(key => ["capabilityId", "classification", "reason"].includes(key)) &&
    typeof a.capabilityId === "string" && /^(?:command|runner|setup):[^\s\0]{1,128}$/u.test(a.capabilityId) &&
    a.classification === "non-dangerous" && typeof a.reason === "string" && a.reason.trim().length > 0 &&
    a.reason.length <= 4096 && !a.reason.includes("\0"));
}
function validBaseBinding(value: unknown, root: string): value is TrustBinding {
  return plain(value) && Object.keys(value).every(key => ["canonicalPath", "remoteIdentity", "configHash", "runtimeHash"].includes(key)) &&
    value.canonicalPath === root && isAbsolute(root) && typeof value.remoteIdentity === "string" && value.remoteIdentity.length > 0 &&
    typeof value.configHash === "string" && /^[a-f0-9]{64}$/u.test(value.configHash) && typeof value.runtimeHash === "string" && /^[a-f0-9]{64}$/u.test(value.runtimeHash);
}

/** Hash executable toolkit modules, rather than only its package version. */
export async function runRuntimeHash(): Promise<string> {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const entries: {path: string; digest: string}[] = [];
  async function walk(relative: string): Promise<void> {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = join(relative, name), absolute = join(root, path), stat = await lstat(absolute);
      if (stat.isSymbolicLink()) fail("RUN_RUNTIME_CHANGED", "Run runtime cannot contain symlinks.");
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile() && name.endsWith(".js")) entries.push({path, digest: sha256(await readFile(absolute))});
    }
  }
  await walk("runtime"); await walk("packages/cli");
  return sha256(canonicalJson(entries));
}

function capabilities(config: AgentOpsConfig): Map<string, unknown> {
  return new Map<string, unknown>([
    ...config.verification.commands.map(command => ["command:" + command.id, command] as const),
    ...(config.verification.acceptanceRunners ?? []).map(runner => ["runner:" + runner.id, runner] as const),
    ...(config.worktree?.setup ?? []).map((command, index) => ["setup:" + index, command] as const)
  ]);
}

/** A renewal preserves earlier assessments; it does not turn them into user trust. */
export async function runPolicyAssessment(state: RunState, policy: RunPolicyArtifact, capabilityId: string): Promise<RunPolicyApproval | null> {
  const definition = capabilities(policy.config).get(capabilityId);
  if (definition === undefined) fail("RUN_POLICY_APPROVAL_REQUIRED", "Execution capability is absent from the current policy.");
  if (canonicalJson(capabilities(policy.baseConfig).get(capabilityId) ?? null) === canonicalJson(definition)) return null;
  let current = policy;
  for (let depth = 0; depth < 128; depth++) {
    const assessment = current.approvals.find(a => a.capabilityId === capabilityId);
    if (assessment !== undefined && canonicalJson(capabilities(current.config).get(capabilityId) ?? null) === canonicalJson(definition)) return assessment;
    if (current.previousDigest === null) break;
    const source = await readPrivateFile(join(state.commonDir, "agent-ops/runs", state.runId, "policies", current.previousDigest + ".json"), state.commonDir);
    if (source === null || sha256(source) !== current.previousDigest) fail("RUN_POLICY_CHANGED", "Historical capability assessment is missing or changed.");
    const previous = JSON.parse(source) as RunPolicyArtifact;
    current = (await readRunPolicy({...state, policyBinding: {artifactDigest: current.previousDigest, configHash: calculateConfigHash(previous.config),
      runtimeHash: previous.runtimeHash, expiresAt: previous.expiresAt}}, previous.runtimeHash, Date.now(), true))!;
  }
  return fail("RUN_POLICY_APPROVAL_REQUIRED", "The current capability lacks a matching historical run assessment.");
}

/** Existing monotonic policy merging remains authoritative during a run. */
export function validateRunPolicyChange(previous: AgentOpsConfig, candidate: AgentOpsConfig,
  approvals: readonly RunPolicyApproval[]): AgentOpsConfig {
  if (!validateConfig(previous).ok || !validateConfig(candidate).ok) fail("RUN_POLICY_INVALID", "Proposed run policy is invalid.");
  if (!validApprovals(approvals)) fail("RUN_POLICY_APPROVAL_REQUIRED", "Policy assessments require strict bounded capability identities and reasons.");
  for (const field of ["features", "reviewRoles", "securityExceptions"] as const)
    if (canonicalJson(previous[field] ?? null) !== canonicalJson(candidate[field] ?? null))
      fail("RUN_POLICY_GUARDRAIL_CHANGED", "A run cannot change completion, review or security policy.");
  if (previous.worktree?.mode !== candidate.worktree?.mode)
    fail("RUN_POLICY_GUARDRAIL_CHANGED", "A run cannot change worktree isolation.");
  const config = mergeConfigLayers([{source: "user", sourcePath: "run baseline", config: previous},
    {source: "project", sourcePath: "coordinator proposal", config: candidate}]).config;
  const before = capabilities(previous), after = capabilities(config);
  const changed = [...after].filter(([id, value]) => canonicalJson(value) !== canonicalJson(before.get(id) ?? null));
  if (new Set(approvals.map(a => a.capabilityId)).size !== approvals.length || approvals.length !== changed.length)
    fail("RUN_POLICY_APPROVAL_REQUIRED", "Every changed execution capability needs its own run-scoped review.");
  for (const [id, value] of changed) {
    const approval = approvals.find(a => a.capabilityId === id);
    if (approval?.classification !== "non-dangerous" || typeof approval.reason !== "string" ||
      approval.reason.trim().length === 0 || approval.reason.length > 4096 || approval.reason.includes("\0"))
      fail("RUN_POLICY_APPROVAL_REQUIRED", "Changed runner, command and setup definitions require a non-dangerous assessment and reason.");
    const definition = value as {command: string; args: readonly string[]; setup?: readonly {command: string; args: readonly string[]}[];
      build?: readonly {command: string; args: readonly string[]}[]; testBuild?: readonly {command: string; args: readonly string[]}[]};
    for (const command of [definition, ...(definition.setup ?? []), ...(definition.build ?? []), ...(definition.testBuild ?? [])]) {
      const decision = evaluateGuardrail({kind: "command", command: command.command, args: command.args, scope: "."});
      if (decision.action !== "allow") fail("RUN_POLICY_COMMAND_DENIED", "A guarded capability needs explicit user approval; a run cannot grant it automatically.");
    }
  }
  if (evaluateGuardrail({kind: "content", content: canonicalJson(config), scope: "."}).action === "block")
    fail("RUN_POLICY_SECRET", "Policy must use secret references, not literal credentials.");
  return config;
}

export async function readRunPolicy(state: RunState, runtimeHash: string, now = Date.now(), allowExpired = false): Promise<RunPolicyArtifact | null> {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15 - RUN_POLICY_TTL_MS)
    fail("RUN_CLOCK_INVALID", "Policy clock must be a valid nonnegative timestamp with room for a finite grant.");
  const binding = state.policyBinding;
  if (binding === undefined) return null;
  const path = join(state.commonDir, "agent-ops", "runs", state.runId, "policies", binding.artifactDigest + ".json");
  const source = await readPrivateFile(path, state.commonDir);
  if (source === null || Buffer.byteLength(source) > 512 * 1024 || sha256(source) !== binding.artifactDigest)
    fail("RUN_POLICY_CHANGED", "Run policy artifact is missing or changed.");
  let parsed: unknown;
  try {parsed = JSON.parse(source);} catch {return fail("RUN_POLICY_INVALID", "Run policy JSON is invalid.");}
  if (!plain(parsed) || Object.keys(parsed).some(key => !["schemaVersion", "runId", "config", "baseConfig", "baseTrustBinding", "runtimeHash", "expiresAt", "issuedAt", "approvals", "previousDigest"].includes(key)) ||
    !validBaseBinding(parsed.baseTrustBinding, state.root) || !validApprovals(parsed.approvals) ||
    !(parsed.previousDigest === null || (typeof parsed.previousDigest === "string" && /^[a-f0-9]{64}$/u.test(parsed.previousDigest))))
    fail("RUN_POLICY_INVALID", "Run policy artifact has an invalid structure or trust origin.");
  const artifact = parsed as unknown as RunPolicyArtifact;
  const expires = Date.parse(artifact.expiresAt), issued = Date.parse(artifact.issuedAt ?? state.createdAt);
  if (typeof artifact.expiresAt !== "string" || (artifact.issuedAt !== undefined && typeof artifact.issuedAt !== "string") ||
    !Number.isFinite(expires) || !Number.isFinite(issued) || expires <= issued ||
    (artifact.issuedAt !== undefined && expires - issued > RUN_POLICY_TTL_MS))
    fail("RUN_POLICY_INVALID", "Policy requires a valid finite authorization window.");
  if (now < issued) fail("RUN_CLOCK_INVALID", "Policy clock moved behind its issuance; manual reconciliation is required.");
  if (artifact.schemaVersion !== 1 || artifact.runId !== state.runId || !validateConfig(artifact.config).ok ||
    !validateConfig(artifact.baseConfig).ok || calculateConfigHash(artifact.config) !== binding.configHash ||
    artifact.runtimeHash !== binding.runtimeHash || artifact.expiresAt !== binding.expiresAt ||
    artifact.baseTrustBinding?.configHash !== calculateConfigHash(artifact.baseConfig))
    fail("RUN_POLICY_INVALID", "Run policy does not match its ledger binding.");
  if (runtimeHash !== binding.runtimeHash) fail("RUN_RUNTIME_CHANGED", "The executable run runtime changed; preserve the checkout and revalidate before resume.");
  if (!allowExpired && Date.parse(binding.expiresAt) <= now) fail("RUN_POLICY_EXPIRED", "Run-scoped execution authorization expired.");
  return artifact;
}

/** No user/repository trust record is created or changed. */
export async function bindRunPolicy(repository: RunRepository, runId: string, input: {
  config: AgentOpsConfig; baseTrustBinding: TrustBinding; runtimeHash: string; approvals?: readonly RunPolicyApproval[];
  expectedDigest?: string; now?: number; resumeRuntime?: true;
}): Promise<RunState> {
  const state = await repository.read(runId);
  if (state === null) return fail("RUN_NOT_FOUND", "Run does not exist.");
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || !validBaseBinding(input.baseTrustBinding, state.root))
    fail("RUN_POLICY_INVALID", "Policy requires the original canonical repository trust binding and a valid clock.");
  const previous = await readRunPolicy(state, input.resumeRuntime === true ? state.policyBinding?.runtimeHash ?? input.runtimeHash : input.runtimeHash, now, true);
  if ((state.policyBinding?.artifactDigest ?? undefined) !== input.expectedDigest)
    fail("RUN_POLICY_STALE", "The run policy changed before this assessment.");
  if (state.status !== "active" || state.disableRestart || state.awaitingResume)
    fail("RUN_POLICY_DISABLED", "Only an active run can acquire execution authorization.");
  if (state.proofProcess != null)
    fail("RUN_POLICY_WRITER_ACTIVE", "Confirm the registered proof process is dead before rebinding execution policy.");
  if (previous !== null && state.workers.some(w => w.proofProcess != null || !["stopped", "fenced", "delivered", "blocked"].includes(w.status) ||
      (w.processId !== null && w.stopIntent?.confirmedDeadAt == null)))
    fail("RUN_POLICY_WRITER_ACTIVE", "Stop and confirm every writer before changing its execution policy.");
  const config = previous === null ? input.config : validateRunPolicyChange(previous.config, input.config, input.approvals ?? []);
  if (!validateConfig(config).ok || !/^[a-f0-9]{64}$/u.test(input.runtimeHash) ||
    (previous === null && input.baseTrustBinding.configHash !== calculateConfigHash(config)))
    fail("RUN_POLICY_INVALID", "Run policy or runtime identity is invalid.");
  const remaining = remainingRunTimeMs(state, now);
  if (remaining <= 0) fail("RUN_BUDGET_EXHAUSTED", "No active execution budget remains.");
  const artifact: RunPolicyArtifact = {schemaVersion: 1, runId, config, baseConfig: previous?.baseConfig ?? config,
    baseTrustBinding: previous?.baseTrustBinding ?? input.baseTrustBinding, runtimeHash: input.runtimeHash,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + Math.min(remaining, RUN_POLICY_TTL_MS)).toISOString(),
    approvals: (input.approvals ?? []).map(a => ({...a, reason: redactSecrets(a.reason)})), previousDigest: previous === null ? null : state.policyBinding!.artifactDigest};
  const content = canonicalJson(artifact), digest = sha256(content);
  await writePrivateFile(join(state.commonDir, "agent-ops", "runs", runId, "policies", digest + ".json"), content, state.commonDir);
  return await repository.mutate(runId, current => {
    if (current.revision !== state.revision || (current.policyBinding?.artifactDigest ?? undefined) !== input.expectedDigest || current.status !== "active" || current.disableRestart)
      return fail("RUN_POLICY_STALE", "The run stopped or its policy changed during assessment.");
    return {...current, policyBinding: {configHash: calculateConfigHash(config), runtimeHash: input.runtimeHash,
      artifactDigest: digest, expiresAt: artifact.expiresAt}};
  });
}

/** Renew the same finite grant without changing native identities, scope or trust. Reads never renew. */
export async function renewRunPolicy(repository: RunRepository, runId: string, input: {
  readonly now?: number;
  readonly authority: () => Promise<{config: AgentOpsConfig; baseTrustBinding: TrustBinding; runtimeHash: string; trusted: boolean}>;
}): Promise<RunState> {
  const state = await repository.read(runId);
  if (state === null) return fail("RUN_NOT_FOUND", "Run does not exist.");
  if (state.status !== "active" || state.disableRestart || state.awaitingResume || state.events.some(e => e.code === "RUN_COMMAND_DENIED"))
    return fail("RUN_POLICY_DISABLED", "Renewal cannot awaken a stopped run or erase a denial.");
  const now = input.now ?? Date.now();
  if (now < Date.parse(state.budget.lastObservedAt)) return fail("RUN_CLOCK_INVALID", "Policy clock moved behind the last observed accounting time.");
  const authority = await input.authority();
  const previous = await readRunPolicy(state, authority.runtimeHash, now, true);
  if (previous === null) return fail("RUN_POLICY_INVALID", "Renewal requires an existing bound authorization.");
  const assertAuthority = (current: Awaited<ReturnType<typeof input.authority>>): void => {
    if (!current.trusted || current.runtimeHash !== previous.runtimeHash ||
      canonicalJson(current.baseTrustBinding) !== canonicalJson(previous.baseTrustBinding) ||
      calculateConfigHash(current.config) !== calculateConfigHash(previous.baseConfig))
      fail("RUN_POLICY_AUTHORITY_CHANGED", "Original trust, repository configuration or executable runtime changed; obtain genuine authorization before resume.");
  };
  assertAuthority(authority);
  if (Date.parse(previous.expiresAt) > now) return state;
  if (remainingRunTimeMs(state, now) <= 0) return fail("RUN_BUDGET_EXHAUSTED", "Legacy finite runs require manual resume before renewal.");
  const artifact: RunPolicyArtifact = {...previous, issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.min(RUN_POLICY_TTL_MS, remainingRunTimeMs(state, now))).toISOString(),
    previousDigest: state.policyBinding!.artifactDigest};
  const content = canonicalJson(artifact), digest = sha256(content);
  await writePrivateFile(join(state.commonDir, "agent-ops", "runs", runId, "policies", digest + ".json"), content, state.commonDir);
  assertAuthority(await input.authority());
  return await repository.mutate(runId, current => {
    if (current.revision !== state.revision || current.status !== "active" || current.disableRestart || current.awaitingResume ||
      current.policyBinding?.artifactDigest !== state.policyBinding!.artifactDigest || current.events.some(e => e.code === "RUN_COMMAND_DENIED"))
      return fail("RUN_POLICY_STALE", "Run stop, denial or scope changed during renewal.");
    return {...current, policyBinding: {...state.policyBinding!, artifactDigest: digest, expiresAt: artifact.expiresAt},
      events: [...current.events, {id: `renewal-${digest.slice(0, 32)}`, at: artifact.issuedAt!, type: "diagnostic" as const,
        code: "RUN_POLICY_RENEWED", workerId: null, taskId: null, detail: `Same-authority finite grant renewed from ${state.policyBinding!.artifactDigest}.`}].slice(-MAX_EVENTS)};
  });
}
