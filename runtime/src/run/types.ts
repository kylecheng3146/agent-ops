import { sha256 } from "../fs/hash.js";

export const RUN_STATE_SCHEMA_VERSION = 1 as const;

export type RunStatus =
  | "planned"
  | "running"
  | "awaiting-resume"
  | "handoff"
  | "fenced"
  | "completed"
  | "failed"
  | "blocked"
  | "stopped";

export type WorkerState =
  | "assigned"
  | "running"
  | "idle"
  | "handing-off"
  | "fenced"
  | "delivered"
  | "resumable"
  | "stopped"
  | "blocked";

export type NativeHostKind = "codex" | "claude";

export type NativeGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export type UsageCompleteness = "complete" | "partial" | "unknown";

export type IntegrationPhase =
  | "prepared"
  | "target-moved"
  | "tasks-completed"
  | "receipt-written"
  | "cleaned";

export interface GoalContractRevision {
  readonly revision: number;
  readonly objective: string;
  readonly objectiveHash: string;
  readonly changedAt: string;
  readonly reason: "initial" | "criteria-revised" | "finding-ratchet" | "operator";
}

export interface NativeSessionRecord {
  readonly kind: NativeHostKind;
  readonly sessionId: string;
  readonly threadId: string | null;
  readonly nativeVersion: string | null;
  readonly command: string;
  readonly cwd: string;
  readonly processId: number | null;
  readonly startedAt: string;
  readonly resumedAt: string | null;
  readonly lastObservedAt: string | null;
  readonly nativeStatus: NativeGoalStatus | "unknown";
  /** Native lifecycle is telemetry. It never stands in for agent-ops proof. */
  readonly completionIsProof: false;
}

export interface WorkerStopIntent {
  readonly runId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly nativeSessionId: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly reason: "handoff" | "operator" | "budget" | "terminal" | "recovery";
  readonly actionId: string;
  readonly deliveryDigest: string | null;
  readonly contractDigest: string;
  readonly disableRestart: boolean;
}

export interface WriterLease {
  readonly ownerSessionId: string;
  readonly processId: number;
  readonly processIdentity: string;
  readonly generation: number;
  readonly heartbeatAt: string;
  readonly bootIdentity: string;
  readonly loginIdentity: string;
  readonly stopIntent: WorkerStopIntent | null;
}

export interface WorkerRunState {
  readonly workerId: string;
  readonly host: NativeHostKind;
  readonly state: WorkerState;
  readonly worktree: string;
  readonly contractRevision: number;
  readonly lease: WriterLease | null;
  readonly native: NativeSessionRecord | null;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

export interface UsageHighWater {
  readonly source: NativeHostKind | "review" | "verify";
  readonly epoch: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly completeness: UsageCompleteness;
  readonly observedAt: string;
}

export interface RunBudgetState {
  readonly limitMs: number;
  readonly activeElapsedMs: number;
  readonly activeWorkers: readonly string[];
  readonly lastObservedAtMs: number;
  readonly exhausted: boolean;
}

export interface BootLoginIdentity {
  readonly boot: string;
  readonly login: string;
  readonly observedAt: string;
}

export interface IntegrationTransaction {
  readonly transactionId: string;
  readonly phase: IntegrationPhase;
  readonly expectedTarget: string;
  readonly candidate: string;
  readonly proofHash: string | null;
  readonly childrenStopped: boolean;
  readonly notes: readonly string[];
  readonly updatedAt: string;
}

export interface RunState {
  readonly schemaVersion: typeof RUN_STATE_SCHEMA_VERSION;
  readonly runId: string;
  readonly coordinatorId: string;
  readonly status: RunStatus;
  readonly originalGoal: string;
  readonly originalGoalHash: string;
  readonly contractRevision: number;
  readonly contractHistory: readonly GoalContractRevision[];
  readonly worktree: string;
  readonly workers: readonly WorkerRunState[];
  readonly budget: RunBudgetState;
  readonly usage: readonly UsageHighWater[];
  readonly bootLogin: BootLoginIdentity;
  readonly integration: IntegrationTransaction | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

export interface CreateRunStateInput {
  readonly runId: string;
  readonly coordinatorId: string;
  readonly originalGoal: string;
  readonly worktree: string;
  readonly host?: NativeHostKind;
  readonly workerId?: string;
  readonly workerSessionId?: string;
  readonly processId?: number;
  readonly processIdentity?: string;
  readonly bootIdentity?: string;
  readonly loginIdentity?: string;
  readonly budgetMs?: number;
  readonly now?: Date;
}

export function goalHash(objective: string): string {
  return sha256(objective);
}

export function createRunState(input: CreateRunStateInput): RunState {
  const now = input.now ?? new Date();
  const timestamp = now.toISOString();
  const host = input.host ?? "codex";
  const workerId = input.workerId ?? `${host}-worker-1`;
  const workerSessionId = input.workerSessionId ?? "unassigned";
  const originalGoalHash = goalHash(input.originalGoal);
  const lease = input.processId === undefined
    ? null
    : {
        ownerSessionId: workerSessionId,
        processId: input.processId,
        processIdentity: input.processIdentity ?? "unknown",
        generation: 1,
        heartbeatAt: timestamp,
        bootIdentity: input.bootIdentity ?? "unknown",
        loginIdentity: input.loginIdentity ?? "unknown",
        stopIntent: null
      } satisfies WriterLease;
  const worker: WorkerRunState = {
    workerId,
    host,
    state: "assigned",
    worktree: input.worktree,
    contractRevision: 1,
    lease,
    native: null,
    lastError: null,
    updatedAt: timestamp
  };
  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId: input.runId,
    coordinatorId: input.coordinatorId,
    status: "planned",
    originalGoal: input.originalGoal,
    originalGoalHash,
    contractRevision: 1,
    contractHistory: [
      {
        revision: 1,
        objective: input.originalGoal,
        objectiveHash: originalGoalHash,
        changedAt: timestamp,
        reason: "initial"
      }
    ],
    worktree: input.worktree,
    workers: [worker],
    budget: {
      limitMs: input.budgetMs ?? 60 * 60 * 1000,
      activeElapsedMs: 0,
      activeWorkers: [],
      lastObservedAtMs: now.getTime(),
      exhausted: false
    },
    usage: [],
    bootLogin: {
      boot: input.bootIdentity ?? "unknown",
      login: input.loginIdentity ?? "unknown",
      observedAt: timestamp
    },
    integration: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 0
  };
}
