import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {sha256} from "../fs/hash.js";
import {AgentOpsError} from "../fs/paths.js";
import {readPrivateFile, writePrivateFile} from "../security/permissions.js";
import type {FinalCandidateProof} from "../parallel/finish.js";
import type {WorktreeRecord} from "../parallel/service.js";
import {FileRunRepository, type RunIntegrationState} from "./service.js";

function ledger(commonDir: string) {return new FileRunRepository(join(commonDir, "agent-ops", "runs"), commonDir);}
function proofPath(commonDir: string, runId: string) {return join(commonDir, "agent-ops", "runs", runId, "integration-proof.json");}

/** Seal the exact final gate before any target mutation. Recovery cannot invent a new proof. */
export async function prepareRunIntegration(commonDir: string, record: WorktreeRecord, proof: FinalCandidateProof): Promise<void> {
  if (record.runId === undefined) return;
  const repository = ledger(commonDir);
  const state = await repository.read(record.runId);
  if (state === null || state.ownerSessionId !== record.sessionId || state.coordinatorId !== record.workerId ||
    state.status !== "active" || state.disableRestart || state.workers.some(worker =>
      ["assigned", "starting", "running", "idle", "handing-off"].includes(worker.status)))
    throw new AgentOpsError("RUN_INTEGRATION_OWNERSHIP", "Final integration requires the stopped registered coordinator and current active run.");
  if (state.integration !== null && state.integration.status !== "prepared")
    throw new AgentOpsError("RUN_INTEGRATION_RECOVERY_REQUIRED", "Reconcile the existing integration before preparing another candidate.");
  const source = JSON.stringify(proof);
  await repository.mutate(record.runId, async current => {
    if (current.status !== "active" || current.disableRestart || current.revision !== state.revision)
      throw new AgentOpsError("RUN_INTEGRATION_STALE", "Run changed while sealing final proof.");
    await writePrivateFile(proofPath(commonDir, record.runId!), source, commonDir);
    return {...current, integration: {transactionId: randomUUID(), status: "prepared", expectedTarget: proof.target,
      candidate: proof.head, proofDigest: sha256(source), completedSteps: [], receiptPath: null, receiptDigest: null,
      updatedAt: new Date().toISOString(), childDeliveries: proof.children.map(child => child.commit)}};
  });
}

export async function readRunIntegrationProof(commonDir: string, record: WorktreeRecord): Promise<FinalCandidateProof | null> {
  if (record.runId === undefined) return null;
  const state = await ledger(commonDir).read(record.runId);
  if (state?.integration == null) return null;
  if (state.ownerSessionId !== record.sessionId || state.coordinatorId !== record.workerId)
    throw new AgentOpsError("RUN_INTEGRATION_OWNERSHIP", "Recovery coordinator does not match the sealed transaction.");
  const source = await readPrivateFile(proofPath(commonDir, record.runId), commonDir);
  if (source === null || sha256(source) !== state.integration.proofDigest)
    throw new AgentOpsError("RUN_INTEGRATION_PROOF_CHANGED", "The sealed integration proof is missing or changed.");
  const proof = JSON.parse(source) as FinalCandidateProof;
  if (proof.target !== state.integration.expectedTarget || proof.head !== state.integration.candidate)
    throw new AgentOpsError("RUN_INTEGRATION_PROOF_CHANGED", "Integration proof no longer matches the frozen target and candidate.");
  return proof;
}

export async function markRunIntegration(commonDir: string, record: WorktreeRecord,
  status: RunIntegrationState["status"], step: string, receipt?: {path: string; digest: string}): Promise<void> {
  if (record.runId === undefined) return;
  await ledger(commonDir).mutate(record.runId, current => {
    if (current.integration === null || current.ownerSessionId !== record.sessionId || current.coordinatorId !== record.workerId)
      throw new AgentOpsError("RUN_INTEGRATION_OWNERSHIP", "The integration transaction is missing or belongs to another coordinator.");
    return {...current, integration: {...current.integration, status, updatedAt: new Date().toISOString(),
      completedSteps: [...new Set([...current.integration.completedSteps, step])],
      ...(receipt === undefined ? {} : {receiptPath: receipt.path, receiptDigest: receipt.digest})}};
  });
}
