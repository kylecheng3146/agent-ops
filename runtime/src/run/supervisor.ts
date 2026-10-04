import { randomUUID } from "node:crypto";

import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import {
  MAX_ACTIVE_WORKERS,
  type RunFailure,
  type RunRepository,
  type RunState,
  type RunStopIntent,
  type RunWorkerRecord,
  type RunWorkerStatus
} from "./service.js";

/** A transport owned by F1/native code. It never decides agent-ops completion. */
export interface NativeGoalHost {
  readonly host: "claude" | "codex";
  start(input: {
    readonly runId: string;
    readonly workerId: string;
    readonly taskId: string;
    readonly goal: string;
    readonly ownerSessionId: string;
    readonly generation: number;
    readonly worktree: string | null;
    readonly contractHash: string | null;
  }): Promise<NativeSessionIdentity>;
  inspect(input: NativeSessionIdentity): Promise<NativeSessionObservation>;
  resume(input: NativeSessionIdentity & { readonly goal: string; readonly generation: number; readonly contractHash: string | null }): Promise<void>;
  send(input: NativeSessionIdentity & { readonly message: string; readonly generation: number }): Promise<void>;
  stop(input: NativeSessionIdentity & { readonly reason: string; readonly generation: number }): Promise<void>;
}

export interface NativeSessionIdentity {
  readonly nativeSessionId: string;
  readonly nativeJobId: string | null;
  readonly processId: number | null;
  readonly processIdentity: string | null;
  readonly instance: string | null;
}

export interface NativeSessionObservation {
  readonly nativeGoalState: "inactive" | "active" | "paused" | "complete" | "cleared" | "unknown";
  readonly processAlive: boolean;
  readonly processIdentity: string | null;
  readonly stateDigest: string | null;
  readonly usage?: {
    readonly tokens?: number;
    readonly usd?: number;
    readonly highWaterMark?: number;
    readonly complete?: boolean;
  };
}

export interface WorkerRegistration {
  readonly workerId: string;
  readonly taskId: string;
  readonly ownerSessionId: string;
  readonly generation: number;
  readonly worktree: string | null;
}

export interface HandoffRequest {
  readonly workerId: string;
  readonly generation: number;
  readonly deliveryDigest: string;
  readonly contractDigest: string;
  readonly sourceCommit: string;
  readonly reason?: "handoff" | "stop" | "budget" | "no-progress" | "crash";
}

export interface HandoffResult {
  readonly worker: RunWorkerRecord;
  readonly deliveryDigest: string;
  readonly sourceCommit: string;
  readonly taskId: string;
}

export interface FinalProofInput {
  readonly targetCommit: string;
  readonly candidateCommit: string;
  readonly verificationPass: boolean;
  readonly reviewPass: boolean;
  readonly taskStateComplete: boolean;
  readonly receiptWritten: boolean;
  readonly receiptDigest: string | null;
}

export interface WorkerFailureInput {
  readonly checkId: string | null;
  readonly pinId: string | null;
  readonly failureClass: string;
  readonly fingerprint: string | null;
  readonly diagnosticDigest: string | null;
  readonly round: number;
  readonly usefulProgress: boolean;
}

export interface WorkerFailureResult {
  readonly state: RunState;
  readonly noProgress: boolean;
}

const ID = /^[A-Za-z0-9._:/-]{1,256}$/u;
const SHA = /^[a-f0-9]{40,64}$/u;

function error(code: string, message: string): AgentOpsError {
  return new AgentOpsError(code, message);
}

function assertId(value: string, name: string): string {
  if (!ID.test(value)) throw error("RUN_IDENTITY_INVALID", `${name} is invalid.`);
  return value;
}

function assertSha(value: string, name: string): string {
  if (!SHA.test(value)) throw error("RUN_DIGEST_INVALID", `${name} must be a Git SHA or digest.`);
  return value;
}

function nowIso(now: () => string): string {
  const value = now();
  if (!Number.isFinite(Date.parse(value))) throw error("RUN_CLOCK_INVALID", "Run clock returned an invalid timestamp.");
  return value;
}

