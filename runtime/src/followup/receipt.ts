import { basename, dirname, join } from "node:path";

import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import type { FinishReceipt } from "../parallel/receipt.js";
import { NOTES_REF, type WorktreeDependencies } from "../parallel/service.js";
import { validateReviewPair, type ReviewReportArtifact } from "../review/attestation.js";
import { validateReviewReport, reviewReportStatus } from "../review/report.js";
import { validateTask, validateEvidence } from "../schema/validate.js";
import { readPrivateFile } from "../security/permissions.js";
import { goalHash, taskContractHash, treeContractHash } from "../task/contract.js";
import type { StoredTaskRecord } from "../task/store.js";
import { validateRunIntegrationReceipt } from "../run/integration.js";

export interface DeliveredReview {
  readonly taskId: string;
  readonly artifact: ReviewReportArtifact;
  readonly reportDigest: string;
  readonly provenanceLimit: "legacy-unbound-contract" | "contract-bound";
}

function invalid(): never {
  throw new AgentOpsError("FOLLOWUP_RECEIPT_INVALID", "Followup source is missing, changed, incomplete or not bound to delivered completion.");
}

function unseal(sealed: { readonly digest: string; readonly value: unknown } | undefined): unknown {
  if (sealed === undefined || typeof sealed.digest !== "string" || sealed.digest !== sha256(JSON.stringify(sealed.value))) invalid();
  return sealed.value;
}

