import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {canonicalJson} from "../config/hash.js";
import {sha256} from "../fs/hash.js";
import {AgentOpsError} from "../fs/paths.js";
import {readPrivateFile, writePrivateFile} from "../security/permissions.js";
import type {FinalCandidateProof} from "../parallel/finish.js";
import type {WorktreeRecord} from "../parallel/service.js";
import {FileRunRepository, type RunIntegrationState} from "./service.js";

function ledger(commonDir: string) {return new FileRunRepository(join(commonDir, "agent-ops", "runs"), commonDir);}
function proofPath(commonDir: string, runId: string) {return join(commonDir, "agent-ops", "runs", runId, "integration-proof.json");}

export interface IntegrationReceiptBinding {
  readonly transactionId: string;
  readonly expectedTarget: string;
  readonly candidate: string;
  /** Digest of the immutable transaction identity; receiptDigest is excluded. */
  readonly digest: string;
}

export interface IntegrationGitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type IntegrationGit = (cwd: string, args: readonly string[]) => Promise<IntegrationGitResult>;

function integrationIdentity(integration: Pick<RunIntegrationState, "transactionId" | "expectedTarget" | "candidate">) {
  return {
    transactionId: integration.transactionId,
    expectedTarget: integration.expectedTarget,
    candidate: integration.candidate
  };
}

/** The binding intentionally excludes receiptDigest to avoid a receipt/state cycle. */
export function integrationReceiptBindingDigest(
  integration: Pick<RunIntegrationState, "transactionId" | "expectedTarget" | "candidate">
): string {
  return sha256(canonicalJson(integrationIdentity(integration)));
}

