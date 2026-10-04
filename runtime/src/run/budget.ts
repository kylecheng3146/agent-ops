import { AgentOpsError } from "../fs/paths.js";
import type { RunBudgetState, UsageHighWater } from "./types.js";

export const DEFAULT_ACTIVE_BUDGET_MS = 60 * 60 * 1000;

export interface BudgetOptions {
  readonly now?: () => number;
}

function currentTime(options?: BudgetOptions): number {
  return options?.now?.() ?? Date.now();
}

function validateWorkerId(workerId: string): void {
  if (workerId.length === 0 || workerId.length > 256 || workerId.includes("\0")) {
    throw new AgentOpsError("RUN_WORKER_ID_INVALID", "Worker id is invalid.");
  }
}

function validateTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new AgentOpsError("RUN_CLOCK_INVALID", "Budget clock must be a non-negative safe integer.");
  }
}

export function createBudgetState(
  limitMs = DEFAULT_ACTIVE_BUDGET_MS,
  options?: BudgetOptions
): RunBudgetState {
  const now = currentTime(options);
  validateTime(now);
  if (!Number.isSafeInteger(limitMs) || limitMs <= 0) {
    throw new AgentOpsError("RUN_BUDGET_INVALID", "Active budget must be a positive safe integer.");
  }
  return {
    limitMs,
    activeElapsedMs: 0,
    activeWorkers: [],
    lastObservedAtMs: now,
    exhausted: false
  };
}

/** Add elapsed wall time once while at least one worker is active. */
export function snapshotBudget(
  budget: RunBudgetState,
  options?: BudgetOptions
): RunBudgetState {
  const now = currentTime(options);
  validateTime(now);
  const observedAt = Math.max(now, budget.lastObservedAtMs);
  const delta = budget.activeWorkers.length === 0
    ? 0
    : observedAt - budget.lastObservedAtMs;
  const activeElapsedMs = Math.min(budget.limitMs, budget.activeElapsedMs + delta);
  return {
    ...budget,
    activeElapsedMs,
    lastObservedAtMs: observedAt,
    exhausted: budget.exhausted || activeElapsedMs >= budget.limitMs
  };
}

export function remainingBudget(
  budget: RunBudgetState,
  options?: BudgetOptions
): number {
  const current = snapshotBudget(budget, options);
  return Math.max(0, current.limitMs - current.activeElapsedMs);
}

export function assertBudgetAvailable(
  budget: RunBudgetState,
  requiredMs = 1,
  options?: BudgetOptions
): RunBudgetState {
  if (!Number.isSafeInteger(requiredMs) || requiredMs < 0) {
    throw new AgentOpsError("RUN_BUDGET_INVALID", "Required budget must be a non-negative safe integer.");
  }
  const current = snapshotBudget(budget, options);
  if (current.exhausted || current.limitMs - current.activeElapsedMs < requiredMs) {
    throw new AgentOpsError("RUN_BUDGET_EXHAUSTED", "The run active-time budget is exhausted.");
  }
  return current;
}

export function startWorker(
  budget: RunBudgetState,
  workerId: string,
  options?: BudgetOptions
): RunBudgetState {
  validateWorkerId(workerId);
  const current = assertBudgetAvailable(budget, 0, options);
  if (current.activeWorkers.includes(workerId)) {
    return current;
  }
  return {
    ...current,
    activeWorkers: [...current.activeWorkers, workerId]
  };
}

export function stopWorker(
  budget: RunBudgetState,
  workerId: string,
  options?: BudgetOptions
): RunBudgetState {
  validateWorkerId(workerId);
  const current = snapshotBudget(budget, options);
  return {
    ...current,
    activeWorkers: current.activeWorkers.filter((value) => value !== workerId)
  };
}

export function pauseBudget(
  budget: RunBudgetState,
  options?: BudgetOptions
): RunBudgetState {
  const current = snapshotBudget(budget, options);
  return { ...current, activeWorkers: [] };
}

export function resumeBudget(
  budget: RunBudgetState,
  options?: BudgetOptions
): RunBudgetState {
  const current = snapshotBudget(budget, options);
  if (current.exhausted) {
    throw new AgentOpsError("RUN_BUDGET_EXHAUSTED", "An exhausted run cannot be resumed.");
  }
  return current;
}

function highWater(value: number | null, incoming: number | null): number | null {
  if (incoming === null) {
    return value;
  }
  return value === null ? incoming : Math.max(value, incoming);
}

/** Merge telemetry without allowing a resumed process to lower a prior high-water mark. */
export function recordUsage(
  usage: readonly UsageHighWater[],
  incoming: UsageHighWater
): UsageHighWater[] {
  const index = usage.findIndex((value) => value.source === incoming.source);
  if (index < 0) {
    return [...usage, incoming];
  }
  const previous = usage[index];
  const sameEpoch = previous.epoch === incoming.epoch;
  const merged: UsageHighWater = sameEpoch
    ? {
        ...incoming,
        inputTokens: highWater(previous.inputTokens, incoming.inputTokens),
        outputTokens: highWater(previous.outputTokens, incoming.outputTokens),
        totalTokens: highWater(previous.totalTokens, incoming.totalTokens),
        costUsd: highWater(previous.costUsd, incoming.costUsd),
        completeness:
          previous.completeness === "complete" || incoming.completeness === "complete"
            ? "complete"
            : previous.completeness === "partial" || incoming.completeness === "partial"
              ? "partial"
              : "unknown"
      }
    : incoming;
  return usage.map((value, currentIndex) => currentIndex === index ? merged : value);
}
