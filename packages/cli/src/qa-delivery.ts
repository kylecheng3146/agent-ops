import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentOpsConfig, ReviewTargetId } from "../../../runtime/src/contracts.js";
import { calculateConfigHash } from "../../../runtime/src/config/hash.js";
import { sha256 } from "../../../runtime/src/fs/hash.js";
import { AgentOpsError } from "../../../runtime/src/fs/paths.js";
import { qaAuthorHost } from "../../../runtime/src/qa/author.js";
import { runQaDelivery, type QaDeliveryResult } from "../../../runtime/src/qa/delivery.js";
import { qaCommonDirectory, type QaDeliveryScope } from "../../../runtime/src/qa/gate.js";
import { FileQaStore } from "../../../runtime/src/qa/store.js";
import { configuredQaHosts } from "../../../runtime/src/qa/session.js";
import { readCriteriaReview, type CriteriaReviewView } from "../../../runtime/src/review/criteria.js";
import { resolveReviewScope } from "../../../runtime/src/review/scope.js";
import { runSurfaceGate, surfaceAdvisory } from "../../../runtime/src/surface/discovery.js";
import { isCovers } from "../../../runtime/src/surface/schema.js";
import { FileTaskStore, type StoredTaskRecord } from "../../../runtime/src/task/store.js";
import { resolveGitCommit } from "../../../runtime/src/verify/change-surface.js";
import { FileEvidenceStore } from "../../../runtime/src/verify/evidence.js";
import { calculateSourceFingerprint } from "../../../runtime/src/verify/source-fingerprint.js";
import { registeredRunProofRunner } from "../../../runtime/src/verify/spawn.js";
import { sessionIdFromEnvironment } from "../../../runtime/src/hooks/codex-loop.js";
import { loadEffectiveConfig, repositoryTrust, runPolicyContext } from "./context.js";
import { gitRunner } from "./parallel-deps.js";
import { CLI_VERSION } from "./version.js";

const HOSTS: readonly ReviewTargetId[] = ["agy", "claude", "codex"];
const host = (value: string | undefined): ReviewTargetId | null => HOSTS.find(h => h === value) ?? null;

export interface DeliveryQaInput {
  readonly root: string;
  readonly taskId: string;
  /** The same base verify, review and completion measure the candidate against. */
  readonly base?: string;
  readonly scope?: QaDeliveryScope;
  readonly planOnly?: boolean;
  readonly timing?: "early" | "late";
  readonly explicit?: boolean;
  readonly advisory?: CriteriaReviewView | null;
  readonly signal?: AbortSignal;
  /** false: reuse or re-execute only; never start a planner or author session. */
  readonly spend?: boolean;
}

/** The source fingerprint verify and the delivery gate use; before implementation only contracts are bound. */
export async function qaSourceFingerprint(root: string, base: string | undefined, beforeImplementation: boolean): Promise<string> {
  const runner = gitRunner(root);
  try {
    return await calculateSourceFingerprint(root, await resolveReviewScope({root, runner, ...(base === undefined ? {} : {base})}), runner);
  } catch (error) {
    // A plan made before implementation has no change surface yet; it binds contracts, never a candidate's proof.
    if (beforeImplementation && error instanceof AgentOpsError && error.code === "REVIEW_NO_CHANGE_SURFACE")
      return sha256(`qa-plan-candidate:${await resolveGitCommit(runner, "HEAD")}`);
    throw error;
  }
}

/**
 * The review-time surface gate, run before QA spends: the delivery root holds the audit and its
 * direct children must cover it. Anything but PASS throws QA_SURFACE_NOT_READY with the paths to classify.
 */
export async function qaSurfaceCheck(input: {readonly root: string; readonly taskId: string; readonly records: readonly StoredTaskRecord[];
  readonly config: AgentOpsConfig; readonly base?: string}): Promise<void> {
  const holder = input.records.find(r => r.task.id === input.taskId);
  if (holder === undefined) return;
  const children = input.records
    .filter(r => r.task.parentTaskId === input.taskId && r.status !== "archived" && r.supersededBy === undefined &&
      (r.task.surface === undefined || isCovers(r.task.surface)))
    .map(r => ({taskId: r.task.id, covers: r.task.surface !== undefined && isCovers(r.task.surface) ? r.task.surface.covers : []}));
  const scope = await resolveReviewScope({root: input.root, runner: gitRunner(input.root), ...(input.base === undefined ? {} : {base: input.base})});
  const gate = await runSurfaceGate({root: input.root, taskId: input.taskId, surface: holder.task.surface,
    required: holder.task.surfaceRequired === true, children, ...(scope.mode === "base" ? {base: scope.resolvedBase} : {}),
    changedFiles: scope.changedFiles, configHash: calculateConfigHash(input.config)});
  if (gate.status === "PASS") return;
  throw new AgentOpsError("QA_SURFACE_NOT_READY", [`Independent QA for ${input.taskId} was not started: review would stop with ${gate.code}. ` +
    "Classify the surface first (task revise --surface-file), then run QA; a surface-only revise does not void a sealed QA.",
    ...surfaceAdvisory(gate).slice(1)].join("\n"));
}

/**
 * Production QA for one integrated delivery, at a CLI or run boundary (TaskService stays model-free).
 * Returns null for an unenrolled task without loading config or spending anything.
 */
export async function runDeliveryQa(input: DeliveryQaInput): Promise<QaDeliveryResult | null> {
  const {root, taskId} = input;
  const state = await new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root).read();
  const record = state.tasks.find(r => r.task.id === taskId);
  if (record?.task.qa === undefined) return null;
  const config = (await loadEffectiveConfig(root, "project")).config;
  const runner = gitRunner(root);
  const run = await runPolicyContext(root).catch(() => null);
  const implementationHost = host(run?.state.host) ?? host(process.env.AGENT_OPS_HOST);
  const fingerprint = async () => await qaSourceFingerprint(root, input.base, input.planOnly === true);
  return await runQaDelivery({store: new FileQaStore(await qaCommonDirectory(root)), root, rootTaskId: taskId, records: state.tasks, config,
    trusted: await repositoryTrust(root, config, CLI_VERSION) === "TRUSTED", ...(input.scope === undefined ? {} : {scope: input.scope}),
    fingerprint, gitRunner: runner, processRunner: registeredRunProofRunner(), planningRunner: registeredRunProofRunner(),
    evidenceStore: new FileEvidenceStore(root, root), controllerId: `qa-controller-${randomUUID()}`,
    available: configuredQaHosts(config), implementationHost,
    implementationSessionId: run?.state.ownerSessionId ?? sessionIdFromEnvironment() ??
      state.sessions.find(s => s.taskId === taskId)?.sessionId ?? "unrecorded-implementation-session",
    advisory: input.advisory !== undefined ? input.advisory : await readCriteriaReview(root, record.task).catch(() => null), host: kind => qaAuthorHost(kind),
    ...(input.timing === undefined ? {} : {timing: input.timing}), ...(input.planOnly === undefined ? {} : {planOnly: input.planOnly}),
    ...(input.explicit === undefined ? {} : {explicit: input.explicit}), ...(input.signal === undefined ? {} : {signal: input.signal}),
    ...(input.spend === undefined ? {} : {spend: input.spend}),
    surfaceCheck: async () => await qaSurfaceCheck({root, taskId, records: state.tasks, config, ...(input.base === undefined ? {} : {base: input.base})}),
    log: line => process.stderr.write(`${line}\n`)});
}
