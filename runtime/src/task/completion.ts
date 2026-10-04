import type { AgentOpsConfig } from "../contracts.js";
import { calculateConfigHash } from "../config/hash.js";
import { findReviewAttestation } from "../review/attestation.js";
import { validateEvidence, validateTaskAgainstConfig } from "../schema/validate.js";
import { isPassingVerificationEvidence, type FileEvidenceStore } from "../verify/evidence.js";
import {taskContractHash} from "./contract.js";
import {acceptanceCoverage} from "../verify/acceptance-coverage.js";
import type { StoredTaskRecord } from "./store.js";

interface CompletionProblem {
  readonly code: string;
  readonly status: "FAIL";
  readonly remedy: string;
}

export async function checkTaskCompletionEvidence(
  stored: StoredTaskRecord,
  options: {
    readonly root: string;
    readonly config: AgentOpsConfig;
    readonly sourceFingerprint: string;
    readonly evidenceStore: FileEvidenceStore;
  }
): Promise<CompletionProblem | null> {
  const problem = await checkTaskVerificationEvidence(stored, options);
  if (problem !== null) return problem;
  const attestation = await findReviewAttestation(options.root, options.sourceFingerprint, stored.task.id);
  if (attestation === null || attestation.taskId !== stored.task.id ||
      ((stored.task.criteria.some(c => c.acceptance !== undefined) || (stored.task.contractRevision ?? 0) > 0 || stored.task.goal !== undefined) &&
       (attestation.schemaVersion !== 3 || attestation.taskContracts?.[stored.task.id] !== taskContractHash(stored.task))) ||
      (attestation.tree !== undefined && stored.task.criteria.some((criterion) =>
        !attestation.tree!.criterionIds.includes(`${stored.task.id}:${criterion.id}`)))) {
    return { status: "FAIL", code: "REVIEW_REQUIRED", remedy: `Run agent-ops review --task ${stored.task.id} --yes for the whole task and current source.` };
  }
  return null;
}

/** The same mechanical proof check used by final completion and child delivery. */
export async function checkTaskVerificationEvidence(
  stored: StoredTaskRecord,
  options: {
    readonly root: string;
    readonly config: AgentOpsConfig;
    readonly sourceFingerprint: string;
    readonly evidenceStore: FileEvidenceStore;
  }
): Promise<CompletionProblem | null> {
  const { config, sourceFingerprint, evidenceStore } = options;
  if (stored.failureFingerprint !== null) {
    return { status: "FAIL", code: "VERIFICATION_FAILED", remedy: "Resolve the latest verification failure before completing the task." };
  }
  const configHash = calculateConfigHash(config);
  if (!validateTaskAgainstConfig(stored.task, config).ok || stored.policyConfigHash !== configHash) {
    return { status: "FAIL", code: "TASK_STALE", remedy: "Recreate the task against the current config, then verify and review it." };
  }
  for (const criterion of stored.task.criteria) {
    const commands = config.verification.commands.filter(({ id, required }) => required &&
      (criterion.acceptance !== undefined || criterion.verifierIds.includes(id)));
    if (commands.length === 0 && criterion.acceptance === undefined) {
      return { status: "FAIL", code: "REQUIRED_VERIFIER_MISSING", remedy: "Configure a required verifier for every criterion, then recreate, verify and review the task." };
    }
    for (const command of commands) {
      let latest;
      for (const reference of stored.evidence[criterion.id] ?? []) {
        if (reference.startsWith("review:")) continue;
        const validation = validateEvidence(await evidenceStore.load(reference));
        if (!validation.ok) continue;
        const evidence = validation.value;
        if (command.evidence.kind === "test-count" && evidence.schemaVersion === 2) continue;
        if (evidence.taskId === stored.task.id && evidence.criterionId === criterion.id &&
          evidence.commandId === command.id && evidence.configHash === configHash &&
          evidence.sourceFingerprint === sourceFingerprint &&
          ((stored.task.goal === undefined && (stored.task.contractRevision ?? 0) === 0 && stored.task.criteria.every(c => c.acceptance === undefined)) || evidence.taskContractHash === taskContractHash(stored.task)) &&
          (latest === undefined || Date.parse(evidence.finishedAt) > Date.parse(latest.finishedAt) ||
            (Date.parse(evidence.finishedAt) === Date.parse(latest.finishedAt) && !isPassingVerificationEvidence(command, evidence)))) {
          latest = evidence;
        }
      }
      if (latest === undefined || !isPassingVerificationEvidence(command, latest)) {
        return { status: "FAIL", code: "EVIDENCE_REQUIRED", remedy: "Run agent-ops verify and supply current PASS evidence for every required verifier." };
      }
    }
  }
  const coverage = await acceptanceCoverage(stored, config, sourceFingerprint, evidenceStore);
  if (coverage.some(row => (row.mode === "behavioral" || row.mode === "invariant") && row.status !== "proven")) {
    return {status: "FAIL", code: "ACCEPTANCE_EVIDENCE_REQUIRED", remedy: "Run current paired acceptance checks; UNKNOWN and non-discriminating checks do not prove a criterion."};
  }
  return null;
}

/** Include descendants so legacy completed children cannot hide unfinished work. */
export function findIncompleteSubtask(
  records: readonly StoredTaskRecord[],
  taskId: string
): StoredTaskRecord | undefined {
  const descendants = new Set([taskId]);
  let previousSize = 0;
  while (previousSize !== descendants.size) {
    previousSize = descendants.size;
    for (const record of records) {
      if (record.supersededBy !== undefined) continue;
      if (record.task.parentTaskId !== undefined && descendants.has(record.task.parentTaskId)) {
        descendants.add(record.task.id);
        if (record.status === "active" || record.completedAt === null || record.failureFingerprint !== null) return record;
      }
    }
  }
  return undefined;
}
