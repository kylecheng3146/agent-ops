import type {UsageHighWater} from "./types.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { readPrivateFile, withPrivateFileLock, writePrivateFile } from "../security/permissions.js";
import {budgetExpired} from "./scheduler.js";

/** Hosts with a writer transport in the first run release. */
export type RunHost = "claude" | "codex";

export type RunStatus =
  | "active"
  | "awaiting-input"
  | "paused"
  | "stopping"
  | "complete"
  | "blocked"
  | "budget-limited"
  | "failed";

export type RunWorkerStatus =
  | "assigned"
  | "starting"
  | "running"
  | "idle"
  | "handing-off"
  | "fenced"
  | "delivered"
  | "stopped"
  | "blocked";

export type RunTaskStatus =
  | "planned"
  | "ready"
  | "running"
  | "awaiting-delivery"
  | "delivered"
  | "blocked"
  | "complete";

export type RunControlAction = "stop" | "pause" | "resume" | "respond";

/** Writer slots are deliberately bounded; the coordinator may occupy one. */
export const MAX_ACTIVE_WORKERS = 2;

export interface RunUsage {
  readonly tokens: number | null;
  readonly usd: number | null;
  readonly completeness: "complete" | "partial" | "unknown";
  readonly source: string | null;
  readonly epoch: number;
  readonly highWaterMark: number;
}

export interface RunBudgetState {
  /** Whole-run wall-clock budget in milliseconds. */
  readonly limitMs: number;
  /** Union of active intervals. Overlapping workers count once. */
  readonly activeIntervals: readonly { readonly startMs: number; readonly endMs: number | null }[];
  readonly accumulatedMs: number;
  readonly startedAt: string;
  readonly lastObservedAt: string;
  readonly usage: RunUsage;
}

export interface RunTaskNode {
  readonly taskId: string;
  readonly dependencies: readonly string[];
  readonly planDigest?: string;
  readonly status: RunTaskStatus;
  readonly workerId: string | null;
  readonly deliveryDigest: string | null;
  readonly sourceCommit: string | null;
  readonly blockedReason: string | null;
}

export interface RunWorkerRecord {
  readonly workerId: string;
  readonly taskId: string;
  readonly host: RunHost;
  readonly ownerSessionId: string;
  readonly nativeSessionId: string | null;
  readonly nativeJobId: string | null;
  readonly worktree: string | null;
  readonly processId: number | null;
  readonly processIdentity: string | null;
  readonly proofProcess?: {readonly processId: number; readonly processIdentity: string} | null;
  readonly generation: number;
  readonly status: RunWorkerStatus;
  readonly leaseExpiresAt: string | null;
  readonly heartbeatAt: string | null;
  readonly stopIntent: RunStopIntent | null;
  readonly nativeGoalState: "inactive" | "active" | "paused" | "complete" | "cleared" | "unknown";
  readonly lastFailure: RunFailure | null;
}

export interface RunStopIntent {
  readonly runId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly nativeSessionId: string | null;
  readonly reason: "handoff" | "stop" | "budget" | "no-progress" | "crash";
  readonly deliveryDigest: string | null;
  readonly contractDigest: string | null;
  readonly sourceCommit: string | null;
  readonly expiresAt: string;
  readonly confirmedDeadAt: string | null;
}

export interface RunFailure {
  readonly id: string;
  readonly checkId: string | null;
  readonly pinId: string | null;
  readonly failureClass: string;
  /** Semantic failure identity. Diagnostic text must not be used here. */
  readonly fingerprint: string | null;
  readonly diagnosticDigest: string | null;
  /** Stable phase supplied by convergence observations, when available. */
  readonly phase?: string | null;
  /** Digest of the semantic PASS/FAIL vector, when available. */
  readonly progressDigest?: string | null;
  readonly round: number;
  readonly observedAt: string;
  readonly usefulProgress: boolean;
}

export interface RunPolicyBinding {
  readonly configHash: string;
  readonly runtimeHash: string;
  readonly artifactDigest: string;
  readonly expiresAt: string;
}