function activeWorker(worker: RunWorkerRecord): boolean {
  return ["assigned", "starting", "running", "idle", "handing-off"].includes(worker.status);
}

function replaceWorker(state: RunState, worker: RunWorkerRecord): RunState {
  const index = state.workers.findIndex((candidate) => candidate.workerId === worker.workerId);
  if (index < 0) throw error("RUN_WORKER_NOT_FOUND", `Worker not found: ${worker.workerId}`);
  const workers = [...state.workers];
  workers[index] = worker;
  return { ...state, workers };
}

function replaceTask(state: RunState, taskId: string, update: Partial<RunState["tasks"][number]>): RunState {
  const index = state.tasks.findIndex((candidate) => candidate.taskId === taskId);
  if (index < 0) throw error("RUN_TASK_NOT_FOUND", `Run task not found: ${taskId}`);
  const tasks = [...state.tasks];
  tasks[index] = { ...tasks[index]!, ...update };
  return { ...state, tasks };
}

export interface RunSupervisorOptions {
  readonly repository: RunRepository;
  readonly host: NativeGoalHost;
  readonly now?: () => string;
  readonly leaseMs?: number;
}

/**
 * Owns the mapping between a run worker and a native session. Every write
 * operation is generation checked. A native goal's `complete` state is only
 * an observation; the final proof path is separate and explicit.
 */
export class RunSupervisor {
  readonly #repository: RunRepository;
  readonly #host: NativeGoalHost;
  readonly #now: () => string;
  readonly #leaseMs: number;

