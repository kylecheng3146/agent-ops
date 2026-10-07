import {join} from "node:path";
import type {WorktreeRecord} from "../parallel/service.js";
import {FileRunRepository} from "./service.js";

/** The common run ledger, rather than worker-local metadata, grants writer ownership. */
export async function registeredRunWriter(record: WorktreeRecord, sessionId: string, agentId?: string): Promise<boolean> {
  if (record.runId === undefined || record.workerId === undefined || record.workerGeneration === undefined) return false;
  try {
    const common = join(record.mainRoot, ".git");
    const state = await new FileRunRepository(join(common, "agent-ops", "runs"), common).read(record.runId);
    const worker = state?.workers.find(w => w.workerId === record.workerId);
    return state !== null && state !== undefined && state.status === "active" && !state.disableRestart &&
      worker !== undefined && worker.worktree === record.path && worker.generation === record.workerGeneration &&
      worker.ownerSessionId === record.ownerSessionId && state.coordinatorId === record.coordinatorId &&
      ["running", "idle"].includes(worker.status) && worker.stopIntent === null &&
      (worker.nativeSessionId === sessionId || worker.ownerSessionId === sessionId) &&
      worker.leaseExpiresAt !== null && Date.parse(worker.leaseExpiresAt) > Date.now() &&
      (agentId === undefined || agentId === record.agentId);
  } catch {return false;}
}