/** The final note binds exact receipt bytes; preliminary and active-task receipts are never intake sources. */
export async function readDeliveredReceipt(options: {
  readonly git: WorktreeDependencies["git"]; readonly mainRoot: string; readonly commonDir: string; readonly path: string;
}): Promise<{ readonly receipt: FinishReceipt; readonly digest: string; readonly reviews: readonly DeliveredReview[] }> {
  const { git, mainRoot, commonDir, path } = options;
  if (dirname(path) !== join(commonDir, "agent-ops", "receipts") ||
      !/^[a-f0-9]{64}-[a-f0-9]{40,64}\.json$/u.test(basename(path))) invalid();
  const source = await readPrivateFile(path, commonDir);
  if (source === null || Buffer.byteLength(source) > 16 * 1024 * 1024) invalid();
  let receipt: FinishReceipt;
  try { receipt = JSON.parse(source) as FinishReceipt; } catch { return invalid(); }
  if (receipt === null || ![1, 2].includes(receipt.schemaVersion) ||
      typeof receipt.sessionId !== "string" || !/^[a-f0-9]{40,64}$/u.test(receipt.candidateHead) ||
      !/^[a-f0-9]{40,64}$/u.test(receipt.targetCommit) || !/^[a-f0-9]{64}$/u.test(receipt.sourceFingerprint) ||
      basename(path) !== `${sha256(receipt.sessionId)}-${receipt.candidateHead}.json` ||
      !["tree", "per-task-fallback"].includes(receipt.reviewMode) ||
      !Array.isArray(receipt.tasks) || receipt.tasks.length === 0 ||
      new Set(receipt.tasks.map(record => record?.task?.id)).size !== receipt.tasks.length ||
      typeof receipt.reviews !== "object" || receipt.reviews === null ||
      typeof receipt.verification !== "object" || receipt.verification === null) invalid();
  const digest = sha256(source);
  const note = await git(mainRoot, ["notes", `--ref=${NOTES_REF}`, "show", receipt.candidateHead]);
  if (note.exitCode !== 0 || !note.stdout.trimEnd().endsWith(`\nreceipt: ${path}\nreceipt-sha256: ${digest}`) ||
      (await git(mainRoot, ["merge-base", "--is-ancestor", receipt.targetCommit, receipt.candidateHead])).exitCode !== 0) invalid();
  if (receipt.integrationJournal !== undefined) validateRunIntegrationReceipt(receipt.integrationJournal, receipt);
  const reviews: DeliveredReview[] = [];
  const tasks: readonly StoredTaskRecord[] = receipt.tasks;
  for (const record of tasks) {
    if (record?.status !== "complete" || record.failureFingerprint !== null || typeof record.completedAt !== "string" ||
        !Number.isFinite(Date.parse(record.completedAt)) || !validateTask(record.task).ok) invalid();
    const task = record.task;
    const sealed = receipt.reviews[task.id];
    if (sealed === undefined) invalid();
    const raw = unseal(sealed.report);
    const attestation = validateReviewPair(unseal(sealed.attestation), raw);
    if (attestation === null || attestation.taskId !== task.id ||
        attestation.sourceFingerprint !== receipt.sourceFingerprint || new Set(attestation.reviewSessionIds).size !== 2) invalid();
    const artifact = raw as ReviewReportArtifact;
    const tree = attestation.tree;
    if ((receipt.reviewMode === "tree") !== (tree !== undefined)) invalid();
    const ids = tree?.criterionIds ?? artifact.report?.results?.map(result => result.criterionId);
    if (ids === undefined || (tree !== undefined && (tree.taskIds.length !== tasks.length ||
        tasks.some(item => !tree.taskIds.includes(item.task.id))))) invalid();
    const requiredIds = tree === undefined ? task.criteria.map(c => c.id) : tasks.flatMap(item => item.task.criteria.map(c => `${item.task.id}:${c.id}`));
    if (attestation.schemaVersion === 3 && requiredIds.some(id => !ids.includes(id))) invalid();
    for (const report of [artifact.report, artifact.adversarial?.report]) {
      if (!validateReviewReport(report, ids).ok || reviewReportStatus(report!) !== "PASS") invalid();
    }
    if (attestation.schemaVersion === 3 && (attestation.candidateCommit !== receipt.candidateHead ||
        attestation.taskContractHash !== taskContractHash(task) ||
        attestation.goalHash !== goalHash(tree === undefined ? task : tasks.find(item => item.task.id === tree.rootTaskId)!.task) ||
        Object.keys(attestation.taskContracts ?? {}).length !== (tree === undefined ? 1 : receipt.tasks.length) ||
        (tree === undefined ? [record] : receipt.tasks).some(item => attestation.taskContracts?.[item.task.id] !== taskContractHash(item.task)) ||
        (tree !== undefined && attestation.treeContractHash !== treeContractHash(receipt.tasks.map(item => item.task))))) invalid();
    // Historical failures and behavioral red phases are legitimate sealed history, never the final PASS.
    for (const criterion of task.criteria) {
      const references = record.evidence?.[criterion.id] ?? [];
      const evidence = references.filter(reference => !reference.startsWith("review:")).map(reference => {
        const checked = validateEvidence(unseal(receipt.verification[reference]));
        if (!checked.ok || checked.value.taskId !== task.id || checked.value.criterionId !== criterion.id) return invalid();
        return checked.value;
      });
      for (const commandId of criterion.verifierIds) {
        const latest = evidence.filter(item => item.commandId === commandId && item.acceptance === undefined &&
          item.sourceFingerprint === receipt.sourceFingerprint && item.configHash === record.policyConfigHash)
          .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt) || (a.status === "PASS" ? 1 : -1))[0];
        if (latest === undefined || latest.status !== "PASS" || latest.exitCode !== 0 || latest.failureClass !== "none") invalid();
      }
    }
    reviews.push({ taskId: task.id, artifact, reportDigest: sealed.report.digest,
      provenanceLimit: attestation.schemaVersion === 3 ? "contract-bound" : "legacy-unbound-contract" });
  }
  if (receipt.reviewMode === "tree") {
    const root = reviews.find(review => review.taskId === review.artifact.tree?.rootTaskId);
    if (root === undefined || reviews.some(review => JSON.stringify(review.artifact.tree) !== JSON.stringify(root.artifact.tree))) invalid();
    return { receipt, digest, reviews: [root] };
  }
  return { receipt, digest, reviews };
}