export function integrationReceiptBinding(integration: RunIntegrationState): IntegrationReceiptBinding {
  return {...integrationIdentity(integration), digest: integrationReceiptBindingDigest(integration)};
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate the immutable run transaction fields embedded in a final receipt. */
export function validateRunIntegrationReceipt(
  integration: Pick<RunIntegrationState, "transactionId" | "expectedTarget" | "candidate">,
  receipt: { readonly candidateHead?: unknown; readonly targetCommit?: unknown; readonly integrationJournal?: unknown }
): void {
  const binding = receipt.integrationJournal;
  if (receipt.candidateHead !== integration.candidate || receipt.targetCommit !== integration.expectedTarget ||
      !plain(binding) || binding.transactionId !== integration.transactionId ||
      binding.expectedTarget !== integration.expectedTarget || binding.candidate !== integration.candidate ||
      binding.digest !== integrationReceiptBindingDigest(integration)) {
    throw new AgentOpsError("RUN_INTEGRATION_RECEIPT_INVALID", "The final receipt is not bound to the sealed integration transaction.");
  }
}

async function readSealedProof(
  commonDir: string,
  runId: string,
  integration: RunIntegrationState
): Promise<FinalCandidateProof> {
  const source = await readPrivateFile(proofPath(commonDir, runId), commonDir);
  if (source === null || integration.proofDigest === undefined || sha256(source) !== integration.proofDigest) {
    throw new AgentOpsError("RUN_INTEGRATION_PROOF_CHANGED", "The sealed integration proof is missing or changed.");
  }
  let value: unknown;
  try { value = JSON.parse(source) as unknown; } catch (cause) {
    throw new AgentOpsError("RUN_INTEGRATION_PROOF_CHANGED", "The sealed integration proof is not valid JSON.", {cause});
  }
  if (!plain(value) || value.target !== integration.expectedTarget || value.head !== integration.candidate) {
    throw new AgentOpsError("RUN_INTEGRATION_PROOF_CHANGED", "Integration proof no longer matches the frozen target and candidate.");
  }
  return value as unknown as FinalCandidateProof;
}

/** Seal the exact final gate before any target mutation. Recovery cannot invent a new proof. */
export async function prepareRunIntegration(commonDir: string, record: WorktreeRecord, proof: FinalCandidateProof): Promise<void> {
  if (record.runId === undefined) return;
  const repository = ledger(commonDir);
  const state = await repository.read(record.runId);
  if (state === null || state.ownerSessionId !== record.sessionId || state.coordinatorId !== record.workerId ||
    state.status !== "active" || state.disableRestart || state.workers.some(worker =>
      ["assigned", "starting", "running", "idle", "handing-off"].includes(worker.status)))
    throw new AgentOpsError("RUN_INTEGRATION_OWNERSHIP", "Final integration requires the stopped registered coordinator and current active run.");
  if (state.integration !== null) {
    if (state.integration.status !== "prepared")
      throw new AgentOpsError("RUN_INTEGRATION_RECOVERY_REQUIRED", "Reconcile the existing integration before preparing another candidate.");
    const sealed = await readSealedProof(commonDir, record.runId, state.integration);
    if (canonicalJson(sealed) !== canonicalJson(proof))
      throw new AgentOpsError("RUN_INTEGRATION_RECOVERY_REQUIRED", "The existing sealed integration cannot be replaced by a new proof.");
    return;
  }
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
  return await readSealedProof(commonDir, record.runId, state.integration);
}

/** A failed pre-merge CAS may be retried only after archiving the unused sealed transaction. */
export async function abandonPreparedRunIntegration(commonDir: string, record: WorktreeRecord, git: IntegrationGit): Promise<void> {
  if (record.runId === undefined) return;
  const repository = ledger(commonDir);
  const state = await repository.read(record.runId);
  const transaction = state?.integration;
  if (state === null || transaction == null) return;
  if (transaction.status !== "prepared" || state.ownerSessionId !== record.sessionId || state.coordinatorId !== record.workerId ||
      state.workers.some(worker => ["assigned", "starting", "running", "idle", "handing-off"].includes(worker.status)))
    throw new AgentOpsError("RUN_INTEGRATION_RECOVERY_REQUIRED", "Only a stopped, unused prepared transaction may be superseded.");
  const target = await git(state.root, ["rev-parse", state.targetBranch + "^{commit}"]);
  const commit = target.stdout.trim();
  const ancestry = await git(state.root, ["merge-base", "--is-ancestor", transaction.candidate, commit]);
  if (target.exitCode !== 0 || commit === transaction.expectedTarget || commit === transaction.candidate || ancestry.exitCode !== 1)
    throw new AgentOpsError("RUN_INTEGRATION_RECOVERY_REQUIRED", "The old candidate may have reached the target; preserve and recover its sealed transaction.");
  const proof = await readSealedProof(commonDir, record.runId, transaction);
  await repository.mutate(record.runId, async current => {
    const actual = await git(state.root, ["rev-parse", state.targetBranch + "^{commit}"]);
    if (current.revision !== state.revision || actual.exitCode !== 0 || actual.stdout.trim() !== commit)
      throw new AgentOpsError("RUN_INTEGRATION_STALE", "Run or target changed while superseding an unused transaction.");
    const path = join(commonDir, "agent-ops", "runs", record.runId!, "integration-history", transaction.transactionId + ".json");
    await writePrivateFile(path, JSON.stringify({transaction, proof, observedTarget: commit}), commonDir);
    return {...current, integration: null};
  });
}

/** Read the binding used by a finish receipt without trusting caller-supplied transaction fields. */
export async function readRunIntegrationReceiptBinding(
  commonDir: string,
  record: WorktreeRecord,
  expected: { readonly target: string; readonly candidate: string }
): Promise<IntegrationReceiptBinding | null> {
  if (record.runId === undefined) return null;
  const state = await ledger(commonDir).read(record.runId);
  if (state === null || state.integration === null)
    throw new AgentOpsError("RUN_INTEGRATION_REQUIRED", "A run-owned final receipt requires a sealed integration transaction.");
  if (state.ownerSessionId !== record.sessionId || state.coordinatorId !== record.workerId)
    throw new AgentOpsError("RUN_INTEGRATION_OWNERSHIP", "The integration transaction belongs to another coordinator.");
  await readSealedProof(commonDir, record.runId, state.integration);
  if (state.integration.expectedTarget !== expected.target || state.integration.candidate !== expected.candidate)
    throw new AgentOpsError("RUN_INTEGRATION_PROOF_CHANGED", "The receipt candidate does not match the sealed integration transaction.");
  return integrationReceiptBinding(state.integration);
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

interface RecoveryReceipt {
  readonly candidateHead?: unknown;
  readonly targetCommit?: unknown;
  readonly sessionId?: unknown;
  readonly integrationJournal?: unknown;
}

/**
 * Finish bookkeeping after a coordinator checkout vanished. This only verifies
 * sealed artifacts and advances the ledger; it never recreates a checkout or
 * starts a native writer.
 */
export async function recoverRunIntegrationAfterCleanup(
  commonDir: string,
  runId: string,
  git: IntegrationGit
): Promise<{ readonly transactionId: string; readonly receiptPath: string; readonly receiptDigest: string }> {
  const repository = ledger(commonDir);
  const state = await repository.read(runId);
  if (state === null || state.integration === null)
    throw new AgentOpsError("RUN_INTEGRATION_REQUIRED", "There is no sealed integration to recover.");
  const integration = state.integration;
  if (state.workers.some(worker => ["assigned", "starting", "running", "idle", "handing-off"].includes(worker.status)))
    throw new AgentOpsError("RUN_INTEGRATION_RECOVERY_REQUIRED", "Integration cleanup cannot be recovered while a writer is active.");
  await readSealedProof(commonDir, runId, integration);
  if (integration.status !== "cleaned" &&
      (integration.status !== "receipt-written" || !integration.completedSteps.includes("receipt") ||
       !integration.completedSteps.includes("note"))) {
    throw new AgentOpsError("RUN_INTEGRATION_RECOVERY_REQUIRED", "Recovery requires a recorded receipt and Git note before cleanup can be completed.");
  }
  const target = await git(state.root, ["rev-parse", state.targetBranch + "^{commit}"]);
  if (target.exitCode !== 0 || target.stdout.trim() !== integration.candidate)
    throw new AgentOpsError("RUN_INTEGRATION_TARGET_CHANGED", "The target does not contain the sealed integration candidate.");
  if (integration.receiptPath === null || integration.receiptDigest === null)
    throw new AgentOpsError("RUN_INTEGRATION_RECOVERY_REQUIRED", "The integration has no sealed receipt.");
  const source = await readPrivateFile(integration.receiptPath, commonDir);
  if (source === null || sha256(source) !== integration.receiptDigest)
    throw new AgentOpsError("RUN_INTEGRATION_RECEIPT_INVALID", "The recorded integration receipt is missing or changed.");
  let receipt: RecoveryReceipt;
  try {
    const value = JSON.parse(source) as unknown;
    if (!plain(value)) throw new Error("receipt is not an object");
    receipt = value as RecoveryReceipt;
  } catch (cause) {
    throw new AgentOpsError("RUN_INTEGRATION_RECEIPT_INVALID", "The recorded integration receipt is not valid JSON.", {cause});
  }
  if (receipt.sessionId !== state.ownerSessionId) throw new AgentOpsError("RUN_INTEGRATION_RECEIPT_INVALID", "The receipt belongs to another run owner.");
  validateRunIntegrationReceipt(integration, receipt);
  const note = await git(state.root, ["notes", "--ref=agent-ops", "show", integration.candidate]);
  const noteText = note.stdout;
  if (note.exitCode !== 0 || !noteText.includes(`session: ${state.ownerSessionId}`) ||
      !noteText.includes(`receipt: ${integration.receiptPath}`) ||
      !noteText.includes(`receipt-sha256: ${integration.receiptDigest}`)) {
    throw new AgentOpsError("RUN_INTEGRATION_RECOVERY_REQUIRED", "The sealed receipt is not bound by the Git note for the candidate.");
  }
  await repository.mutate(runId, current => {
    if (current.integration === null || current.integration.transactionId !== integration.transactionId ||
        current.integration.candidate !== integration.candidate || current.integration.expectedTarget !== integration.expectedTarget)
      throw new AgentOpsError("RUN_INTEGRATION_STALE", "The integration changed during recovery.");
    if (current.integration.status === "cleaned") return current;
    if (current.integration.status !== "receipt-written")
      throw new AgentOpsError("RUN_INTEGRATION_RECOVERY_REQUIRED", "The integration is not at the cleanup recovery boundary.");
    return {...current, integration: {...current.integration, status: "cleaned",
      completedSteps: [...new Set([...current.integration.completedSteps, "coordinator"])], updatedAt: new Date().toISOString()}};
  });
  return {transactionId: integration.transactionId, receiptPath: integration.receiptPath, receiptDigest: integration.receiptDigest};
}
