import { AgentOpsError } from "../fs/paths.js";
import { MAX_ACTIVE_WORKERS, type RunRepository, type RunState, type RunTaskNode, type RunWorkerRecord } from "./service.js";

export interface SchedulePlan {
  readonly ready: readonly RunTaskNode[];
  readonly running: readonly RunTaskNode[];
  readonly blocked: readonly RunTaskNode[];
  readonly availableSlots: number;
}

export interface FailureRound {
  readonly taskId: string;
  readonly failureId: string;
  readonly failureClass: string;
  readonly diagnosticDigest: string | null;
  readonly usefulProgress: boolean;
}

const ID = /^[A-Za-z0-9._:/-]{1,256}$/u;

function error(code: string, message: string): AgentOpsError {
  return new AgentOpsError(code, message);
}

function replaceTask(state: RunState, taskId: string, update: Partial<RunTaskNode>): RunState {
  const index = state.tasks.findIndex((task) => task.taskId === taskId);
  if (index < 0) throw error("RUN_TASK_NOT_FOUND", `Run task not found: ${taskId}`);
  const tasks = [...state.tasks];
  tasks[index] = { ...tasks[index]!, ...update };
  return { ...state, tasks };
}

function dependencyState(tasks: readonly RunTaskNode[], task: RunTaskNode): "ready" | "waiting" | "blocked" {
  const byId = new Map(tasks.map((candidate) => [candidate.taskId, candidate]));
  let waiting = false;
  for (const dependency of task.dependencies) {
    const parent = byId.get(dependency);
    if (parent === undefined || parent.status === "blocked") return "blocked";
    if (!["delivered", "complete"].includes(parent.status)) waiting = true;
  }
  return waiting ? "waiting" : "ready";
}

/** Validate the explicit dependency DAG; parentTaskId alone is not enough. */
export function validateRunDag(tasks: readonly RunTaskNode[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!ID.test(task.taskId) || ids.has(task.taskId)) throw error("RUN_DAG_INVALID", `Task identity is duplicated or invalid: ${task.taskId}`);
    ids.add(task.taskId);
    if (task.dependencies.some((dependency) => dependency === task.taskId || !ID.test(dependency))) {
      throw error("RUN_DAG_INVALID", `Task ${task.taskId} has an invalid self or malformed dependency.`);
    }
  }
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) throw error("RUN_DAG_MISSING_DEPENDENCY", `Task ${task.taskId} depends on missing ${dependency}.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw error("RUN_DAG_CYCLE", `Run task dependency cycle includes ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.taskId);
}

export function planSchedule(state: RunState): SchedulePlan {
  validateRunDag(state.tasks);
  const running = state.tasks.filter((task) => task.status === "running" || task.status === "awaiting-delivery");
  const blocked = state.tasks.filter((task) => task.status === "blocked");
  const ready = state.tasks.filter((task) => ["planned", "ready"].includes(task.status) && dependencyState(state.tasks, task) === "ready");
  return {
    ready,
    running,
    blocked,
    availableSlots: Math.max(0, Math.min(state.jobs, MAX_ACTIVE_WORKERS) - running.length)
  };
}

/**
 * Compute whole-run active wall time as the union of intervals. This prevents
 * two parallel writers from doubling the 60-minute run budget.
 */
export function activeWallTimeMs(
  intervals: readonly { readonly startMs: number; readonly endMs: number | null }[],
  nowMs: number
): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw error("RUN_CLOCK_INVALID", "Budget clock is invalid.");
  const sorted = intervals
    .map(({ startMs, endMs }) => ({ startMs, endMs: endMs ?? nowMs }))
    .filter(({ startMs, endMs }) => Number.isFinite(startMs) && Number.isFinite(endMs) && startMs >= 0 && endMs >= startMs)
    .sort((left, right) => left.startMs - right.startMs);
  let total = 0;
  let start: number | null = null;
  let end = 0;
  for (const interval of sorted) {
    if (start === null) {
      start = interval.startMs;
      end = interval.endMs;
      continue;
    }
    if (interval.startMs <= end) {
      end = Math.max(end, interval.endMs);
      continue;
    }
    total += end - start;
    start = interval.startMs;
    end = interval.endMs;
  }
  return start === null ? 0 : total + end - start;
}

export function budgetExpired(state: RunState, now = Date.now()): boolean {
  return activeWallTimeMs(state.budget.activeIntervals, now) >= state.budget.limitMs;
}

/** Two consecutive identical failure rounds without a useful change stop one child. */
export function noProgressForTwoRounds(rounds: readonly FailureRound[]): boolean {
  if (rounds.length < 2) return false;
  const current = rounds[rounds.length - 1]!;
  const previous = rounds[rounds.length - 2]!;
  return !current.usefulProgress && !previous.usefulProgress &&
    current.taskId === previous.taskId &&
    current.failureClass === previous.failureClass &&
    current.failureId === previous.failureId &&
    current.diagnosticDigest === previous.diagnosticDigest;
}

export interface SchedulerOptions {
  readonly repository: RunRepository;
  readonly now?: () => string;
}

/** Persistent scheduler operations. Native writers are started by supervisor. */
export class RunScheduler {
  readonly #repository: RunRepository;
  readonly #now: () => string;