export interface RunEvent {
  readonly id: string;
  readonly at: string;
  readonly type:
    | "created"
    | "status"
    | "worker"
    | "control"
    | "diagnostic"
    | "delivery"
    | "integration"
    | "budget";
  readonly code: string;
  readonly workerId: string | null;
  readonly taskId: string | null;
  readonly detail: string | null;
}

export interface RunQuestion {
  readonly questionId: string;
  readonly prompt: string;
  readonly askedAt: string;
  readonly answeredAt: string | null;
  readonly answerDigest: string | null;
}

export interface RunState {
  readonly schemaVersion: 1;
  readonly revision?: number;
  readonly runId: string;
  readonly root: string;
  readonly commonDir: string;
  readonly targetBranch: string;
  readonly goal: string;
  readonly goalHash: string;
  readonly host: RunHost;
  readonly coordinatorId: string;
  readonly ownerSessionId: string;
  readonly nativeInstance: string | null;
  readonly rootTaskId: string | null;
  readonly currentContractHash: string | null;
  readonly contractRevision: number;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly bootIdentity: string;
  readonly loginDomain: string;
  readonly awaitingResume: boolean;
  readonly disableRestart: boolean;
  readonly budget: RunBudgetState;
  readonly usage?: readonly UsageHighWater[];
  readonly proofProcess?: {readonly processId: number; readonly processIdentity: string} | null;
  readonly jobs: number;
  readonly tasks: readonly RunTaskNode[];
  readonly workers: readonly RunWorkerRecord[];
  readonly questions: readonly RunQuestion[];
  readonly controls: readonly RunControlRecord[];
  readonly events: readonly RunEvent[];
  readonly integration: RunIntegrationState | null;
  /** Optional for legacy runs; new policy-aware runs bind all four digests. */
  readonly policyBinding?: RunPolicyBinding;
}

export interface RunControlRecord {
  readonly action: RunControlAction;
  readonly requestedAt: string;
  readonly actor: "user" | "coordinator" | "supervisor";
  readonly reason: string | null;
  readonly expiresAt: string | null;
  readonly appliedAt: string | null;
}

export interface RunIntegrationState {
  readonly transactionId: string;
  readonly status: "prepared" | "target-moved" | "tasks-completed" | "receipt-written" | "cleaned" | "blocked";
  readonly expectedTarget: string;
  readonly candidate: string;
  readonly completedSteps: readonly string[];
  readonly childDeliveries: readonly string[];
  readonly receiptPath: string | null;
  readonly receiptDigest: string | null;
  readonly proofDigest?: string;
  readonly updatedAt: string;
}

export interface RunRepository {
  read(runId: string): Promise<RunState | null>;
  /** Create is optional for adapters backed by an atomic native RunStore. */
  create?(state: RunState): Promise<void>;
  write(state: RunState): Promise<void>;
  mutate(runId: string, action: (state: RunState) => RunState | Promise<RunState>): Promise<RunState>;
  list(): Promise<readonly RunState[]>;
  appendEvent(runId: string, event: Omit<RunEvent, "id" | "at"> & { readonly at?: string }): Promise<RunState>;
}