  constructor(options: RunSupervisorOptions) {
    this.#repository = options.repository;
    this.#host = options.host;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 1_000 || this.#leaseMs > 10 * 60_000) {
      throw error("RUN_LEASE_INVALID", "Worker lease must be between one second and ten minutes.");
    }
    if (this.#host.host !== "claude" && this.#host.host !== "codex") {
      throw error("RUN_HOST_UNSUPPORTED", "Run workers support Claude and Codex only.");
    }
  }

  async registerWorker(runId: string, input: {
    readonly taskId: string;
    readonly ownerSessionId: string;
    readonly worktree?: string | null;
  }): Promise<WorkerRegistration> {
    assertId(input.taskId, "taskId");
    assertId(input.ownerSessionId, "ownerSessionId");
    const workerId = `worker-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const state = await this.#repository.mutate(runId, (current) => {
      if (current.status !== "active" && current.status !== "awaiting-input") {
        throw error("RUN_NOT_ACTIVE", `Run ${runId} cannot register a worker while ${current.status}.`);
      }
      const running = current.workers.filter(activeWorker).length;
      if (running >= Math.min(current.jobs, MAX_ACTIVE_WORKERS)) {
        throw error("RUN_WORKER_LIMIT", `Run ${runId} already has ${running} active worker(s).`);
      }
      if (current.workers.some((worker) => worker.taskId === input.taskId && activeWorker(worker))) {
        throw error("RUN_TASK_ALREADY_ASSIGNED", `Task ${input.taskId} already has an active worker.`);
      }
      const worker: RunWorkerRecord = {
        workerId,
        taskId: input.taskId,
        host: current.host,
        ownerSessionId: input.ownerSessionId,
        nativeSessionId: null,
        nativeJobId: null,
        worktree: input.worktree ?? null,
        processId: null,
        processIdentity: null,
        generation: 1,
        status: "assigned",
        leaseExpiresAt: null,
        heartbeatAt: null,
        stopIntent: null,
        nativeGoalState: "inactive",
        lastFailure: null
      };
      const next = replaceTask({ ...current, workers: [...current.workers, worker] }, input.taskId, {
        status: "ready",
        workerId
      });
      return { ...next, status: "active" };
    });
    const worker = state.workers.find((candidate) => candidate.workerId === workerId);
    if (worker === undefined) throw error("RUN_WORKER_NOT_FOUND", `Registered worker disappeared: ${workerId}`);
    return { workerId, taskId: input.taskId, ownerSessionId: input.ownerSessionId, generation: worker.generation, worktree: worker.worktree };
  }

  async startWorker(runId: string, workerId: string, generation: number, goal: string): Promise<RunWorkerRecord> {
    assertId(workerId, "workerId");
    if (!Number.isSafeInteger(generation) || generation < 1) throw error("RUN_GENERATION_INVALID", "Worker generation is invalid.");
    const before = await this.#repository.read(runId);
    if (before === null) throw error("RUN_NOT_FOUND", `Run not found: ${runId}`);
    if (before.host !== this.#host.host) throw error("RUN_HOST_MISMATCH", `Run ${runId} is assigned to ${before.host}, not ${this.#host.host}.`);
    const worker = before.workers.find((candidate) => candidate.workerId === workerId);
    if (worker === undefined) throw error("RUN_WORKER_NOT_FOUND", `Worker not found: ${workerId}`);
    if (worker.generation !== generation || worker.status !== "assigned") throw error("RUN_WORKER_STALE", `Worker ${workerId} is no longer assigned at generation ${generation}.`);
    const starting = await this.#repository.mutate(runId, (current) => {
      const currentWorker = current.workers.find((candidate) => candidate.workerId === workerId);
      if (currentWorker === undefined || currentWorker.generation !== generation || currentWorker.status !== "assigned") {
        throw error("RUN_WORKER_STALE", `Worker ${workerId} changed before native start.`);
      }
      return replaceWorker(replaceTask(current, currentWorker.taskId, { status: "running" }), {
        ...currentWorker,
        status: "starting",
        leaseExpiresAt: new Date(Date.parse(this.#now()) + this.#leaseMs).toISOString(),
        heartbeatAt: this.#now()
      });
    });
    const startingWorker = starting.workers.find((candidate) => candidate.workerId === workerId)!;
    let native: NativeSessionIdentity;
    try {
      native = await this.#host.start({
        runId,
        workerId,
        taskId: startingWorker.taskId,
        goal,
        ownerSessionId: startingWorker.ownerSessionId,
        generation,
        worktree: startingWorker.worktree,
        contractHash: before.currentContractHash
      });
    } catch (cause) {
      await this.#repository.mutate(runId, (current) => {
        const currentWorker = current.workers.find((candidate) => candidate.workerId === workerId);
        if (currentWorker === undefined || currentWorker.generation !== generation) return current;
        return replaceWorker(replaceTask(current, currentWorker.taskId, { status: "ready", workerId: null }), {
          ...currentWorker,
          status: "blocked",
          leaseExpiresAt: null,
          heartbeatAt: this.#now(),
          lastFailure: {
            id: randomUUID(), checkId: null, pinId: null, failureClass: "native-start",
            fingerprint: null, diagnosticDigest: null, round: 0, observedAt: this.#now(), usefulProgress: false
          }
        });
      });
      throw new AgentOpsError("RUN_NATIVE_START_FAILED", `Native ${this.#host.host} worker could not start.`, { cause });
    }
    try {
      return (await this.#repository.mutate(runId, (current) => {
        const currentWorker = current.workers.find((candidate) => candidate.workerId === workerId);
        if (currentWorker === undefined || currentWorker.generation !== generation || currentWorker.status !== "starting") {
          throw error("RUN_WORKER_STALE", `Worker ${workerId} changed while native session started.`);
        }
        return {
          ...replaceWorker(current, {
            ...currentWorker,
            status: "running",
            nativeSessionId: native.nativeSessionId,
            nativeJobId: native.nativeJobId,
            processId: native.processId,
            processIdentity: native.processIdentity,
            nativeGoalState: "active",
            leaseExpiresAt: new Date(Date.parse(this.#now()) + this.#leaseMs).toISOString(),
            heartbeatAt: this.#now()
          }),
          nativeInstance: native.instance ?? current.nativeInstance
        };
      })).workers.find((candidate) => candidate.workerId === workerId)!;
    } catch (cause) {
      // A stop/revision may win the race while the host is bootstrapping. Do
      // not leave that unregistered process writing into the worktree.
      try {
        await this.#host.stop({
          nativeSessionId: native.nativeSessionId,
          nativeJobId: native.nativeJobId,
          processId: native.processId,
          processIdentity: native.processIdentity,
          instance: native.instance,
          reason: "worker registration lost during start",
          generation
        });
      } catch {
        // The original stale-registration error is retained; reconcile will
        // keep the run fenced until the host reports process death.
      }
      throw cause;
    }
  }

  async heartbeat(runId: string, workerId: string, generation: number): Promise<RunWorkerRecord> {
    return (await this.#repository.mutate(runId, (current) => {
      const worker = current.workers.find((candidate) => candidate.workerId === workerId);
      if (worker === undefined || worker.generation !== generation || !activeWorker(worker)) throw error("RUN_WORKER_STALE", `Heartbeat rejected for stale worker ${workerId}.`);
      return replaceWorker(current, {
        ...worker,
        heartbeatAt: this.#now(),
        leaseExpiresAt: new Date(Date.parse(this.#now()) + this.#leaseMs).toISOString()
      });
    })).workers.find((candidate) => candidate.workerId === workerId)!;
  }

  /** Resume an existing native session only after the run lease is current. */
  async resumeWorker(runId: string, workerId: string, generation: number, goal: string): Promise<RunWorkerRecord> {
    const state = await this.#repository.read(runId);
    if (state === null) throw error("RUN_NOT_FOUND", `Run not found: ${runId}`);
    if (state.status !== "active" || state.awaitingResume || state.disableRestart) {
      throw error("RUN_RESUME_DISABLED", `Run ${runId} is not eligible for native resume.`);
    }
    const worker = state.workers.find((candidate) => candidate.workerId === workerId);
    if (worker === undefined || worker.generation !== generation || !["idle", "running"].includes(worker.status) || worker.nativeSessionId === null) {
      throw error("RUN_WORKER_STALE", `Worker ${workerId} has no resumable native session at generation ${generation}.`);
    }
    await this.#host.resume({
      nativeSessionId: worker.nativeSessionId,
      nativeJobId: worker.nativeJobId,
      processId: worker.processId,
      processIdentity: worker.processIdentity,
      instance: state.nativeInstance,
      goal,
      generation,
      contractHash: state.currentContractHash
    });
    return (await this.#repository.mutate(runId, (current) => {
      const currentWorker = current.workers.find((candidate) => candidate.workerId === workerId);
      if (currentWorker === undefined || currentWorker.generation !== generation || currentWorker.nativeSessionId !== worker.nativeSessionId) {
        throw error("RUN_WORKER_STALE", `Worker ${workerId} changed while resuming.`);
      }
      return replaceWorker(current, {
        ...currentWorker,
        status: "running",
        nativeGoalState: "active",
        heartbeatAt: this.#now(),
        leaseExpiresAt: new Date(Date.parse(this.#now()) + this.#leaseMs).toISOString()
      });
    })).workers.find((candidate) => candidate.workerId === workerId)!;
  }

  /** Persist a structured FAIL and stop a worker after two identical stagnant rounds. */
  async recordFailure(runId: string, workerId: string, generation: number, input: WorkerFailureInput): Promise<WorkerFailureResult> {
    assertId(workerId, "workerId");
    assertId(input.failureClass, "failureClass");
    if (input.checkId !== null) assertId(input.checkId, "checkId");
    if (input.pinId !== null) assertId(input.pinId, "pinId");
    if (input.fingerprint !== null) assertSha(input.fingerprint, "fingerprint");
    if (input.diagnosticDigest !== null) assertSha(input.diagnosticDigest, "diagnosticDigest");
    if (!Number.isSafeInteger(input.round) || input.round < 0 || typeof input.usefulProgress !== "boolean") {
      throw error("RUN_FAILURE_INVALID", "Structured worker failure has invalid round or progress metadata.");
    }
    const failure: RunFailure = {
      id: randomUUID(),
      checkId: input.checkId,
      pinId: input.pinId,
      failureClass: input.failureClass,
      fingerprint: input.fingerprint,
      diagnosticDigest: input.diagnosticDigest,
      round: input.round,
      observedAt: this.#now(),
      usefulProgress: input.usefulProgress
    };
    const failureEventId = randomUUID();
    const saved = await this.#repository.mutate(runId, (current) => {
      const worker = current.workers.find((candidate) => candidate.workerId === workerId);
      if (worker === undefined || worker.generation !== generation || !activeWorker(worker)) {
        throw error("RUN_WORKER_STALE", `Failure report rejected for stale worker ${workerId}.`);
      }
      const previous = worker.lastFailure;
      const noProgress = previous !== null && !previous.usefulProgress && !failure.usefulProgress &&
        previous.failureClass === failure.failureClass && previous.checkId === failure.checkId && previous.pinId === failure.pinId;
      const next = replaceWorker(current, {
        ...worker,
        lastFailure: failure
      });
      return {
        ...next,
        events: [...next.events, {
          id: failureEventId, at: failure.observedAt, type: "diagnostic" as const, code: noProgress ? "RUN_NO_PROGRESS_REPEAT" : "RUN_FAILURE_RECORDED",
          workerId, taskId: worker.taskId,
          detail: JSON.stringify({ checkId: failure.checkId, pinId: failure.pinId, failureClass: failure.failureClass, fingerprint: failure.fingerprint, diagnosticDigest: failure.diagnosticDigest, round: failure.round, usefulProgress: failure.usefulProgress })
        }].slice(-2_000),
        ...(noProgress ? { status: "active" as const } : {})
      };
    });
    // Keep the transition marker explicit in the event stream and delegate
    // native fencing to stopWorker.
    const repeat = saved.events.some((event) => event.id === failureEventId && event.code === "RUN_NO_PROGRESS_REPEAT");
    if (!repeat) return { state: saved, noProgress: false };
    await this.stopWorker(runId, workerId, generation, "no-progress");
    const blocked = await this.#repository.mutate(runId, (current) => {
      const worker = current.workers.find((candidate) => candidate.workerId === workerId);
      if (worker === undefined) throw error("RUN_WORKER_NOT_FOUND", `Worker not found: ${workerId}`);
      const task = current.tasks.find((candidate) => candidate.taskId === worker.taskId);
      const next = replaceWorker(current, { ...worker, status: "blocked", leaseExpiresAt: null });
      return task === undefined ? next : replaceTask(next, worker.taskId, { status: "blocked", blockedReason: `no-progress:${failure.failureClass}` });
    });
    return { state: blocked, noProgress: true };
  }

  /** Send a bounded structured repair instruction without persisting its text. */
  async sendRepair(runId: string, workerId: string, generation: number, message: string): Promise<void> {
    assertId(workerId, "workerId");
    const clean = message.trim();
    if (clean.length === 0 || clean.length > 16_384 || clean.includes("\0")) throw error("RUN_REPAIR_INVALID", "Repair instruction is empty or too large.");
    const state = await this.#repository.read(runId);
    const worker = state?.workers.find((candidate) => candidate.workerId === workerId);
    if (state === null || state === undefined) throw error("RUN_NOT_FOUND", `Run not found: ${runId}`);
    if (worker === undefined || worker.generation !== generation || !activeWorker(worker) || worker.nativeSessionId === null) {
      throw error("RUN_WORKER_STALE", `Repair rejected for stale worker ${workerId}.`);
    }
    await this.#host.send({
      nativeSessionId: worker.nativeSessionId,
      nativeJobId: worker.nativeJobId,
      processId: worker.processId,
      processIdentity: worker.processIdentity,
      instance: state.nativeInstance,
      message: clean,
      generation
    });
    await this.#repository.appendEvent(runId, {
      type: "diagnostic", code: "RUN_REPAIR_SENT", workerId, taskId: worker.taskId,
      detail: sha256(clean)
    });
  }

  async observeWorker(runId: string, workerId: string, generation: number): Promise<NativeSessionObservation> {
    const state = await this.#repository.read(runId);
    if (state === null) throw error("RUN_NOT_FOUND", `Run not found: ${runId}`);
    const worker = state.workers.find((candidate) => candidate.workerId === workerId);
    if (worker === undefined || worker.generation !== generation || worker.nativeSessionId === null) throw error("RUN_WORKER_STALE", `Worker ${workerId} has no current native session.`);
    const observation = await this.#host.inspect({ nativeSessionId: worker.nativeSessionId, nativeJobId: worker.nativeJobId, processId: worker.processId, processIdentity: worker.processIdentity, instance: state.nativeInstance });
    await this.#repository.mutate(runId, (current) => {
      const currentWorker = current.workers.find((candidate) => candidate.workerId === workerId);
      if (currentWorker === undefined || currentWorker.generation !== generation) return current;
      const idle = observation.processAlive && observation.nativeGoalState !== "active";
      const stoppedUnexpectedly = !observation.processAlive && currentWorker.status !== "handing-off" && currentWorker.status !== "fenced" && currentWorker.status !== "stopped";
      const observed = replaceWorker(current, {
        ...currentWorker,
        status: currentWorker.status === "handing-off" ? currentWorker.status : idle ? "idle" : observation.processAlive ? "running" : "stopped",
        nativeGoalState: observation.nativeGoalState,
        processIdentity: observation.processIdentity ?? currentWorker.processIdentity,
        heartbeatAt: this.#now(),
        leaseExpiresAt: observation.processAlive ? new Date(Date.parse(this.#now()) + this.#leaseMs).toISOString() : null,
        ...(stoppedUnexpectedly ? { generation: currentWorker.generation + 1, nativeSessionId: null, nativeJobId: null } : {})
      });
      return stoppedUnexpectedly
        ? replaceTask(observed, currentWorker.taskId, { status: "ready", workerId: null, blockedReason: "native-process-exited" })
        : observed;
    });
    return observation;
  }

  async beginHandoff(runId: string, request: HandoffRequest): Promise<RunStopIntent> {
    assertId(request.workerId, "workerId");
    assertSha(request.deliveryDigest, "deliveryDigest");
    assertSha(request.contractDigest, "contractDigest");
    assertSha(request.sourceCommit, "sourceCommit");
    const existingState = await this.#repository.read(runId);
    const existingWorker = existingState?.workers.find((candidate) => candidate.workerId === request.workerId);
    const existingIntent = existingWorker?.generation === request.generation && ["handing-off", "fenced", "delivered", "stopped"].includes(existingWorker.status) &&
      existingWorker.stopIntent?.deliveryDigest === request.deliveryDigest && existingWorker.stopIntent.contractDigest === request.contractDigest &&
      existingWorker.stopIntent.sourceCommit === request.sourceCommit
      ? existingWorker.stopIntent
      : null;
    if (existingIntent !== null) return existingIntent;
    const state = await this.#repository.mutate(runId, (current) => {
      const worker = current.workers.find((candidate) => candidate.workerId === request.workerId);
      if (worker === undefined || worker.generation !== request.generation) {
        throw error("RUN_HANDOFF_STALE", `Worker ${request.workerId} cannot hand off at generation ${request.generation}.`);
      }
      if (worker.status === "handing-off" && worker.stopIntent !== null &&
          worker.stopIntent.deliveryDigest === request.deliveryDigest && worker.stopIntent.contractDigest === request.contractDigest) {
        return current;
      }
      if (!["running", "idle"].includes(worker.status)) throw error("RUN_HANDOFF_STALE", `Worker ${request.workerId} cannot hand off from ${worker.status}.`);
      const intent: RunStopIntent = {
        runId,
        workerId: request.workerId,
        generation: request.generation,
        nativeSessionId: worker.nativeSessionId,
        reason: request.reason ?? "handoff",
        deliveryDigest: request.deliveryDigest,
        contractDigest: request.contractDigest,
        sourceCommit: request.sourceCommit,
        expiresAt: new Date(Date.parse(this.#now()) + this.#leaseMs).toISOString(),
        confirmedDeadAt: null
      };
      return replaceWorker(current, { ...worker, status: "handing-off", stopIntent: intent });
    });
    const worker = state.workers.find((candidate) => candidate.workerId === request.workerId)!;
    const intent = worker.stopIntent;
    if (intent === null) throw error("RUN_HANDOFF_MISSING", `Worker ${request.workerId} did not receive a stop intent.`);
    if (worker.nativeSessionId !== null) {
      await this.#host.stop({ nativeSessionId: worker.nativeSessionId, nativeJobId: worker.nativeJobId, processId: worker.processId, processIdentity: worker.processIdentity, instance: state.nativeInstance, reason: "atomic delivery handoff", generation: request.generation });
    }
    return intent;
  }

  async confirmHandoff(runId: string, request: HandoffRequest, confirmation: { readonly processDead: boolean; readonly processIdentity?: string | null }): Promise<HandoffResult> {
    if (!confirmation.processDead) throw error("RUN_HANDOFF_PROCESS_ALIVE", `Worker ${request.workerId} is still alive; delivery remains fenced.`);
    const state = await this.#repository.mutate(runId, (current) => {
      const worker = current.workers.find((candidate) => candidate.workerId === request.workerId);
      if (worker === undefined || worker.generation !== request.generation ||
          worker.stopIntent === null || worker.stopIntent.deliveryDigest !== request.deliveryDigest || worker.stopIntent.contractDigest !== request.contractDigest) {
        throw error("RUN_HANDOFF_MISMATCH", `Worker ${request.workerId} handoff does not match its current stop intent.`);
      }
      if (worker.status === "fenced" && worker.stopIntent.confirmedDeadAt !== null) return current;
      if (worker.status !== "handing-off") throw error("RUN_HANDOFF_MISMATCH", `Worker ${request.workerId} is not awaiting handoff confirmation.`);
      const confirmedAt = this.#now();
      const intent = { ...worker.stopIntent, confirmedDeadAt: confirmedAt };
      const updated = replaceWorker(current, {
        ...worker,
        status: "fenced",
        stopIntent: intent,
        processIdentity: confirmation.processIdentity ?? worker.processIdentity,
        nativeGoalState: "inactive",
        leaseExpiresAt: null,
        heartbeatAt: confirmedAt
      });
      return replaceTask(updated, worker.taskId, { status: "awaiting-delivery" });
    });
    const worker = state.workers.find((candidate) => candidate.workerId === request.workerId)!;
    return { worker, deliveryDigest: request.deliveryDigest, sourceCommit: request.sourceCommit, taskId: worker.taskId };
  }

  async publishDelivery(runId: string, request: HandoffRequest, input: { readonly noChange: boolean; readonly artifactRefs: readonly string[] }): Promise<RunWorkerRecord> {
    const state = await this.#repository.mutate(runId, (current) => {
      const worker = current.workers.find((candidate) => candidate.workerId === request.workerId);
      if (worker === undefined || worker.generation !== request.generation ||
          worker.stopIntent?.confirmedDeadAt === null || worker.stopIntent?.deliveryDigest !== request.deliveryDigest) {
        throw error("RUN_DELIVERY_UNFENCED", `Worker ${request.workerId} must be fenced before delivery.`);
      }
      if (worker.status === "delivered") return current;
      if (worker.status !== "fenced") throw error("RUN_DELIVERY_UNFENCED", `Worker ${request.workerId} must be fenced before delivery.`);
      const next = replaceWorker(current, { ...worker, status: "delivered" });
      const task = next.tasks.find((candidate) => candidate.taskId === worker.taskId);
      if (task === undefined) throw error("RUN_TASK_NOT_FOUND", `Run task not found: ${worker.taskId}`);
      return replaceTask(next, worker.taskId, {
        status: "delivered",
        deliveryDigest: request.deliveryDigest,
        sourceCommit: request.sourceCommit,
        blockedReason: input.noChange ? `verified-no-change:${input.artifactRefs.join(",")}` : null
      });
    });
    return state.workers.find((candidate) => candidate.workerId === request.workerId)!;
  }

  async reconcile(runId: string): Promise<RunState> {
    const before = await this.#repository.read(runId);
    if (before === null) throw error("RUN_NOT_FOUND", `Run not found: ${runId}`);
    for (const worker of before.workers.filter((candidate) => candidate.nativeSessionId !== null && activeWorker(candidate))) {
      try {
        await this.observeWorker(runId, worker.workerId, worker.generation);
      } catch (errorValue) {
        if (errorValue instanceof AgentOpsError && errorValue.code === "RUN_WORKER_STALE") continue;
        throw errorValue;
      }
    }
    return (await this.#repository.mutate(runId, (current) => {
      if (current.awaitingResume || current.disableRestart) return current;
      return { ...current, updatedAt: this.#now() };
    }));
  }

  async finalize(runId: string, proof: FinalProofInput): Promise<RunState> {
    assertSha(proof.targetCommit, "targetCommit");
    assertSha(proof.candidateCommit, "candidateCommit");
    if (!proof.verificationPass || !proof.reviewPass || !proof.taskStateComplete || !proof.receiptWritten || proof.receiptDigest === null) {
      throw error("RUN_FINAL_PROOF_REQUIRED", "Run finalization requires verification, dual review, complete task state, and a receipt.");
    }
    return await this.#repository.mutate(runId, (current) => {
      if (current.workers.some((worker) => activeWorker(worker))) throw error("RUN_WRITERS_ACTIVE", "Stop and fence every writer before finalization.");
      return { ...current, status: "complete", disableRestart: true, awaitingResume: false };
    });
  }

  async stopWorker(runId: string, workerId: string, generation: number, reason: RunStopIntent["reason"]): Promise<RunWorkerRecord> {
    const state = await this.#repository.read(runId);
    if (state === null) throw error("RUN_NOT_FOUND", `Run not found: ${runId}`);
    const worker = state.workers.find((candidate) => candidate.workerId === workerId);
    if (worker === undefined || worker.generation !== generation) throw error("RUN_WORKER_STALE", `Worker ${workerId} is stale.`);
    const request: HandoffRequest = {
      workerId, generation, deliveryDigest: worker.stopIntent?.deliveryDigest ?? "0".repeat(64),
      contractDigest: worker.stopIntent?.contractDigest ?? "0".repeat(64),
      sourceCommit: worker.stopIntent?.deliveryDigest ?? "0".repeat(40), reason
    };
    if (!["running", "idle"].includes(worker.status)) {
      return (await this.#repository.mutate(runId, (current) => replaceWorker(current, { ...worker, status: "stopped", leaseExpiresAt: null }))).workers.find((candidate) => candidate.workerId === workerId)!;
    }
    await this.beginHandoff(runId, request);
    const fencedState = await this.#repository.read(runId);
    const fencedWorker = fencedState?.workers.find((candidate) => candidate.workerId === workerId);
    if (fencedState === null || fencedState === undefined || fencedWorker === undefined || fencedWorker.nativeSessionId === null) {
      throw error("RUN_HANDOFF_MISSING", `Worker ${workerId} lost its native identity while stopping.`);
    }
    const observation = await this.#host.inspect({
      nativeSessionId: fencedWorker.nativeSessionId,
      nativeJobId: fencedWorker.nativeJobId,
      processId: fencedWorker.processId,
      processIdentity: fencedWorker.processIdentity,
      instance: fencedState.nativeInstance
    });
    const confirmed = await this.confirmHandoff(runId, request, {
      processDead: !observation.processAlive,
      ...(observation.processIdentity === null ? {} : { processIdentity: observation.processIdentity })
    });
    return (await this.#repository.mutate(runId, (current) => {
      const currentWorker = current.workers.find((candidate) => candidate.workerId === workerId);
      if (currentWorker === undefined || currentWorker.generation !== generation) throw error("RUN_WORKER_STALE", `Worker ${workerId} changed while stopping.`);
      return replaceWorker(current, { ...currentWorker, status: "stopped", leaseExpiresAt: null });
    })).workers.find((candidate) => candidate.workerId === confirmed.worker.workerId)!;
  }
}

/** The maximum number of writer slots F allows in one run. */
export const MAX_ACTIVE_WRITERS = MAX_ACTIVE_WORKERS;
