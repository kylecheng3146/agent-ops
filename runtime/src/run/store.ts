import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { sha256 } from "../fs/hash.js";
import {
  readPrivateFile,
  withPrivateFileLock,
  writePrivateFile
} from "../security/permissions.js";
import { AgentOpsError } from "../fs/paths.js";
import {
  RUN_STATE_SCHEMA_VERSION,
  type CreateRunStateInput,
  createRunState,
  type GoalContractRevision,
  type IntegrationTransaction,
  type NativeSessionRecord,
  type RunState,
  type UsageHighWater,
  type WorkerRunState,
  type WriterLease
} from "./types.js";

export interface RunStoreOptions {
  readonly now?: () => Date;
}

export type RunStateMutation = (state: RunState) => RunState;

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const HOSTS = new Set(["codex", "claude"]);
const RUN_STATUSES = new Set([
  "planned",
  "running",
  "awaiting-resume",
  "handoff",
  "fenced",
  "completed",
  "failed",
  "blocked",
  "stopped"
]);
const WORKER_STATES = new Set([
  "assigned",
  "running",
  "idle",
  "handing-off",
  "fenced",
  "delivered",
  "resumable",
  "stopped",
  "blocked"
]);
const GOAL_STATUSES = new Set([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
  "unknown"
]);
const INTEGRATION_PHASES = new Set([
  "prepared",
  "target-moved",
  "tasks-completed",
  "receipt-written",
  "cleaned"
]);
const USAGE_SOURCES = new Set(["codex", "claude", "review", "verify"]);
const COMPLETENESS = new Set(["complete", "partial", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key));
}

function isString(value: unknown, min = 1, max = 4096): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max &&
    !value.includes("\0");
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSafeInteger(value: unknown, min = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function isNullableString(value: unknown, max = 4096): value is string | null {
  return value === null || isString(value, 1, max);
}

function assertGoalRevision(value: unknown): asserts value is GoalContractRevision {
  if (!isRecord(value) || !hasExactKeys(value, [
    "revision", "objective", "objectiveHash", "changedAt", "reason"
  ]) || !isSafeInteger(value.revision, 1) || !isString(value.objective) ||
    !HASH_PATTERN.test(String(value.objectiveHash)) || !isIsoDate(value.changedAt) ||
    !["initial", "criteria-revised", "finding-ratchet", "operator"].includes(String(value.reason)) ||
    String(value.objectiveHash) !== hashObjective(String(value.objective))) {
    throw new AgentOpsError("RUN_STATE_INVALID", "Run contract revision is invalid.");
  }
}

function hashObjective(value: string): string {
  return sha256(value);
}

function assertLease(value: unknown): asserts value is WriterLease | null {
  if (value === null) {
    return;
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    "ownerSessionId", "processId", "processIdentity", "generation", "heartbeatAt",
    "bootIdentity", "loginIdentity", "stopIntent"
  ]) || !isString(value.ownerSessionId, 1, 256) || !isSafeInteger(value.processId, 1) ||
    !isString(value.processIdentity, 1, 256) || !isSafeInteger(value.generation, 1) ||
    !isIsoDate(value.heartbeatAt) || !isString(value.bootIdentity, 1, 256) ||
    !isString(value.loginIdentity, 1, 256)) {
    throw new AgentOpsError("RUN_STATE_INVALID", "Run writer lease is invalid.");
  }
  if (value.stopIntent !== null) {
    const intent = value.stopIntent;
    if (!isRecord(intent) || !hasExactKeys(intent, [
      "runId", "workerId", "generation", "nativeSessionId", "requestedAt", "expiresAt",
      "reason", "actionId", "deliveryDigest", "contractDigest", "disableRestart"
    ]) || !isString(intent.runId, 1, 128) || !RUN_ID_PATTERN.test(intent.runId) ||
      !isString(intent.workerId, 1, 256) || !isSafeInteger(intent.generation, 1) ||
      !isString(intent.nativeSessionId, 1, 256) || !isIsoDate(intent.requestedAt) ||
      !isIsoDate(intent.expiresAt) ||
      !["handoff", "operator", "budget", "terminal", "recovery"].includes(String(intent.reason)) ||
      !isString(intent.actionId, 1, 256) ||
      !(intent.deliveryDigest === null || HASH_PATTERN.test(String(intent.deliveryDigest))) ||
      !HASH_PATTERN.test(String(intent.contractDigest)) ||
      typeof intent.disableRestart !== "boolean") {
      throw new AgentOpsError("RUN_STATE_INVALID", "Run stop intent is invalid.");
    }
  }
}

