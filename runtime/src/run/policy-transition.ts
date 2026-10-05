import {randomUUID} from "node:crypto";
import {readdir} from "node:fs/promises";
import {join} from "node:path";

import {canonicalJson} from "../config/hash.js";
import {sha256} from "../fs/hash.js";
import {AgentOpsError} from "../fs/paths.js";
import {
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFile
} from "../security/permissions.js";
import type {
  RunRepository,
  RunState,
  RunStopIntent,
  RunTaskNode,
  RunWorkerRecord
} from "./service.js";

/**
 * A policy transition is deliberately a small journal rather than another
 * run store.  The policy module owns the policy artifact; this module only
 * records the identities that must be fenced and the synchronization proof
 * that the coordinator supplies.
 */
export const POLICY_TRANSITION_STAGES = [
  "prepared",
  "fenced",
  "bound",
  "synchronized",
  "complete"
] as const;

export type PolicyTransitionStage = typeof POLICY_TRANSITION_STAGES[number];

export interface PolicyTransitionArtifactRef {
  readonly artifactDigest: string;
  readonly artifactPath: string;
  readonly configHash: string;
  readonly runtimeHash: string;
  readonly expiresAt: string;
}

export interface PolicyTransitionWorkerGeneration {
  readonly workerId: string;
  readonly generation: number;
}

export interface PolicyTransitionWorkerSnapshot {
  readonly workerId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly status: string;
  readonly nativeSessionId: string | null;
  readonly nativeJobId: string | null;
  readonly processId: number | null;
  readonly processIdentity: string | null;
  readonly deliveryDigest: string | null;
  readonly sourceCommit: string | null;
  readonly stopIntent: RunStopIntent | null;
}

export interface PolicyTransitionTaskSnapshot {
  readonly taskId: string;
  readonly status: string;
  readonly workerId: string | null;
  readonly deliveryDigest: string | null;
  readonly sourceCommit: string | null;
  readonly planDigest: string | null;
}

/** Native identities that the coordinator may resume after the transition. */
export interface PolicyTransitionResumeId {
  readonly workerId: string;
  readonly generation: number;
  readonly nativeSessionId: string | null;
  readonly nativeJobId: string | null;
}

/** Delivery identities are historical facts and are never removed by a transition. */
export interface PolicyTransitionDeliveredMarker {
  readonly workerId: string;
  readonly taskId: string;
  readonly generation: number;
  readonly deliveryDigest: string | null;
  readonly sourceCommit: string | null;
}

export interface PolicyTransitionStageRecord {
  readonly stage: PolicyTransitionStage;
  readonly at: string;
  readonly previousStageDigest: string | null;
  readonly stageDigest: string;
  readonly newPolicyArtifact?: PolicyTransitionArtifactRef;
  readonly contractHash?: string | null;
  readonly contractRevision?: number;
  readonly taskIds?: readonly string[];
  readonly synchronizationDigest?: string;
}

/**
 * The complete private journal.  It is rewritten atomically as stages are
 * appended, while every stage keeps its own digest so old references remain
 * verifiable after a later stage is recorded.
 */
export interface PolicyTransitionJournal {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly transitionId: string;
  readonly createdAt: string;
  readonly baseRevision: number;
  readonly oldPolicyArtifact: PolicyTransitionArtifactRef | null;
  readonly newPolicyArtifact: PolicyTransitionArtifactRef | null;
  readonly oldContractHash: string | null;
  readonly oldContractRevision: number;
  readonly taskIds: readonly string[];
  readonly tasks: readonly PolicyTransitionTaskSnapshot[];
  readonly workerGenerations: readonly PolicyTransitionWorkerGeneration[];
  readonly workers: readonly PolicyTransitionWorkerSnapshot[];
  readonly resumeIds: readonly PolicyTransitionResumeId[];
  readonly deliveredMarkers: readonly PolicyTransitionDeliveredMarker[];
  readonly stages: readonly PolicyTransitionStageRecord[];
  readonly artifactDigest: string;
}

export interface BeginPolicyTransitionInput {
  /** Supplying the same ID makes a retry after a crash idempotent. */
  readonly transitionId?: string;
  /** The caller may fence against a policy digest read earlier in the loop. */
  readonly expectedOldArtifactDigest?: string | null;
  readonly expectedContractHash?: string | null;
  readonly now?: string;
}

export interface MarkPolicyTransitionStageInput {
  readonly stage: Exclude<PolicyTransitionStage, "prepared">;
  /** Required for bound/synchronized. If omitted, it is derived from current state. */
  readonly newPolicyArtifact?: PolicyTransitionArtifactRef;
  readonly contractHash?: string | null;
  readonly contractRevision?: number;
  readonly taskIds?: readonly string[];
  readonly synchronizationDigest?: string;
  readonly now?: string;
}

export interface CompletePolicyTransitionInput {
  readonly synchronizationDigest?: string;
  readonly now?: string;
}

type PolicyAwareRunState = RunState;

interface StageCore {
  readonly stage: PolicyTransitionStage;
  readonly at: string;
  readonly previousStageDigest?: string | null;
  readonly newPolicyArtifact?: PolicyTransitionArtifactRef;
  readonly contractHash?: string | null;
  readonly contractRevision?: number;
  readonly taskIds?: readonly string[];
  readonly synchronizationDigest?: string;
}

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9._-]{1,128}$/u;
const MAX_ARTIFACT_BYTES = 512 * 1024;
const MAX_ITEMS = 512;
const ACTIVE_WORKER_STATUSES = new Set([
  "assigned",
  "starting",
  "running",
  "idle",
  "handing-off"
]);
const FENCED_WORKER_STATUSES = new Set(["fenced", "stopped", "delivered", "blocked"]);

