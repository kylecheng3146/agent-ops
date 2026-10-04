import type { HookResult } from "../hooks/events.js";
import { readWorktreeRecord, type WorktreeRecord } from "../parallel/service.js";
import { type RunRepository } from "./service.js";

export interface WorkerStopGateInput {
  readonly root: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly runId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly deliveryDigest?: string;
  readonly contractDigest?: string;
}
function blocked(code: string, remedy: string): HookResult {
  return { action: "block", status: "FAIL", code, remedy };
}

/**
 * A worker may stop after its coordinator-issued handoff is fenced. This is a
 * narrow local delivery gate: it does not complete the task, grant root Stop,
 * or accept a native goal's `complete` status as proof.
 */
export async function validateWorkerStopHandoff(
  repository: RunRepository,
  input: WorkerStopGateInput,
  recordReader: (root: string) => Promise<WorktreeRecord | null> = readWorktreeRecord
): Promise<HookResult | null> {
  const record = await recordReader(input.root);
  if (record === null || record.runId !== input.runId || record.workerId !== input.workerId ||
      record.ownerSessionId !== input.sessionId || record.workerGeneration !== input.generation ||
      (record.agentId !== undefined && input.agentId !== undefined && record.agentId !== input.agentId)) {
    return blocked(
      "RUN_WORKER_HANDOFF_UNREGISTERED",
      "This Stop is not a coordinator-registered run worker handoff. Preserve the task and use the normal completion gate."
    );
  }
  const state = await repository.read(input.runId);
  if (state === null) return blocked("RUN_WORKER_RUN_MISSING", "The run ledger is unavailable; do not stop a writer without reconciliation.");
  const worker = state.workers.find((candidate) => candidate.workerId === input.workerId);
  if (worker === undefined || worker.generation !== input.generation) return blocked("RUN_WORKER_GENERATION_STALE", "The worker lease is stale; reconcile the run before stopping this session.");
  const intent = worker.stopIntent;
  if (intent === null || intent.generation !== input.generation || intent.workerId !== input.workerId ||
      (input.deliveryDigest !== undefined && intent.deliveryDigest !== input.deliveryDigest) ||
      (input.contractDigest !== undefined && intent.contractDigest !== input.contractDigest)) {
    return blocked("RUN_WORKER_HANDOFF_REQUIRED", "Native completion is not final proof. Ask the coordinator to create a matching handoff intent first.");
  }
  if (intent.confirmedDeadAt === null || !["fenced", "delivered", "stopped"].includes(worker.status)) {
    return blocked("RUN_WORKER_HANDOFF_PENDING", "The worker is still fenced pending process-death confirmation; Stop remains blocked.");
  }
  return {
    action: "continue",
    status: "PASS",
    code: "RUN_WORKER_HANDOFF_ALLOWED",
    decision: "allow",
    remedy: "Local worker handoff accepted. The task remains active until the coordinator completes final verify, dual review, and receipt proof."
  };
}