function assertNative(value: unknown): asserts value is NativeSessionRecord | null {
  if (value === null) {
    return;
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind", "sessionId", "threadId", "nativeVersion", "command", "cwd", "processId",
    "startedAt", "resumedAt", "lastObservedAt", "nativeStatus", "completionIsProof"
  ]) || !HOSTS.has(String(value.kind)) || !isString(value.sessionId, 1, 256) ||
    !isNullableString(value.threadId, 256) || !isNullableString(value.nativeVersion, 256) ||
    !isString(value.command, 1, 256) || !isString(value.cwd, 1, 4096) ||
    !(value.processId === null || isSafeInteger(value.processId, 1)) ||
    !isIsoDate(value.startedAt) || !(value.resumedAt === null || isIsoDate(value.resumedAt)) ||
    !(value.lastObservedAt === null || isIsoDate(value.lastObservedAt)) ||
    !GOAL_STATUSES.has(String(value.nativeStatus)) || value.completionIsProof !== false) {
    throw new AgentOpsError("RUN_STATE_INVALID", "Run native session record is invalid.");
  }
}

function assertWorker(value: unknown): asserts value is WorkerRunState {
  if (!isRecord(value) || !hasExactKeys(value, [
    "workerId", "host", "state", "worktree", "contractRevision", "lease", "native",
    "lastError", "updatedAt"
  ]) || !isString(value.workerId, 1, 256) || !HOSTS.has(String(value.host)) ||
    !WORKER_STATES.has(String(value.state)) || !isString(value.worktree, 1, 4096) ||
    !isSafeInteger(value.contractRevision, 1) || !isNullableString(value.lastError, 4096) ||
    !isIsoDate(value.updatedAt)) {
    throw new AgentOpsError("RUN_STATE_INVALID", "Run worker state is invalid.");
  }
  assertLease(value.lease);
  assertNative(value.native);
}

function assertBudget(value: unknown): void {
  if (!isRecord(value) || !hasExactKeys(value, [
    "limitMs", "activeElapsedMs", "activeWorkers", "lastObservedAtMs", "exhausted"
  ]) || !isSafeInteger(value.limitMs, 1) || !isSafeInteger(value.activeElapsedMs) ||
    !Array.isArray(value.activeWorkers) || !value.activeWorkers.every((worker) => isString(worker, 1, 256)) ||
    !isSafeInteger(value.lastObservedAtMs) || typeof value.exhausted !== "boolean" ||
    value.activeElapsedMs > value.limitMs) {
    throw new AgentOpsError("RUN_STATE_INVALID", "Run budget state is invalid.");
  }
}

function assertUsage(value: unknown): asserts value is UsageHighWater {
  if (!isRecord(value) || !hasExactKeys(value, [
    "source", "epoch", "inputTokens", "outputTokens", "totalTokens", "costUsd",
    "completeness", "observedAt"
  ]) || !USAGE_SOURCES.has(String(value.source)) || !isString(value.epoch, 1, 256) ||
    !(value.inputTokens === null || isSafeInteger(value.inputTokens)) ||
    !(value.outputTokens === null || isSafeInteger(value.outputTokens)) ||
    !(value.totalTokens === null || isSafeInteger(value.totalTokens)) ||
    !(value.costUsd === null || (typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0)) ||
    !COMPLETENESS.has(String(value.completeness)) || !isIsoDate(value.observedAt)) {
    throw new AgentOpsError("RUN_STATE_INVALID", "Run usage high-water mark is invalid.");
  }
}

function assertIntegration(value: unknown): asserts value is IntegrationTransaction | null {
  if (value === null) {
    return;
  }
  if (!isRecord(value) || !hasExactKeys(value, [
    "transactionId", "phase", "expectedTarget", "candidate", "proofHash", "childrenStopped",
    "notes", "updatedAt"
  ]) || !isString(value.transactionId, 1, 256) || !INTEGRATION_PHASES.has(String(value.phase)) ||
    !isString(value.expectedTarget, 1, 4096) || !isString(value.candidate, 1, 4096) ||
    !(value.proofHash === null || HASH_PATTERN.test(String(value.proofHash))) ||
    typeof value.childrenStopped !== "boolean" || !Array.isArray(value.notes) ||
    !value.notes.every((note) => isString(note, 1, 4096)) || !isIsoDate(value.updatedAt)) {
    throw new AgentOpsError("RUN_STATE_INVALID", "Run integration transaction is invalid.");
  }
}