function fail(code: string, message: string): never {
  throw new AgentOpsError(code, message);
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    return fail("RUN_POLICY_TRANSITION_INVALID", `${label} must be a bounded non-empty string.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedText(value, label, 64);
  if (!Number.isFinite(Date.parse(text))) return fail("RUN_POLICY_TRANSITION_INVALID", `${label} must be an ISO timestamp.`);
  return text;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    return fail("RUN_POLICY_TRANSITION_INVALID", `${label} must be a SHA-256 digest.`);
  }
  return value;
}

function transitionId(value: unknown): string {
  const id = boundedText(value, "transitionId", 128);
  if (!ID.test(id)) return fail("RUN_POLICY_TRANSITION_INVALID", "Transition ID contains an unsafe path character.");
  return id;
}

function nowIso(value: string | undefined): string {
  return timestamp(value ?? new Date().toISOString(), "transition timestamp");
}

function stateWithPolicy(state: RunState): PolicyAwareRunState {
  return state as PolicyAwareRunState;
}

function policyPath(runId: string, artifactDigest: string): string {
  return `agent-ops/runs/${runId}/policies/${artifactDigest}.json`;
}

function transitionPath(runId: string, id: string): string {
  return join("agent-ops", "runs", runId, "policy-transitions", `${id}.json`);
}

function transitionAbsolutePath(state: RunState, id: string): string {
  return join(state.commonDir, transitionPath(state.runId, id));
}

function transitionDirectory(state: RunState): string {
  return join(state.commonDir, "agent-ops", "runs", state.runId, "policy-transitions");
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function validArtifactPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 4096 && !path.includes("\0") &&
    !path.startsWith("/") && !path.includes("\\") && !path.split("/").some(segment => segment === "" || segment === "." || segment === "..");
}

function artifactReference(value: unknown, label: string): PolicyTransitionArtifactRef {
  if (!plain(value) || Object.keys(value).sort().join(",") !== "artifactDigest,artifactPath,configHash,expiresAt,runtimeHash" ||
      !HASH.test(String(value.artifactDigest)) || !HASH.test(String(value.configHash)) || !HASH.test(String(value.runtimeHash)) ||
      !validArtifactPath(value.artifactPath) || typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt))) {
    return fail("RUN_POLICY_TRANSITION_INVALID", `${label} is not a valid policy artifact reference.`);
  }
  const artifactDigest = value.artifactDigest as string;
  const artifactPath = value.artifactPath as string;
  const configHash = value.configHash as string;
  const runtimeHash = value.runtimeHash as string;
  const expiresAt = value.expiresAt as string;
  return {
    artifactDigest,
    artifactPath,
    configHash,
    runtimeHash,
    expiresAt
  };
}

function policyArtifactRefFromState(state: RunState): PolicyTransitionArtifactRef | null {
  const binding = stateWithPolicy(state).policyBinding;
  if (binding === undefined || binding === null) return null;
  if (!plain(binding) ||
      typeof binding.artifactDigest !== "string" || typeof binding.configHash !== "string" ||
      typeof binding.runtimeHash !== "string" || typeof binding.expiresAt !== "string") {
    return fail("RUN_POLICY_TRANSITION_INVALID", "Run policy binding is malformed.");
  }
  return artifactReference({
    artifactDigest: binding.artifactDigest,
    artifactPath: policyPath(state.runId, binding.artifactDigest),
    configHash: binding.configHash,
    runtimeHash: binding.runtimeHash,
    expiresAt: binding.expiresAt
  }, "run policy binding");
}

/** Return the non-secret policy identity currently bound to a run. */
export function currentPolicyArtifact(state: RunState): PolicyTransitionArtifactRef | null {
  return policyArtifactRefFromState(state);
}

function artifactMatches(left: PolicyTransitionArtifactRef | null, right: PolicyTransitionArtifactRef | null): boolean {
  return sameJson(left, right);
}

function cloneStopIntent(intent: RunStopIntent | null): RunStopIntent | null {
  return intent === null ? null : {
    runId: intent.runId,
    workerId: intent.workerId,
    generation: intent.generation,
    nativeSessionId: intent.nativeSessionId,
    reason: intent.reason,
    deliveryDigest: intent.deliveryDigest,
    contractDigest: intent.contractDigest,
    sourceCommit: intent.sourceCommit,
    expiresAt: intent.expiresAt,
    confirmedDeadAt: intent.confirmedDeadAt
  };
}

function workerSnapshot(worker: RunWorkerRecord): PolicyTransitionWorkerSnapshot {
  return {
    workerId: worker.workerId,
    taskId: worker.taskId,
    generation: worker.generation,
    status: worker.status,
    nativeSessionId: worker.nativeSessionId,
    nativeJobId: worker.nativeJobId,
    processId: worker.processId,
    processIdentity: worker.processIdentity,
    deliveryDigest: worker.stopIntent?.deliveryDigest ?? null,
    sourceCommit: worker.stopIntent?.sourceCommit ?? null,
    stopIntent: cloneStopIntent(worker.stopIntent)
  };
}

function taskSnapshot(task: RunTaskNode): PolicyTransitionTaskSnapshot {
  return {
    taskId: task.taskId,
    status: task.status,
    workerId: task.workerId,
    deliveryDigest: task.deliveryDigest,
    sourceCommit: task.sourceCommit,
    planDigest: task.planDigest ?? null
  };
}

function snapshotWorkers(state: RunState): readonly PolicyTransitionWorkerSnapshot[] {
  return [...state.workers].sort((left, right) => left.workerId.localeCompare(right.workerId)).map(workerSnapshot);
}

function snapshotTasks(state: RunState): readonly PolicyTransitionTaskSnapshot[] {
  return [...state.tasks].sort((left, right) => left.taskId.localeCompare(right.taskId)).map(taskSnapshot);
}

function resumeIds(state: RunState): readonly PolicyTransitionResumeId[] {
  return [...state.workers]
    .filter(worker => ACTIVE_WORKER_STATUSES.has(worker.status))
    .sort((left, right) => left.workerId.localeCompare(right.workerId))
    .map(worker => ({
      workerId: worker.workerId,
      generation: worker.generation,
      nativeSessionId: worker.nativeSessionId,
      nativeJobId: worker.nativeJobId
    }));
}

function deliveredMarkers(state: RunState): readonly PolicyTransitionDeliveredMarker[] {
  return [...state.workers]
    .filter(worker => worker.status === "delivered" || state.tasks.some(task => task.workerId === worker.workerId && task.status === "delivered"))
    .sort((left, right) => left.workerId.localeCompare(right.workerId))
    .map(worker => ({
      workerId: worker.workerId,
      taskId: worker.taskId,
      generation: worker.generation,
      deliveryDigest: state.tasks.find(task => task.taskId === worker.taskId)?.deliveryDigest ?? worker.stopIntent?.deliveryDigest ?? null,
      sourceCommit: state.tasks.find(task => task.taskId === worker.taskId)?.sourceCommit ?? worker.stopIntent?.sourceCommit ?? null
    }));
}

function stageCore(value: StageCore): PolicyTransitionStageRecord {
  const normalized: StageCore & {readonly previousStageDigest: string | null} = {
    ...value,
    previousStageDigest: value.previousStageDigest ?? null
  };
  const stageDigest = sha256(canonicalJson(normalized));
  return {...normalized, stageDigest};
}

function sealJournal(journal: Omit<PolicyTransitionJournal, "artifactDigest">): PolicyTransitionJournal {
  return {...journal, artifactDigest: sha256(canonicalJson(journal))};
}

function stageCode(stage: PolicyTransitionStage): string {
  return `RUN_POLICY_TRANSITION_${stage.toUpperCase()}`;
}

function eventDetail(journal: PolicyTransitionJournal): string {
  const latest = journal.stages[journal.stages.length - 1];
  if (latest === undefined) return fail("RUN_POLICY_TRANSITION_INVALID", "Transition journal has no stage.");
  return canonicalJson({
    transitionId: journal.transitionId,
    stage: latest.stage,
    artifactPath: transitionPath(journal.runId, journal.transitionId),
    artifactDigest: journal.artifactDigest,
    stageDigest: latest.stageDigest
  });
}

function transitionEvent(journal: PolicyTransitionJournal): RunState["events"][number] {
  const latest = journal.stages[journal.stages.length - 1];
  if (latest === undefined) return fail("RUN_POLICY_TRANSITION_INVALID", "Transition journal has no stage.");
  return {
    id: randomUUID(),
    at: latest.at,
    type: "control",
    code: stageCode(latest.stage),
    workerId: null,
    taskId: null,
    detail: eventDetail(journal)
  };
}

function hasStageReference(state: RunState, journal: PolicyTransitionJournal): boolean {
  const latest = journal.stages[journal.stages.length - 1];
  return latest !== undefined && state.events.some(event => {
    if (event.code !== stageCode(latest.stage) || event.detail === null) return false;
    try {
      const detail = JSON.parse(event.detail) as Record<string, unknown>;
      return detail.transitionId === journal.transitionId && detail.stageDigest === latest.stageDigest &&
        detail.artifactDigest === journal.artifactDigest;
    } catch {
      return false;
    }
  });
}

function withTransitionEvent(state: RunState, journal: PolicyTransitionJournal): RunState {
  if (hasStageReference(state, journal)) return state;
  return {
    ...state,
    events: [...state.events, transitionEvent(journal)].slice(-2_000)
  };
}

function stageIndex(stage: PolicyTransitionStage): number {
  return POLICY_TRANSITION_STAGES.indexOf(stage);
}

function stageAt(journal: PolicyTransitionJournal): PolicyTransitionStage {
  const stage = journal.stages[journal.stages.length - 1]?.stage;
  if (stage === undefined) return fail("RUN_POLICY_TRANSITION_INVALID", "Transition journal has no current stage.");
  return stage;
}

function validateTaskIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS || value.some(item => typeof item !== "string" || !ID.test(item))) {
    return fail("RUN_POLICY_TRANSITION_INVALID", `${label} contains invalid task IDs.`);
  }
  return [...value].sort();
}

function validateStage(value: unknown, label: string): PolicyTransitionStage {
  if (typeof value !== "string" || !POLICY_TRANSITION_STAGES.includes(value as PolicyTransitionStage)) {
    return fail("RUN_POLICY_TRANSITION_INVALID", `${label} is not a supported transition stage.`);
  }
  return value as PolicyTransitionStage;
}

function validateStageRecord(value: unknown, previous: PolicyTransitionStageRecord | null): PolicyTransitionStageRecord {
  if (!plain(value)) return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Transition stage is not an object.");
  const stage = validateStage(value.stage, "stage");
  const at = timestamp(value.at, "stage.at");
  const previousStageDigest = value.previousStageDigest === null ? null : digest(value.previousStageDigest, "stage.previousStageDigest");
  const contractRevision = value.contractRevision;
  if (contractRevision !== undefined && (!Number.isSafeInteger(contractRevision) || (contractRevision as number) < 0)) {
    return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Stage contract revision is invalid.");
  }
  const core: StageCore = {
    stage,
    at,
    previousStageDigest,
    ...(value.newPolicyArtifact === undefined ? {} : {newPolicyArtifact: artifactReference(value.newPolicyArtifact, "stage.newPolicyArtifact")}),
    ...(value.contractHash === undefined ? {} : {contractHash: value.contractHash === null ? null : digest(value.contractHash, "stage.contractHash")}),
    ...(contractRevision === undefined ? {} : {contractRevision: contractRevision as number}),
    ...(value.taskIds === undefined ? {} : {taskIds: validateTaskIds(value.taskIds, "stage.taskIds")}),
    ...(value.synchronizationDigest === undefined ? {} : {synchronizationDigest: digest(value.synchronizationDigest, "stage.synchronizationDigest")})
  };
  const stageDigest = digest(value.stageDigest, "stage.stageDigest");
  if (stageDigest !== sha256(canonicalJson(core))) return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Transition stage digest does not match its contents.");
  if ((previous?.stageDigest ?? null) !== previousStageDigest) return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Transition stage chain is broken.");
  return {...core, previousStageDigest, stageDigest};
}

function validateSnapshotArray(value: unknown, label: string): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS || value.some(item => !plain(item))) {
    return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", `${label} is invalid.`);
  }
  return value as readonly Record<string, unknown>[];
}

function nullableSnapshotText(value: unknown, label: string, max = 4096): string | null {
  return value === null ? null : boundedText(value, label, max);
}

function validateTaskSnapshots(value: unknown): readonly PolicyTransitionTaskSnapshot[] {
  return validateSnapshotArray(value, "journal.tasks").map(item => {
    if (!ID.test(String(item.taskId)) || typeof item.status !== "string" || item.status.length > 128 ||
        (item.workerId !== null && !ID.test(String(item.workerId))) ||
        (item.planDigest !== null && !HASH.test(String(item.planDigest)))) {
      return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "A task snapshot is invalid.");
    }
    return {
      taskId: item.taskId as string,
      status: item.status,
      workerId: item.workerId as string | null,
      deliveryDigest: nullableSnapshotText(item.deliveryDigest, "task.deliveryDigest", 128),
      sourceCommit: nullableSnapshotText(item.sourceCommit, "task.sourceCommit", 128),
      planDigest: item.planDigest as string | null
    };
  });
}

function validateWorkerSnapshots(value: unknown): readonly PolicyTransitionWorkerSnapshot[] {
  return validateSnapshotArray(value, "journal.workers").map(item => {
    if (!ID.test(String(item.workerId)) || !ID.test(String(item.taskId)) || !Number.isSafeInteger(item.generation) ||
        (item.generation as number) < 1 || typeof item.status !== "string" || item.status.length > 128 ||
        (item.processId !== null && (!Number.isSafeInteger(item.processId) || (item.processId as number) < 1))) {
      return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "A worker snapshot is invalid.");
    }
    let stopIntent: RunStopIntent | null = null;
    if (item.stopIntent !== null) {
      if (!plain(item.stopIntent) || !ID.test(String(item.stopIntent.workerId)) || !Number.isSafeInteger(item.stopIntent.generation) ||
          (item.stopIntent.generation as number) < 1 || typeof item.stopIntent.runId !== "string" ||
          !["handoff", "stop", "budget", "no-progress", "crash"].includes(String(item.stopIntent.reason))) {
        return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "A worker stop intent is invalid.");
      }
      stopIntent = item.stopIntent as unknown as RunStopIntent;
    }
    return {
      workerId: item.workerId as string,
      taskId: item.taskId as string,
      generation: item.generation as number,
      status: item.status,
      nativeSessionId: nullableSnapshotText(item.nativeSessionId, "worker.nativeSessionId"),
      nativeJobId: nullableSnapshotText(item.nativeJobId, "worker.nativeJobId"),
      processId: item.processId as number | null,
      processIdentity: nullableSnapshotText(item.processIdentity, "worker.processIdentity"),
      deliveryDigest: nullableSnapshotText(item.deliveryDigest, "worker.deliveryDigest", 128),
      sourceCommit: nullableSnapshotText(item.sourceCommit, "worker.sourceCommit", 128),
      stopIntent
    };
  });
}

function validateWorkerGenerations(value: unknown): readonly PolicyTransitionWorkerGeneration[] {
  return validateSnapshotArray(value, "journal.workerGenerations").map(item => {
    if (!ID.test(String(item.workerId)) || !Number.isSafeInteger(item.generation) || (item.generation as number) < 1) {
      return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "A worker generation snapshot is invalid.");
    }
    return {workerId: item.workerId as string, generation: item.generation as number};
  });
}

function validateResumeIds(value: unknown): readonly PolicyTransitionResumeId[] {
  return validateSnapshotArray(value, "journal.resumeIds").map(item => {
    if (!ID.test(String(item.workerId)) || !Number.isSafeInteger(item.generation) || (item.generation as number) < 1) {
      return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "A resume identity is invalid.");
    }
    return {
      workerId: item.workerId as string,
      generation: item.generation as number,
      nativeSessionId: nullableSnapshotText(item.nativeSessionId, "resume.nativeSessionId"),
      nativeJobId: nullableSnapshotText(item.nativeJobId, "resume.nativeJobId")
    };
  });
}

function validateDeliveredMarkers(value: unknown): readonly PolicyTransitionDeliveredMarker[] {
  return validateSnapshotArray(value, "journal.deliveredMarkers").map(item => {
    if (!ID.test(String(item.workerId)) || !ID.test(String(item.taskId)) || !Number.isSafeInteger(item.generation) || (item.generation as number) < 1) {
      return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "A delivered marker is invalid.");
    }
    return {
      workerId: item.workerId as string,
      taskId: item.taskId as string,
      generation: item.generation as number,
      deliveryDigest: nullableSnapshotText(item.deliveryDigest, "delivery.deliveryDigest", 128),
      sourceCommit: nullableSnapshotText(item.sourceCommit, "delivery.sourceCommit", 128)
    };
  });
}

function validateJournal(value: unknown, expectedRunId: string, expectedTransitionId?: string): PolicyTransitionJournal {
  if (!plain(value) || value.schemaVersion !== 1 || value.runId !== expectedRunId ||
      (expectedTransitionId !== undefined && value.transitionId !== expectedTransitionId)) {
    return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Transition journal identity is invalid.");
  }
  const id = transitionId(value.transitionId);
  const createdAt = timestamp(value.createdAt, "journal.createdAt");
  if (!Number.isSafeInteger(value.baseRevision) || (value.baseRevision as number) < 0) {
    return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Transition journal base revision is invalid.");
  }
  const oldPolicyArtifact = value.oldPolicyArtifact === null ? null : artifactReference(value.oldPolicyArtifact, "journal.oldPolicyArtifact");
  const newPolicyArtifact = value.newPolicyArtifact === null ? null : artifactReference(value.newPolicyArtifact, "journal.newPolicyArtifact");
  const oldContractHash = value.oldContractHash === null ? null : digest(value.oldContractHash, "journal.oldContractHash");
  if (!Number.isSafeInteger(value.oldContractRevision) || (value.oldContractRevision as number) < 0) {
    return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Transition journal contract revision is invalid.");
  }
  const taskIds = validateTaskIds(value.taskIds, "journal.taskIds");
  const tasks = validateTaskSnapshots(value.tasks);
  const workers = validateWorkerSnapshots(value.workers);
  const workerGenerations = validateWorkerGenerations(value.workerGenerations);
  const resumeIds = validateResumeIds(value.resumeIds);
  const deliveredMarkers = validateDeliveredMarkers(value.deliveredMarkers);
  if (!sameJson(tasks.map(task => task.taskId).sort(), taskIds) ||
      !sameJson(workerGenerations, workers.map(worker => ({workerId: worker.workerId, generation: worker.generation})).sort((left, right) => left.workerId.localeCompare(right.workerId)))) {
    return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Transition snapshot indexes do not match their records.");
  }
  if (!Array.isArray(value.stages) || value.stages.length < 1 || value.stages.length > POLICY_TRANSITION_STAGES.length) {
    return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Transition journal stages are invalid.");
  }
  const stages: PolicyTransitionStageRecord[] = [];
  for (const [index, raw] of value.stages.entries()) {
    const previous = stages[index - 1] ?? null;
    const stage = validateStageRecord(raw, previous);
    if (stage.stage !== POLICY_TRANSITION_STAGES[index]) {
      return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Transition stages are not monotonic.");
    }
    stages.push(stage);
  }
  if (stages[0]?.stage !== "prepared") return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Transition must start at prepared.");
  const boundStage = stages.find(stage => stage.stage === "bound");
  const synchronizedStage = stages.find(stage => stage.stage === "synchronized");
  if (boundStage !== undefined && (boundStage.newPolicyArtifact === undefined || newPolicyArtifact === null)) {
    return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Bound transition is missing its new policy artifact.");
  }
  if (newPolicyArtifact !== null && boundStage !== undefined && !artifactMatches(newPolicyArtifact, boundStage.newPolicyArtifact!)) {
    return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "New policy artifact does not match the bound stage.");
  }
  if (synchronizedStage !== undefined &&
      (synchronizedStage.contractHash === undefined || synchronizedStage.contractRevision === undefined ||
       synchronizedStage.taskIds === undefined || synchronizedStage.synchronizationDigest === undefined)) {
    return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Synchronized stage is missing its contract/task proof.");
  }
  const withoutDigest = {...value} as Omit<PolicyTransitionJournal, "artifactDigest"> & {artifactDigest?: unknown};
  delete withoutDigest.artifactDigest;
  const artifactDigest = digest(value.artifactDigest, "journal.artifactDigest");
  if (artifactDigest !== sha256(canonicalJson(withoutDigest))) {
    return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Transition journal digest does not match its contents.");
  }
  return {
    schemaVersion: 1,
    runId: expectedRunId,
    transitionId: id,
    createdAt,
    baseRevision: value.baseRevision as number,
    oldPolicyArtifact,
    newPolicyArtifact,
    oldContractHash,
    oldContractRevision: value.oldContractRevision as number,
    taskIds,
    tasks: tasks as unknown as readonly PolicyTransitionTaskSnapshot[],
    workerGenerations: workerGenerations as unknown as readonly PolicyTransitionWorkerGeneration[],
    workers: workers as unknown as readonly PolicyTransitionWorkerSnapshot[],
    resumeIds: resumeIds as unknown as readonly PolicyTransitionResumeId[],
    deliveredMarkers: deliveredMarkers as unknown as readonly PolicyTransitionDeliveredMarker[],
    stages,
    artifactDigest
  };
}

async function readJournal(state: RunState, id: string): Promise<PolicyTransitionJournal | null> {
  const source = await readPrivateFile(transitionAbsolutePath(state, id), state.commonDir);
  if (source === null) return null;
  if (Buffer.byteLength(source, "utf8") > MAX_ARTIFACT_BYTES) return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Transition journal exceeds the bounded size.");
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (cause) {
    return fail("RUN_POLICY_TRANSITION_ARTIFACT_CHANGED", "Transition journal is not valid JSON.");
  }
  return validateJournal(value, state.runId, id);
}

async function writeJournal(state: RunState, journal: PolicyTransitionJournal): Promise<void> {
  await writePrivateFile(transitionAbsolutePath(state, journal.transitionId), canonicalJson(journal), state.commonDir);
}

function stateTaskIds(state: RunState): readonly string[] {
  return [...state.tasks].map(task => task.taskId).sort();
}

function stateWorkerMap(state: RunState): Map<string, RunWorkerRecord> {
  return new Map(state.workers.map(worker => [worker.workerId, worker]));
}

function journalWorkerMap(journal: PolicyTransitionJournal): Map<string, PolicyTransitionWorkerSnapshot> {
  return new Map(journal.workers.map(worker => [worker.workerId, worker]));
}

function assertWorkerIdentity(state: RunState, journal: PolicyTransitionJournal): void {
  const current = stateWorkerMap(state);
  const expected = journalWorkerMap(journal);
  for (const worker of journal.workerGenerations) {
    const saved = current.get(worker.workerId);
    const captured = expected.get(worker.workerId);
    if (saved === undefined || saved.generation !== worker.generation || captured === undefined || saved.taskId !== captured.taskId) {
      fail("RUN_POLICY_TRANSITION_STALE", `Worker ${worker.workerId} changed during the policy transition.`);
    }
  }
  for (const worker of state.workers) {
    if (!expected.has(worker.workerId) && ACTIVE_WORKER_STATUSES.has(worker.status)) {
      fail("RUN_POLICY_TRANSITION_WRITER_ACTIVE", `A worker not captured by the transition is active: ${worker.workerId}.`);
    }
  }
}

function assertTaskTree(state: RunState, journal: PolicyTransitionJournal): void {
  if (!sameJson(stateTaskIds(state), journal.taskIds)) {
    fail("RUN_POLICY_TRANSITION_STALE", "Run task tree changed during the policy transition.");
  }
}

function assertOldContract(state: RunState, journal: PolicyTransitionJournal): void {
  assertTaskTree(state, journal);
  if (state.currentContractHash !== journal.oldContractHash || state.contractRevision !== journal.oldContractRevision) {
    fail("RUN_POLICY_TRANSITION_STALE", "Run contract changed before policy binding.");
  }
}

function assertWritersFenced(state: RunState, journal: PolicyTransitionJournal): void {
  assertWorkerIdentity(state, journal);
  const expected = journalWorkerMap(journal);
  for (const worker of state.workers) {
    if (!expected.has(worker.workerId)) continue;
    if (ACTIVE_WORKER_STATUSES.has(worker.status) || !FENCED_WORKER_STATUSES.has(worker.status)) {
      fail("RUN_POLICY_TRANSITION_FENCE_REQUIRED", `Worker ${worker.workerId} is not fenced.`);
    }
    if (worker.processId !== null && worker.stopIntent?.confirmedDeadAt == null) {
      fail("RUN_POLICY_TRANSITION_FENCE_REQUIRED", `Worker ${worker.workerId} has no confirmed process death.`);
    }
    if (worker.proofProcess != null) fail("RUN_POLICY_TRANSITION_FENCE_REQUIRED", "Worker proof process death must be confirmed before policy changes.");
  }
}

function assertCurrentPolicy(state: RunState, expected: PolicyTransitionArtifactRef | null): void {
  if (!artifactMatches(policyArtifactRefFromState(state), expected)) {
    fail("RUN_POLICY_TRANSITION_STALE", "The run policy binding does not match the transition journal.");
  }
}

function validateSynchronizationInput(state: RunState, journal: PolicyTransitionJournal, input: MarkPolicyTransitionStageInput): {
  readonly contractHash: string | null;
  readonly contractRevision: number;
  readonly taskIds: readonly string[];
  readonly synchronizationDigest: string;
} {
  if (!Object.prototype.hasOwnProperty.call(input, "contractHash") || input.contractHash === undefined ||
      !Object.prototype.hasOwnProperty.call(input, "contractRevision") || input.contractRevision === undefined ||
      !Object.prototype.hasOwnProperty.call(input, "taskIds") || input.taskIds === undefined) {
    fail("RUN_POLICY_TRANSITION_SYNC_REQUIRED", "Synchronization must provide the current contract revision and task IDs.");
  }
  const contractHash = input.contractHash === null ? null : digest(input.contractHash, "synchronized contractHash");
  const contractRevision = input.contractRevision;
  if (!Number.isSafeInteger(contractRevision) || contractRevision < 0 || state.currentContractHash !== contractHash || state.contractRevision !== contractRevision) {
    fail("RUN_POLICY_TRANSITION_SYNC_REQUIRED", "Synchronized contract proof is stale.");
  }
  const taskIds = validateTaskIds(input.taskIds, "synchronized taskIds");
  if (!sameJson(taskIds, stateTaskIds(state)) || !sameJson(taskIds, journal.taskIds)) {
    fail("RUN_POLICY_TRANSITION_SYNC_REQUIRED", "Synchronized task proof does not cover the captured task tree.");
  }
  const calculated = sha256(canonicalJson({
    policyArtifact: journal.newPolicyArtifact,
    contractHash,
    contractRevision,
    taskIds
  }));
  if (input.synchronizationDigest !== undefined && input.synchronizationDigest !== calculated) {
    fail("RUN_POLICY_TRANSITION_SYNC_REQUIRED", "Synchronization digest does not match the current policy and task proof.");
  }
  return {contractHash, contractRevision, taskIds, synchronizationDigest: calculated};
}

function newStage(journal: PolicyTransitionJournal, input: StageCore): PolicyTransitionJournal {
  const previous = journal.stages[journal.stages.length - 1];
  const stage = stageCore({
    ...input,
    previousStageDigest: previous?.stageDigest ?? null
  });
  const {artifactDigest: _oldArtifactDigest, ...withoutDigest} = journal;
  const base: Omit<PolicyTransitionJournal, "artifactDigest"> = {
    ...withoutDigest,
    newPolicyArtifact: input.newPolicyArtifact ?? journal.newPolicyArtifact,
    stages: [...journal.stages, stage]
  };
  return sealJournal(base);
}

function stageInputArtifact(state: RunState, input: MarkPolicyTransitionStageInput): PolicyTransitionArtifactRef | null {
  if (input.newPolicyArtifact !== undefined) return artifactReference(input.newPolicyArtifact, "new policy artifact");
  return policyArtifactRefFromState(state);
}

function assertNewArtifactMatchesState(state: RunState, journal: PolicyTransitionJournal, artifact: PolicyTransitionArtifactRef | null): asserts artifact is PolicyTransitionArtifactRef {
  if (artifact === null) return fail("RUN_POLICY_TRANSITION_SYNC_REQUIRED", "A bound policy artifact is required.");
  const current = policyArtifactRefFromState(state);
  if (current === null || !artifactMatches(current, artifact)) {
    fail("RUN_POLICY_TRANSITION_STALE", "The bound policy artifact is not the current run policy.");
  }
  if (journal.oldPolicyArtifact !== null && journal.oldPolicyArtifact.artifactDigest === artifact.artifactDigest) {
    fail("RUN_POLICY_TRANSITION_STALE", "The bound policy artifact did not change from the old policy.");
  }
}

/** Begin a policy revision by sealing all identities that the coordinator must fence. */
export async function beginPolicyTransition(
  repository: RunRepository,
  runId: string,
  input: BeginPolicyTransitionInput = {}
): Promise<PolicyTransitionJournal> {
  const state = await repository.read(runId);
  if (state === null) return fail("RUN_NOT_FOUND", `Run not found: ${runId}`);
  const pending = (await discoverPendingPolicyTransitions(repository, runId));
  if (pending.length > 0) {
    if (input.transitionId !== undefined) {
      const existing = pending.find(candidate => candidate.transitionId === input.transitionId);
      if (existing !== undefined) return existing;
    }
    return fail("RUN_POLICY_TRANSITION_PENDING", "Recover the existing policy transition before beginning another one.");
  }
  const id = transitionId(input.transitionId ?? `policy-transition-${randomUUID()}`);
  const oldPolicyArtifact = policyArtifactRefFromState(state);
  if (input.expectedOldArtifactDigest !== undefined && input.expectedOldArtifactDigest !== (oldPolicyArtifact?.artifactDigest ?? null)) {
    return fail("RUN_POLICY_TRANSITION_STALE", "The expected old policy artifact does not match the run.");
  }
  if (input.expectedContractHash !== undefined && input.expectedContractHash !== state.currentContractHash) {
    return fail("RUN_POLICY_TRANSITION_STALE", "The expected run contract does not match the run.");
  }
  if (state.status !== "active" || state.disableRestart || state.awaitingResume) {
    return fail("RUN_POLICY_TRANSITION_DISABLED", "Only an active resumable run can begin a policy transition.");
  }
  if (state.integration !== null) {
    return fail("RUN_POLICY_TRANSITION_INTEGRATION_PENDING", "Resolve the run integration journal before changing policy.");
  }
  const createdAt = nowIso(input.now);
  const tasks = snapshotTasks(state);
  const workers = snapshotWorkers(state);
  const journal = sealJournal({
    schemaVersion: 1,
    runId,
    transitionId: id,
    createdAt,
    baseRevision: state.revision ?? 0,
    oldPolicyArtifact,
    newPolicyArtifact: null,
    oldContractHash: state.currentContractHash,
    oldContractRevision: state.contractRevision,
    taskIds: tasks.map(task => task.taskId).sort(),
    tasks,
    workerGenerations: workers.map(worker => ({workerId: worker.workerId, generation: worker.generation})),
    workers,
    resumeIds: resumeIds(state),
    deliveredMarkers: deliveredMarkers(state),
    stages: [stageCore({stage: "prepared", at: createdAt, previousStageDigest: null})]
  });
  await repository.mutate(runId, async current => {
    if ((current.revision ?? 0) !== (state.revision ?? 0) || current.status !== "active" || current.disableRestart || current.awaitingResume ||
        !artifactMatches(policyArtifactRefFromState(current), oldPolicyArtifact) || current.currentContractHash !== state.currentContractHash ||
        current.contractRevision !== state.contractRevision || !sameJson(stateTaskIds(current), journal.taskIds)) {
      return fail("RUN_POLICY_TRANSITION_STALE", "Run changed while preparing the policy transition.");
    }
    assertWorkerIdentity(current, journal);
    await writeJournal(current, journal);
    return withTransitionEvent(current, journal);
  });
  return journal;
}

async function markStageInternal(
  repository: RunRepository,
  runId: string,
  id: string,
  input: MarkPolicyTransitionStageInput
): Promise<PolicyTransitionJournal> {
  const requested = input.stage;
  const requestedIndex = stageIndex(requested);
  if (requestedIndex < 1) return fail("RUN_POLICY_TRANSITION_INVALID", "Prepared is created by beginPolicyTransition.");
  const state = await repository.read(runId);
  if (state === null) return fail("RUN_NOT_FOUND", `Run not found: ${runId}`);
  const currentJournal = await readJournal(state, id);
  if (currentJournal === null) return fail("RUN_POLICY_TRANSITION_NOT_FOUND", `Transition not found: ${id}`);
  const currentIndex = stageIndex(stageAt(currentJournal));
  if (requestedIndex < currentIndex) return fail("RUN_POLICY_TRANSITION_STAGE_ORDER", "A policy transition cannot move backwards.");
  const at = nowIso(input.now);
  let resulting: PolicyTransitionJournal = currentJournal;
  await repository.mutate(runId, async current => {
    const journal = await readJournal(current, id);
    if (journal === null) return fail("RUN_POLICY_TRANSITION_NOT_FOUND", `Transition not found: ${id}`);
    const latestIndex = stageIndex(stageAt(journal));
    if (requestedIndex < latestIndex) return fail("RUN_POLICY_TRANSITION_STAGE_ORDER", "A policy transition cannot move backwards.");
    if (requestedIndex === latestIndex) {
      if (requested === "bound") {
        assertNewArtifactMatchesState(current, journal, stageInputArtifact(current, input));
      } else if (requested === "synchronized") {
        assertWritersFenced(current, journal);
        assertCurrentPolicy(current, journal.newPolicyArtifact);
        assertTaskTree(current, journal);
        validateSynchronizationInput(current, journal, input);
      } else if (requested === "fenced") {
        assertCurrentPolicy(current, journal.oldPolicyArtifact);
        assertOldContract(current, journal);
        assertWritersFenced(current, journal);
      }
      resulting = hasStageReference(current, journal) ? journal : journal;
      return withTransitionEvent(current, journal);
    }
    if (requestedIndex !== latestIndex + 1) return fail("RUN_POLICY_TRANSITION_STAGE_ORDER", "A policy transition stage is missing.");
    if (requested === "fenced") {
      assertCurrentPolicy(current, journal.oldPolicyArtifact);
      assertOldContract(current, journal);
      assertWritersFenced(current, journal);
    } else if (requested === "bound") {
      assertWritersFenced(current, journal);
      assertOldContract(current, journal);
      const artifact = stageInputArtifact(current, input);
      assertNewArtifactMatchesState(current, journal, artifact);
      resulting = newStage(journal, {stage: "bound", at, newPolicyArtifact: artifact});
    } else if (requested === "synchronized") {
      if (journal.newPolicyArtifact === null) return fail("RUN_POLICY_TRANSITION_SYNC_REQUIRED", "The bound policy artifact is missing.");
      assertWritersFenced(current, journal);
      assertCurrentPolicy(current, journal.newPolicyArtifact);
      assertTaskTree(current, journal);
      const proof = validateSynchronizationInput(current, journal, input);
      resulting = newStage(journal, {
        stage: "synchronized",
        at,
        newPolicyArtifact: journal.newPolicyArtifact,
        contractHash: proof.contractHash,
        contractRevision: proof.contractRevision,
        taskIds: proof.taskIds,
        synchronizationDigest: proof.synchronizationDigest
      });
    } else {
      return fail("RUN_POLICY_TRANSITION_STAGE_ORDER", "Complete must use completePolicyTransition after synchronization.");
    }
    if (requested === "fenced") resulting = newStage(journal, {stage: "fenced", at});
    await writeJournal(current, resulting);
    return withTransitionEvent(current, resulting);
  });
  return resulting;
}

/** Append fenced/bound/synchronized journal stages. */
export async function markPolicyTransitionStage(
  repository: RunRepository,
  runId: string,
  transitionIdValue: string,
  input: MarkPolicyTransitionStageInput
): Promise<PolicyTransitionJournal> {
  const id = transitionId(transitionIdValue);
  if (input.stage === "complete") return await completePolicyTransition(repository, runId, id, input);
  return await markStageInternal(repository, runId, id, input);
}

/** Complete only after the synchronized policy/task proof is durable. */
export async function completePolicyTransition(
  repository: RunRepository,
  runId: string,
  transitionIdValue: string,
  input: CompletePolicyTransitionInput = {}
): Promise<PolicyTransitionJournal> {
  const id = transitionId(transitionIdValue);
  const state = await repository.read(runId);
  if (state === null) return fail("RUN_NOT_FOUND", `Run not found: ${runId}`);
  const before = await readJournal(state, id);
  if (before === null) return fail("RUN_POLICY_TRANSITION_NOT_FOUND", `Transition not found: ${id}`);
  if (stageAt(before) === "complete") return before;
  if (stageAt(before) !== "synchronized") return fail("RUN_POLICY_TRANSITION_SYNC_REQUIRED", "Policy transition synchronization is required before completion.");
  const sync = before.stages[before.stages.length - 1];
  if (sync.synchronizationDigest === undefined) return fail("RUN_POLICY_TRANSITION_SYNC_REQUIRED", "Synchronized proof is missing.");
  if (input.synchronizationDigest !== undefined && input.synchronizationDigest !== sync.synchronizationDigest) {
    return fail("RUN_POLICY_TRANSITION_SYNC_REQUIRED", "Completion proof does not match synchronized policy/task evidence.");
  }
  const at = nowIso(input.now);
  let resulting = before;
  await repository.mutate(runId, async current => {
    const journal = await readJournal(current, id);
    if (journal === null) return fail("RUN_POLICY_TRANSITION_NOT_FOUND", `Transition not found: ${id}`);
    if (stageAt(journal) === "complete") {
      resulting = journal;
      return current;
    }
    if (stageAt(journal) !== "synchronized") return fail("RUN_POLICY_TRANSITION_SYNC_REQUIRED", "Policy transition synchronization is required before completion.");
    const stage = journal.stages[journal.stages.length - 1];
    if (stage.synchronizationDigest === undefined ||
        (input.synchronizationDigest !== undefined && input.synchronizationDigest !== stage.synchronizationDigest)) {
      return fail("RUN_POLICY_TRANSITION_SYNC_REQUIRED", "Completion proof does not match synchronized policy/task evidence.");
    }
    assertWritersFenced(current, journal);
    assertCurrentPolicy(current, journal.newPolicyArtifact);
    assertTaskTree(current, journal);
    const syncInput: MarkPolicyTransitionStageInput = {
      stage: "synchronized",
      contractHash: stage.contractHash,
      contractRevision: stage.contractRevision,
      taskIds: stage.taskIds,
      synchronizationDigest: stage.synchronizationDigest
    };
    validateSynchronizationInput(current, journal, syncInput);
    resulting = newStage(journal, {stage: "complete", at});
    await writeJournal(current, resulting);
    return withTransitionEvent(current, resulting);
  });
  return resulting;
}

/** Read one private journal without exposing policy configuration contents. */
export async function readPolicyTransition(
  repository: RunRepository,
  runId: string,
  transitionIdValue: string
): Promise<PolicyTransitionJournal | null> {
  const id = transitionId(transitionIdValue);
  const state = await repository.read(runId);
  if (state === null) return fail("RUN_NOT_FOUND", `Run not found: ${runId}`);
  return await readJournal(state, id);
}

/** Discover all valid journals, including completed history. */
export async function discoverPolicyTransitions(
  repository: RunRepository,
  runId: string
): Promise<readonly PolicyTransitionJournal[]> {
  const state = await repository.read(runId);
  if (state === null) return fail("RUN_NOT_FOUND", `Run not found: ${runId}`);
  const directory = transitionDirectory(state);
  try {
    await ensurePrivateDirectory(directory, state.commonDir);
  } catch (error) {
    throw error;
  }
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const journals: PolicyTransitionJournal[] = [];
  for (const name of names.filter(candidate => candidate.endsWith(".json") && ID.test(candidate.slice(0, -5)))) {
    const id = candidateId(name);
    const journal = await readJournal(state, id);
    if (journal !== null) journals.push(journal);
  }
  return journals.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.transitionId.localeCompare(right.transitionId));
}

function candidateId(name: string): string {
  return transitionId(name.slice(0, -5));
}

/** Discover incomplete journals that must be recovered before another transition. */
export async function discoverPendingPolicyTransitions(
  repository: RunRepository,
  runId: string
): Promise<readonly PolicyTransitionJournal[]> {
  return (await discoverPolicyTransitions(repository, runId)).filter(journal => stageAt(journal) !== "complete");
}

/** Return one pending journal, failing closed if recovery is ambiguous. */
export async function discoverPendingPolicyTransition(
  repository: RunRepository,
  runId: string
): Promise<PolicyTransitionJournal | null> {
  const pending = await discoverPendingPolicyTransitions(repository, runId);
  if (pending.length > 1) return fail("RUN_POLICY_TRANSITION_PENDING", "Multiple policy transitions require explicit recovery.");
  return pending[0] ?? null;
}

/**
 * Old generations are blocked for the whole pending window.  The coordinator
 * can use this at delivery/restart boundaries; this module never starts or
 * stops a native writer itself.
 */
export function policyTransitionBlocksWorker(
  journal: PolicyTransitionJournal,
  workerId: string,
  generation: number
): boolean {
  if (stageAt(journal) === "complete") return false;
  // A restarted worker with a new generation is still unsafe until the
  // synchronization and complete markers are durable.  The generation is
  // retained in the journal for diagnostics and stale-event rejection.
  return journal.workerGenerations.some(worker => worker.workerId === workerId);
}

/** A pending transition is restart-safe only after its complete marker exists. */
export function policyTransitionAllowsRestart(journal: PolicyTransitionJournal): boolean {
  return stageAt(journal) === "complete";
}