const RUN_ID = /^[a-z][a-z0-9-]{7,63}$/u;
const ID = /^[A-Za-z0-9._:/-]{1,256}$/u;
const SHA = /^[a-f0-9]{40,64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const MAX_EVENTS = 2_000;
const MAX_GOAL_LENGTH = 64_000;
const MAX_TIME_BUDGET_MS = 24 * 60 * 60 * 1_000;

function invalid(message: string): never {
  throw new AgentOpsError("RUN_STATE_INVALID", message);
}

function bounded(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    return invalid(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function iso(value: unknown, label: string): string {
  const text = bounded(value, label, 64);
  if (!Number.isFinite(Date.parse(text))) return invalid(`${label} must be an ISO timestamp.`);
  return text;
}

function nullableBounded(value: unknown, label: string, max = 256): string | null {
  return value === null ? null : bounded(value, label, max);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validUsage(value: unknown): RunUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("Run usage is invalid.");
  const item = value as Record<string, unknown>;
  if (!["complete", "partial", "unknown"].includes(String(item.completeness)) ||
      (item.tokens !== null && (!Number.isSafeInteger(item.tokens) || (item.tokens as number) < 0)) ||
      (item.usd !== null && (typeof item.usd !== "number" || !Number.isFinite(item.usd) || item.usd < 0)) ||
      (item.source !== null && typeof item.source !== "string") ||
      !Number.isSafeInteger(item.epoch) || (item.epoch as number) < 0 ||
      !Number.isSafeInteger(item.highWaterMark) || (item.highWaterMark as number) < 0) {
    return invalid("Run usage contains an invalid or negative value.");
  }
  return {
    tokens: item.tokens as number | null,
    usd: item.usd as number | null,
    completeness: item.completeness as RunUsage["completeness"],
    source: item.source as string | null,
    epoch: item.epoch as number,
    highWaterMark: item.highWaterMark as number
  };
}

const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const boundedArray = (value: unknown, limit: number): value is unknown[] => Array.isArray(value) && value.length <= limit;
function validPolicyBinding(value: unknown): value is RunPolicyBinding {
  if (!plain(value) || Object.keys(value).sort().join(",") !== "artifactDigest,configHash,expiresAt,runtimeHash") return false;
  return SHA256.test(String(value.configHash)) && SHA256.test(String(value.runtimeHash)) &&
    SHA256.test(String(value.artifactDigest)) && typeof value.expiresAt === "string" &&
    value.expiresAt.length <= 64 && ISO_TIMESTAMP.test(value.expiresAt) &&
    Number.isFinite(Date.parse(value.expiresAt));
}
function validStateShape(value: unknown): value is RunState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<RunState>;
  return item.schemaVersion === 1 && typeof item.runId === "string" && RUN_ID.test(item.runId) &&
    typeof item.root === "string" && typeof item.commonDir === "string" &&
    typeof item.targetBranch === "string" && typeof item.goal === "string" && item.goal.length <= MAX_GOAL_LENGTH &&
    typeof item.goalHash === "string" && SHA.test(item.goalHash) &&
    (item.host === "claude" || item.host === "codex") && ID.test(String(item.coordinatorId)) &&
    ID.test(String(item.ownerSessionId)) && (item.nativeInstance === null || typeof item.nativeInstance === "string") &&
    (item.rootTaskId === null || typeof item.rootTaskId === "string") &&
    (item.currentContractHash === null || (typeof item.currentContractHash === "string" && SHA.test(item.currentContractHash))) &&
    Number.isSafeInteger(item.contractRevision) && (item.contractRevision as number) >= 0 &&
    ["active", "awaiting-input", "paused", "stopping", "complete", "blocked", "budget-limited", "failed"].includes(String(item.status)) &&
    typeof item.budget === "object" && item.budget !== null && Array.isArray(item.tasks) &&
    Array.isArray(item.workers) && Array.isArray(item.questions) && Array.isArray(item.controls) &&
    Array.isArray(item.events) && item.events.length <= MAX_EVENTS && Number.isSafeInteger(item.jobs) &&
    (item.jobs as number) >= 1 && (item.jobs as number) <= 2;
}

/** Validate persisted run state before it can drive a writer or a recovery. */
export function assertRunState(value: unknown): asserts value is RunState {
  if (!validStateShape(value)) return invalid("Persisted run state has an unsupported shape.");
  const state = value as RunState;
  if ((state.revision !== undefined && (!Number.isSafeInteger(state.revision) || state.revision < 0)) ||
      !boundedArray(state.tasks, 512) || !boundedArray(state.workers, 512) || !boundedArray(state.questions, 128) ||
      !boundedArray(state.controls, 4096) || state.tasks.some(task => !plain(task) || !Array.isArray(task.dependencies) ||
        task.dependencies.length > 512 || !["planned", "ready", "running", "awaiting-delivery", "delivered", "blocked", "complete"].includes(String(task.status))) ||
      state.workers.some(worker => !plain(worker) || !["assigned", "starting", "running", "idle", "handing-off", "fenced", "delivered", "stopped", "blocked"].includes(String(worker.status))) ||
      state.events.some(event => !plain(event)) || !Array.isArray(state.budget.activeIntervals) ||
      state.budget.activeIntervals.some(interval => !plain(interval))) return invalid("Run state contains malformed nested records.");
  if (!RUN_ID.test(state.runId) || !SHA.test(state.goalHash) || state.goal.length > MAX_GOAL_LENGTH ||
      sha256(state.goal) !== state.goalHash || !Number.isSafeInteger(state.budget.limitMs) ||
      state.budget.limitMs <= 0 || state.budget.limitMs > MAX_TIME_BUDGET_MS ||
      !Number.isSafeInteger(state.budget.accumulatedMs) || state.budget.accumulatedMs < 0 ||
      !Array.isArray(state.budget.activeIntervals) || state.budget.activeIntervals.some((interval) =>
        !Number.isSafeInteger(interval.startMs) || interval.startMs < 0 ||
        (interval.endMs !== null && (!Number.isSafeInteger(interval.endMs) || interval.endMs < interval.startMs))) ||
      state.tasks.some((task) => !ID.test(task.taskId) || task.dependencies.some((dep) => !ID.test(dep))) ||
      state.workers.some((worker) => !ID.test(worker.workerId) || !ID.test(worker.taskId) || !ID.test(worker.ownerSessionId) ||
        !Number.isSafeInteger(worker.generation) || worker.generation < 1 || worker.host !== state.host) ||
      state.events.some((event) => !ID.test(event.id) || !ID.test(event.code) || !Number.isFinite(Date.parse(event.at))) ||
      !Number.isFinite(Date.parse(state.createdAt)) || !Number.isFinite(Date.parse(state.updatedAt))) {
    return invalid("Persisted run state failed identity, budget, or ownership validation.");
  }
  validUsage(state.budget.usage);
  if (state.policyBinding !== undefined && !validPolicyBinding(state.policyBinding))
    return invalid("Invalid run policy binding.");
  if (state.proofProcess != null && (!plain(state.proofProcess) || !Number.isSafeInteger(state.proofProcess.processId) ||
    state.proofProcess.processId < 1 || typeof state.proofProcess.processIdentity !== "string" ||
    state.proofProcess.processIdentity.length === 0 || state.proofProcess.processIdentity.length > 256))
    return invalid("Invalid proof process ownership.");
  if (state.workers.some(w => w.proofProcess != null && (!plain(w.proofProcess) || !Number.isSafeInteger(w.proofProcess.processId) ||
    w.proofProcess.processId < 1 || typeof w.proofProcess.processIdentity !== "string" || w.proofProcess.processIdentity.length === 0 || w.proofProcess.processIdentity.length > 256)))
    return invalid("Invalid worker proof process ownership.");
  if (state.integration !== null && (!plain(state.integration) || !ID.test(state.integration.transactionId) ||
    !["prepared", "target-moved", "tasks-completed", "receipt-written", "cleaned", "blocked"].includes(state.integration.status) ||
    !/^[a-f0-9]{40,64}$/u.test(state.integration.expectedTarget) || !/^[a-f0-9]{40,64}$/u.test(state.integration.candidate) ||
    !boundedArray(state.integration.completedSteps, 1024) || state.integration.completedSteps.some(step => typeof step !== "string" || step.length > 256) ||
    !boundedArray(state.integration.childDeliveries, 512) || state.integration.childDeliveries.some(commit => typeof commit !== "string" || !/^[a-f0-9]{40,64}$/u.test(commit)) ||
    (state.integration.proofDigest !== undefined && !SHA.test(state.integration.proofDigest)) ||
    (state.integration.receiptDigest !== null && !SHA.test(state.integration.receiptDigest)) ||
    (state.integration.receiptPath !== null && typeof state.integration.receiptPath !== "string") ||
    !Number.isFinite(Date.parse(state.integration.updatedAt)))) return invalid("Invalid integration transaction.");
  if (state.usage !== undefined && (!Array.isArray(state.usage) || state.usage.length > 4096 || state.usage.some(item =>
    !plain(item) || !["claude", "codex", "review", "verify"].includes(String(item.source)) || typeof item.epoch !== "string" || item.epoch.length > 256 ||
    !["complete", "partial", "unknown"].includes(String(item.completeness)) || (typeof item.observedAt !== "string" || !Number.isFinite(Date.parse(item.observedAt))) ||
    [item.inputTokens, item.outputTokens, item.totalTokens, item.costUsd].some(n => n !== null && (typeof n !== "number" || !Number.isFinite(n) || n < 0)))))
    return invalid("Invalid usage epoch ledger.");
}

function event(input: Omit<RunEvent, "id" | "at">, now: string): RunEvent {
  return { ...input, id: randomUUID(), at: now };
}

export function createRunState(input: {
  readonly root: string;
  readonly commonDir: string;
  readonly targetBranch: string;
  readonly goal: string;
  readonly host: RunHost;
  readonly ownerSessionId: string;
  readonly rootTaskId?: string | null;
  readonly contractHash?: string | null;
  readonly runId?: string;
  readonly jobs?: number;
  readonly timeBudgetMs?: number;
  readonly now?: string;
  readonly bootIdentity?: string;
  readonly loginDomain?: string;
}): RunState {
  const now = input.now ?? new Date().toISOString();
  const goal = bounded(input.goal.trim(), "goal", MAX_GOAL_LENGTH);
  if (input.jobs !== undefined && (!Number.isSafeInteger(input.jobs) || input.jobs < 1 || input.jobs > 2)) {
    throw new AgentOpsError("RUN_JOBS_INVALID", "A run supports one or two implementation workers.");
  }
  const limitMs = input.timeBudgetMs ?? 60 * 60 * 1_000;
  if (!Number.isSafeInteger(limitMs) || limitMs <= 0 || limitMs > MAX_TIME_BUDGET_MS) {
    throw new AgentOpsError("RUN_BUDGET_INVALID", "Run time budget must be a positive value no greater than 24 hours.");
  }
  const runId = input.runId ?? `run-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  if (!RUN_ID.test(runId)) throw new AgentOpsError("RUN_ID_INVALID", "Run id must contain 8-64 lowercase letters, digits, and hyphens.");
  const usage: RunUsage = { tokens: null, usd: null, completeness: "unknown", source: null, epoch: 0, highWaterMark: 0 };
  const state: RunState = {
    schemaVersion: 1,
    revision: 0,
    runId,
    root: bounded(input.root, "root", 4096),
    commonDir: bounded(input.commonDir, "commonDir", 4096),
    targetBranch: bounded(input.targetBranch, "targetBranch", 256),
    goal,
    goalHash: sha256(goal),
    host: input.host,
    coordinatorId: `coordinator-${runId}`,
    ownerSessionId: bounded(input.ownerSessionId, "ownerSessionId"),
    nativeInstance: null,
    rootTaskId: input.rootTaskId ?? null,
    currentContractHash: input.contractHash ?? null,
    contractRevision: 0,
    status: "active",
    createdAt: iso(now, "createdAt"),
    updatedAt: iso(now, "updatedAt"),
    bootIdentity: bounded(input.bootIdentity ?? "unknown", "bootIdentity"),
    loginDomain: bounded(input.loginDomain ?? "unknown", "loginDomain"),
    awaitingResume: false,
    disableRestart: false,
    budget: {
      limitMs,
      activeIntervals: [],
      accumulatedMs: 0,
      startedAt: iso(now, "budget.startedAt"),
      lastObservedAt: iso(now, "budget.lastObservedAt"),
      usage
    },
    usage: [],
    jobs: input.jobs ?? 2,
    tasks: [],
    workers: [],
    questions: [],
    controls: [],
    events: [event({ type: "created", code: "RUN_CREATED", workerId: null, taskId: null, detail: null }, now)],
    integration: null
  };
  // The helper above intentionally only creates an event. Validate the actual state once.
  assertRunState(state);
  return state;
}

export class FileRunRepository implements RunRepository {
  readonly #directory: string;
  readonly #anchor: string;
  readonly #now: () => string;

  constructor(directory: string, anchor: string, now: () => string = () => new Date().toISOString()) {
    this.#directory = directory;
    this.#anchor = anchor;
    this.#now = now;
  }

  #path(runId: string): string {
    if (!RUN_ID.test(runId)) throw new AgentOpsError("RUN_ID_INVALID", "Invalid run id.");
    return join(this.#directory, `${runId}.json`);
  }

  async read(runId: string): Promise<RunState | null> {
    const source = await readPrivateFile(this.#path(runId), this.#anchor);
    if (source === null) return null;
    let value: unknown;
    try { value = JSON.parse(source) as unknown; } catch (error) {
      throw new AgentOpsError("RUN_STATE_INVALID", `Run ${runId} contains invalid JSON.`, { cause: error });
    }
    assertRunState(value);
    return clone(value);
  }

  async write(state: RunState): Promise<void> {
    assertRunState(state);
    await mkdir(this.#directory, { recursive: true });
    const path = this.#path(state.runId);
    await withPrivateFileLock(path, this.#anchor, async () => {
      const current = await this.read(state.runId);
      if (current !== null && (current.revision ?? 0) !== (state.revision ?? 0))
        throw new AgentOpsError("RUN_STATE_STALE", "Run changed since this snapshot was read.");
      if (current !== null && (state.root !== current.root || state.commonDir !== current.commonDir ||
        state.targetBranch !== current.targetBranch || state.goal !== current.goal || state.host !== current.host ||
        state.ownerSessionId !== current.ownerSessionId || state.coordinatorId !== current.coordinatorId))
        throw new AgentOpsError("RUN_IDENTITY_IMMUTABLE", "Run goal, target and ownership cannot change in a snapshot write.");
      if (current?.status === "complete" && (state.status !== "complete" || !state.disableRestart || state.awaitingResume))
        throw new AgentOpsError("RUN_ALREADY_COMPLETE", "Final completion is immutable; cleanup cannot revive or downgrade this run.");
      const updated = {...state, revision: current === null ? (state.revision ?? 0) : (current.revision ?? 0) + 1};
      await writePrivateFile(path, `${JSON.stringify(updated, null, 2)}\n`, this.#anchor);
    });
  }

  async create(state: RunState): Promise<void> {
    assertRunState(state);
    const path = this.#path(state.runId);
    await mkdir(this.#directory, { recursive: true });
    await withPrivateFileLock(path, this.#anchor, async () => {
      if (await readPrivateFile(path, this.#anchor) !== null) {
        throw new AgentOpsError("RUN_EXISTS", `Run already exists: ${state.runId}`);
      }
      await writePrivateFile(path, `${JSON.stringify(state, null, 2)}\n`, this.#anchor);
    });
  }

  async mutate(runId: string, action: (state: RunState) => RunState | Promise<RunState>): Promise<RunState> {
    const path = this.#path(runId);
    return await withPrivateFileLock(path, this.#anchor, async () => {
      const current = await this.read(runId);
      if (current === null) throw new AgentOpsError("RUN_NOT_FOUND", `Run not found: ${runId}`);
      const next = await action(current);
      assertRunState(next);
      if (next.runId !== current.runId || next.root !== current.root || next.commonDir !== current.commonDir ||
        next.targetBranch !== current.targetBranch || next.goal !== current.goal || next.goalHash !== current.goalHash ||
        next.host !== current.host || next.ownerSessionId !== current.ownerSessionId || next.coordinatorId !== current.coordinatorId)
        throw new AgentOpsError("RUN_IDENTITY_IMMUTABLE", "Run goal, target and ownership cannot change during a mutation.");
      if (current.status === "complete" && (next.status !== "complete" || !next.disableRestart || next.awaitingResume))
        throw new AgentOpsError("RUN_ALREADY_COMPLETE", "Final completion is immutable; cleanup cannot revive or downgrade this run.");
      const updated = { ...next, revision: (current.revision ?? 0) + 1, updatedAt: iso(this.#now(), "updatedAt") };
      await writePrivateFile(path, `${JSON.stringify(updated, null, 2)}\n`, this.#anchor);
      return clone(updated);
    });
  }

  async list(): Promise<readonly RunState[]> {
    let names: string[];
    try { names = await readdir(this.#directory); } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
    const states: RunState[] = [];
    for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
      const id = basename(name, ".json");
      const state = await this.read(id);
      if (state !== null) states.push(state);
    }
    return states.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async appendEvent(runId: string, input: Omit<RunEvent, "id" | "at"> & { readonly at?: string }): Promise<RunState> {
    return await this.mutate(runId, (state) => {
      const at = input.at ?? this.#now();
      const nextEvents = [...state.events, event({
        type: input.type,
        code: input.code,
        workerId: input.workerId,
        taskId: input.taskId,
        detail: input.detail
      }, at)].slice(-MAX_EVENTS);
      return { ...state, events: nextEvents };
    });
  }
}

export interface RunLifecycleResult {
  readonly state: RunState;
  readonly message: string;
}

/**
 * Small service facade used by the CLI and supervisor. Native host execution is
 * injected; this layer owns persistent run identity and never treats a host's
 * successful exit as agent-ops completion.
 */
export class RunService {
  readonly #repository: RunRepository;
  readonly #now: () => string;

  constructor(repository: RunRepository, now: () => string = () => new Date().toISOString()) {
    this.#repository = repository;
    this.#now = now;
  }

  async start(input: Parameters<typeof createRunState>[0]): Promise<RunLifecycleResult> {
    const state = createRunState({ ...input, now: input.now ?? this.#now() });
    if (this.#repository.create !== undefined) await this.#repository.create(state);
    else {
      if (await this.#repository.read(state.runId) !== null) {
        throw new AgentOpsError("RUN_EXISTS", `Run already exists: ${state.runId}`);
      }
      await this.#repository.write(state);
    }
    return { state, message: `Run ${state.runId} started; final proof is still required.` };
  }

  async status(runId: string): Promise<RunState> {
    const state = await this.#repository.read(runId);
    if (state === null) throw new AgentOpsError("RUN_NOT_FOUND", `Run not found: ${runId}`);
    return state;
  }

  async logs(runId: string): Promise<readonly RunEvent[]> {
    return (await this.status(runId)).events;
  }

  async stop(runId: string, reason = "user requested stop"): Promise<RunLifecycleResult> {
    const state = await this.#repository.mutate(runId, (current) => {
      if (current.status === "complete") throw new AgentOpsError("RUN_ALREADY_COMPLETE", "A completed run cannot be changed into a stopped run.");
      return {
      ...current,
      status: "stopping",
      disableRestart: true,
      controls: [...current.controls, {
        action: "stop", actor: "user", reason, requestedAt: this.#now(), expiresAt: null, appliedAt: null
      }],
      events: [...current.events, event({ type: "control", code: "RUN_STOP_REQUESTED", workerId: null, taskId: null, detail: reason }, this.#now())].slice(-MAX_EVENTS)
      };
    });
    return { state, message: `Run ${runId} is stopping; native sessions remain pending until reconciled.` };
  }

  async pause(runId: string, reason = "user requested pause"): Promise<RunLifecycleResult> {
    const state = await this.#repository.mutate(runId, (current) => ({
      ...current,
      status: "paused",
      controls: [...current.controls, {
        action: "pause", actor: "user", reason, requestedAt: this.#now(), expiresAt: null, appliedAt: null
      }]
    }));
    return { state, message: `Run ${runId} is paused.` };
  }

  async resume(runId: string): Promise<RunLifecycleResult> {
    const state = await this.#repository.mutate(runId, (current) => {
      const recoverable = new Set(["RUN_RECOVERY_DIRTY", "RUN_NATIVE_VERSION_CHANGED", "RUN_RUNTIME_CHANGED", "RUN_REPO_UNTRUSTED",
        "RUN_NATIVE_UNAVAILABLE", "RUN_RESTART_STORM", "RUN_POLICY_RECOVERY_REQUIRED", "RUN_POLICY_EXPIRED", "RUN_SETUP_RECOVERY_REQUIRED", "RUN_NATIVE_START_FAILED"]);
      const blocker = [...current.events].reverse().find(e => recoverable.has(e.code) || ["RUN_NO_PROGRESS_REPEAT", "RUN_COMMAND_DENIED"].includes(e.code));
      const terminalBlocker = current.events.some(e => e.code === "RUN_COMMAND_DENIED") ||
        current.workers.some(w => w.workerId === current.coordinatorId && w.status === "blocked" && w.lastFailure !== null && w.lastFailure.failureClass !== "native-start");
      if (current.status === "complete" || (current.integration?.proofDigest === undefined &&
          (terminalBlocker || (current.status === "blocked" && !recoverable.has(blocker?.code ?? ""))))) {
        throw new AgentOpsError("RUN_NOT_RESUMABLE", `Run ${runId} is ${current.status}.`);
      }
      if (current.integration?.proofDigest === undefined && budgetExpired(current, Date.parse(this.#now())))
        throw new AgentOpsError("RUN_BUDGET_EXHAUSTED", "Explicit resume preserves the whole-run budget; no execution allowance remains.");
      const recover = ["blocked", "paused"].includes(current.status) && recoverable.has(blocker?.code ?? "");
      return {
        ...current,
        ...(recover ? {workers: current.workers.map(w => w.status === "blocked" && (w.lastFailure === null || w.lastFailure.failureClass === "native-start") ? {...w, status: "stopped" as const} : w),
          tasks: current.tasks.map(t => t.status === "blocked" && recoverable.has(t.blockedReason ?? "") ? {...t, status: "ready" as const, blockedReason: null} : t)} : {}),
        status: "active",
        awaitingResume: false,
        disableRestart: false,
        controls: [...current.controls, {
          action: "resume", actor: "user", reason: null, requestedAt: this.#now(), expiresAt: null, appliedAt: null
        }]
      };
    });
    return { state, message: `Run ${runId} resumed; reconciliation is required before starting writers.` };
  }

  async respond(runId: string, questionId: string, answer: string): Promise<RunLifecycleResult> {
    const cleanQuestion = bounded(questionId, "questionId");
    const cleanAnswer = bounded(answer.trim(), "answer", MAX_GOAL_LENGTH);
    const state = await this.#repository.mutate(runId, (current) => {
      const question = current.questions.find((item) => item.questionId === cleanQuestion);
      if (current.status !== "awaiting-input" || current.disableRestart)
        throw new AgentOpsError("RUN_NOT_AWAITING_INPUT", "Respond cannot restart a stopped or terminal run.");
      if (question === undefined) throw new AgentOpsError("RUN_QUESTION_NOT_FOUND", `Question not found: ${cleanQuestion}`);
      if (question.answeredAt !== null) throw new AgentOpsError("RUN_QUESTION_ANSWERED", `Question already answered: ${cleanQuestion}`);
      const answeredAt = this.#now();
      return {
        ...current,
        status: "active",
        questions: current.questions.map((item) => item.questionId === cleanQuestion
          ? { ...item, answeredAt, answerDigest: sha256(cleanAnswer) }
          : item),
        controls: [...current.controls, {
          action: "respond", actor: "user", reason: `answer:${sha256(cleanAnswer)}`, requestedAt: answeredAt, expiresAt: null, appliedAt: answeredAt
        }]
      };
    });
    return { state, message: `Recorded answer ${cleanQuestion}; the coordinator may resume planning.` };
  }

  async list(): Promise<readonly RunState[]> {
    return await this.#repository.list();
  }
}