  constructor(options: SchedulerOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async addTasks(runId: string, tasks: readonly RunTaskNode[]): Promise<RunState> {
    return await this.#repository.mutate(runId, (current) => {
      if (current.status !== "active" || current.disableRestart) throw error("RUN_NOT_ACTIVE", "Only an active run can plan workers.");
      const combined = [...current.tasks, ...tasks.map((task) => ({ ...task, status: "planned" as const, workerId: null, deliveryDigest: null, sourceCommit: null, blockedReason: null }))];
      validateRunDag(combined);
      if (combined.length > 512) throw error("RUN_DAG_INVALID", "Run task limit exceeded.");
      return { ...current, tasks: combined };
    });
  }

  async plan(runId: string): Promise<SchedulePlan> {
    const state = await this.#repository.read(runId);
    if (state === null) throw error("RUN_NOT_FOUND", `Run not found: ${runId}`);
    return planSchedule(state);
  }

  async markReady(runId: string): Promise<RunState> {
    return await this.#repository.mutate(runId, (current) => {
      validateRunDag(current.tasks);
      let next = current;
      for (const task of [...next.tasks]) {
        if (!["planned", "ready"].includes(task.status)) continue;
        const state = dependencyState(next.tasks, task);
        if (state === "blocked") next = replaceTask(next, task.taskId, { status: "blocked", blockedReason: "dependency-blocked" });
        else if (state === "ready") next = replaceTask(next, task.taskId, { status: "ready" });
      }
      return next;
    });
  }

  async markDelivered(runId: string, taskId: string, deliveryDigest: string, sourceCommit: string): Promise<RunState> {
    return await this.#repository.mutate(runId, (current) => {
      const task = current.tasks.find((candidate) => candidate.taskId === taskId);
      if (task === undefined) throw error("RUN_TASK_NOT_FOUND", `Run task not found: ${taskId}`);
      if (task.status === "delivered" && task.deliveryDigest === deliveryDigest && task.sourceCommit === sourceCommit) return current;
      if (!["running", "awaiting-delivery", "ready"].includes(task.status)) throw error("RUN_TASK_STATE_INVALID", `Task ${taskId} cannot be delivered from ${task.status}.`);
      return replaceTask(current, taskId, { status: "delivered", deliveryDigest, sourceCommit });
    });
  }

  async completeTask(runId: string, taskId: string): Promise<RunState> {
    return await this.#repository.mutate(runId, (current) => {
      const task = current.tasks.find((candidate) => candidate.taskId === taskId);
      if (task === undefined || task.status !== "delivered") throw error("RUN_TASK_NOT_DELIVERED", `Task ${taskId} is not delivered.`);
      return replaceTask(current, taskId, { status: "complete" });
    });
  }

  async blockTaskAndDependents(runId: string, taskId: string, reason: string): Promise<RunState> {
    const boundedReason = reason.slice(0, 4096);
    return await this.#repository.mutate(runId, (current) => {
      const ids = new Set<string>([taskId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of current.tasks) {
          if (task.dependencies.some((dependency) => ids.has(dependency)) && !ids.has(task.taskId)) {
            ids.add(task.taskId);
            changed = true;
          }
        }
      }
      let next = current;
      for (const id of ids) {
        const task = next.tasks.find((candidate) => candidate.taskId === id);
        if (task !== undefined && task.status !== "complete") next = replaceTask(next, id, { status: "blocked", blockedReason: boundedReason });
      }
      return next;
    });
  }

  /** Return only tasks which are safe to assign in this scheduling turn. */
  async next(runId: string): Promise<readonly RunTaskNode[]> {
    const plan = await this.plan(runId);
    return plan.ready.slice(0, plan.availableSlots);
  }

  /** Useful for status output and for native adapters that report worker state. */
  async workerCount(runId: string): Promise<number> {
    const state = await this.#repository.read(runId);
    if (state === null) throw error("RUN_NOT_FOUND", `Run not found: ${runId}`);
    return state.workers.filter((worker: RunWorkerRecord) => ["assigned", "starting", "running", "idle", "handing-off"].includes(worker.status)).length;
  }

  async openBudgetInterval(runId: string, startMs: number): Promise<RunState> {
    if (!Number.isSafeInteger(startMs) || startMs < 0) throw error("RUN_CLOCK_INVALID", "Budget interval start is invalid.");
    return await this.#repository.mutate(runId, (current) => {
      if (current.budget.activeIntervals.some((interval) => interval.startMs === startMs && interval.endMs === null)) return current;
      return {
        ...current,
        budget: {
          ...current.budget,
          activeIntervals: [...current.budget.activeIntervals, { startMs, endMs: null }]
        }
      };
    });
  }

  async closeBudgetInterval(runId: string, startMs: number, endMs: number): Promise<RunState> {
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs < startMs) throw error("RUN_CLOCK_INVALID", "Budget interval is invalid.");
    return await this.#repository.mutate(runId, (current) => {
      let closed = false;
      const intervals = current.budget.activeIntervals.map((interval) => {
        if (!closed && interval.startMs === startMs && interval.endMs === null) {
          closed = true;
          return { ...interval, endMs };
        }
        return interval;
      });
      const accumulatedMs = activeWallTimeMs(intervals, endMs);
      return { ...current, budget: { ...current.budget, activeIntervals: intervals, accumulatedMs, lastObservedAt: new Date(endMs).toISOString() } };
    });
  }

  async refreshBudget(runId: string, nowMs = Date.now()): Promise<RunState> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw error("RUN_CLOCK_INVALID", "Budget clock is invalid.");
    return await this.#repository.mutate(runId, (current) => {
      const accumulatedMs = activeWallTimeMs(current.budget.activeIntervals, nowMs);
      const expired = accumulatedMs >= current.budget.limitMs;
      return {
        ...current,
        status: expired && ["active", "awaiting-input"].includes(current.status) ? "budget-limited" : current.status,
        budget: { ...current.budget, accumulatedMs, lastObservedAt: new Date(nowMs).toISOString() }
      };
    });
  }
}