export function assertRunState(value: unknown): asserts value is RunState {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "runId", "coordinatorId", "status", "originalGoal", "originalGoalHash",
    "contractRevision", "contractHistory", "worktree", "workers", "budget", "usage",
    "bootLogin", "integration", "createdAt", "updatedAt", "revision"
  ]) || value.schemaVersion !== RUN_STATE_SCHEMA_VERSION || !isString(value.runId, 1, 128) ||
    !RUN_ID_PATTERN.test(value.runId) || !isString(value.coordinatorId, 1, 256) ||
    !RUN_STATUSES.has(String(value.status)) || !isString(value.originalGoal, 1, 4000) ||
    !HASH_PATTERN.test(String(value.originalGoalHash)) ||
    String(value.originalGoalHash) !== hashObjective(value.originalGoal) ||
    !isSafeInteger(value.contractRevision, 1) || !Array.isArray(value.contractHistory) ||
    value.contractHistory.length === 0 || !isString(value.worktree, 1, 4096) ||
    !Array.isArray(value.workers) || value.workers.length === 0 || !Array.isArray(value.usage) ||
    !isRecord(value.bootLogin) || !isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt) ||
    !isSafeInteger(value.revision)) {
    throw new AgentOpsError("RUN_STATE_INVALID", "Run state has an invalid shape.");
  }
  for (const contract of value.contractHistory) {
    assertGoalRevision(contract);
  }
  if (value.contractHistory[value.contractHistory.length - 1]?.revision !== value.contractRevision) {
    throw new AgentOpsError("RUN_STATE_INVALID", "Run contract revision is out of sync.");
  }
  for (const worker of value.workers) {
    assertWorker(worker);
  }
  assertBudget(value.budget);
  for (const usage of value.usage) {
    assertUsage(usage);
  }
  if (!hasExactKeys(value.bootLogin, ["boot", "login", "observedAt"]) ||
    !isString(value.bootLogin.boot, 1, 256) || !isString(value.bootLogin.login, 1, 256) ||
    !isIsoDate(value.bootLogin.observedAt)) {
    throw new AgentOpsError("RUN_STATE_INVALID", "Run boot/login identity is invalid.");
  }
  assertIntegration(value.integration);
}

export class RunStore {
  readonly root: string;
  private readonly now: () => Date;

  constructor(
    readonly anchorDirectory: string,
    options: RunStoreOptions = {}
  ) {
    this.root = join(anchorDirectory, "agent-ops", "runs");
    this.now = options.now ?? (() => new Date());
  }

  path(runId: string): string {
    this.assertRunId(runId);
    return join(this.root, runId, "state.json");
  }

  async read(runId: string): Promise<RunState | null> {
    const path = this.path(runId);
    const source = await readPrivateFile(path, this.anchorDirectory);
    if (source === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error) {
      throw new AgentOpsError("RUN_STATE_INVALID", `Run state is not JSON: ${path}`, { cause: error });
    }
    assertRunState(parsed);
    return parsed;
  }

  async create(input: CreateRunStateInput | RunState): Promise<RunState> {
    const state = "schemaVersion" in input
      ? input
      : createRunState({ ...input, now: input.now ?? this.now() });
    assertRunState(state);
    const path = this.path(state.runId);
    return withPrivateFileLock(path, this.anchorDirectory, async () => {
      if (await readPrivateFile(path, this.anchorDirectory) !== null) {
        throw new AgentOpsError("RUN_ALREADY_EXISTS", `Run already exists: ${state.runId}`);
      }
      await writePrivateFile(path, `${JSON.stringify(state)}\n`, this.anchorDirectory);
      return state;
    });
  }

  async update(
    runId: string,
    expectedRevision: number,
    mutate: RunStateMutation
  ): Promise<RunState> {
    if (!isSafeInteger(expectedRevision)) {
      throw new AgentOpsError("RUN_STATE_REVISION_INVALID", "Expected run revision is invalid.");
    }
    const path = this.path(runId);
    return withPrivateFileLock(path, this.anchorDirectory, async () => {
      const current = await this.read(runId);
      if (current === null) {
        throw new AgentOpsError("RUN_NOT_FOUND", `Run does not exist: ${runId}`);
      }
      if (current.revision !== expectedRevision) {
        throw new AgentOpsError(
          "RUN_STATE_CONFLICT",
          `Run revision ${current.revision} does not match expected ${expectedRevision}.`
        );
      }
      const candidate = mutate(JSON.parse(JSON.stringify(current)) as RunState);
      const next: RunState = {
        ...candidate,
        runId,
        revision: current.revision + 1,
        updatedAt: this.now().toISOString()
      };
      assertRunState(next);
      await writePrivateFile(path, `${JSON.stringify(next)}\n`, this.anchorDirectory);
      return next;
    });
  }

  async compareAndSwap(runId: string, expectedRevision: number, next: RunState): Promise<RunState> {
    return this.update(runId, expectedRevision, () => next);
  }

  private assertRunId(runId: string): void {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new AgentOpsError("RUN_ID_INVALID", `Run id is invalid: ${runId}`);
    }
  }
}

export function newRunId(): string {
  return randomUUID();
}
