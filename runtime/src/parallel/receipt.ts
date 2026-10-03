import { join } from "node:path";

import type { AgentOpsConfig } from "../contracts.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { findReviewAttestation, readReviewReportArtifact } from "../review/attestation.js";
import { resolveReviewScope } from "../review/scope.js";
import { readPrivateFile, writePrivateFile } from "../security/permissions.js";
import { checkTaskCompletionEvidence } from "../task/completion.js";
import type { StoredTaskRecord } from "../task/store.js";
import { FileEvidenceStore } from "../verify/evidence.js";
import { calculateSourceFingerprint } from "../verify/source-fingerprint.js";
import type { GitRunner } from "../verify/change-surface.js";
import type { IntegratedChild } from "./integrate.js";
import type { WorktreeRecord } from "./service.js";

interface SealedValue {
  readonly digest: string;
  readonly value: unknown;
}

export interface FinishReceipt {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly candidateHead: string;
  readonly targetCommit: string;
  readonly sourceFingerprint: string;
  readonly reviewMode: "tree" | "per-task-fallback";
  readonly tasks: readonly StoredTaskRecord[];
  readonly children: readonly IntegratedChild[];
  readonly verification: Readonly<Record<string, SealedValue>>;
  readonly reviews: Readonly<Record<string, { readonly attestation: SealedValue; readonly report: SealedValue }>>;
  readonly residualRisks: readonly string[];
  readonly createdAt: string;
}

function seal(value: unknown): SealedValue {
  return { digest: sha256(JSON.stringify(value)), value };
}

function validSeal(value: SealedValue): boolean {
  return value.digest === sha256(JSON.stringify(value.value));
}

function receiptPath(commonDir: string, record: WorktreeRecord, head: string): string {
  return join(commonDir, "agent-ops", "receipts", `${sha256(record.sessionId)}-${head}.json`);
}

/** Complete local proof is copied into the Git common directory before the branch moves. */
export async function prepareFinishReceipt(options: {
  readonly commonDir: string;
  readonly record: WorktreeRecord;
  readonly candidateHead: string;
  readonly targetCommit: string;
  readonly expectedFingerprint: string;
  readonly tasks: readonly StoredTaskRecord[];
  readonly children: readonly IntegratedChild[];
  readonly config: AgentOpsConfig;
  readonly gitRunner: GitRunner;
}): Promise<{ readonly path: string; readonly digest: string; readonly receipt: FinishReceipt }> {
  const { record, candidateHead, targetCommit, tasks, config } = options;
  const scope = await resolveReviewScope({ root: record.path, runner: options.gitRunner, base: targetCommit });
  const sourceFingerprint = await calculateSourceFingerprint(record.path, scope, options.gitRunner);
  if (sourceFingerprint !== options.expectedFingerprint) {
    throw new AgentOpsError("WORKTREE_FINAL_SOURCE_CHANGED", "The final candidate no longer matches the reviewed fingerprint.");
  }
  const evidenceStore = new FileEvidenceStore(record.path, record.path);
  const verification: Record<string, SealedValue> = {};
  const reviews: Record<string, { attestation: SealedValue; report: SealedValue }> = {};
  const residualRisks = new Set<string>();
  const modes = new Set<"tree" | "per-task-fallback">();
  for (const task of tasks) {
    const problem = await checkTaskCompletionEvidence(task, {
      root: record.path, config, sourceFingerprint, evidenceStore
    });
    if (problem !== null) {
      throw new AgentOpsError("WORKTREE_FINAL_EVIDENCE_MISSING", `Task ${task.task.id}: ${problem.remedy}`);
    }
    for (const references of Object.values(task.evidence)) {
      for (const reference of references) {
        if (reference.startsWith("review:")) continue;
        const value = await evidenceStore.load(reference);
        if (value === null) throw new AgentOpsError("WORKTREE_FINAL_EVIDENCE_MISSING", `Missing ${reference}.`);
        verification[reference] = seal(value);
      }
    }
    const attestation = await findReviewAttestation(record.path, sourceFingerprint, task.task.id);
    const report = await readReviewReportArtifact(record.path, sourceFingerprint, task.task.id);
    if (attestation === null || report === null || report.taskId !== task.task.id) {
      throw new AgentOpsError("WORKTREE_FINAL_EVIDENCE_MISSING", `Missing review for ${task.task.id}.`);
    }
    modes.add(attestation.tree === undefined ? "per-task-fallback" : "tree");
    for (const risk of [...(report.report?.residualRisks ?? []), ...(report.adversarial?.report.residualRisks ?? [])]) {
      residualRisks.add(risk);
    }
    reviews[task.task.id] = { attestation: seal(attestation), report: seal(report) };
  }
  if (modes.size !== 1 || (modes.has("tree") && new Set(Object.values(reviews)
    .map(({ attestation }) => JSON.stringify((attestation.value as { tree?: unknown }).tree))).size !== 1)) {
    throw new AgentOpsError("WORKTREE_FINAL_REVIEW_MISMATCH", "Final tasks do not share one complete review mode and tree scope.");
  }
  const receipt: FinishReceipt = {
    schemaVersion: 1,
    sessionId: record.sessionId,
    candidateHead,
    targetCommit,
    sourceFingerprint,
    reviewMode: modes.has("tree") ? "tree" : "per-task-fallback",
    tasks,
    children: options.children,
    verification,
    reviews,
    residualRisks: [...residualRisks],
    createdAt: new Date().toISOString()
  };
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  const path = receiptPath(options.commonDir, record, candidateHead);
  await writePrivateFile(path, content, options.commonDir);
  const reread = await readPrivateFile(path, options.commonDir);
  if (reread !== content || Object.values(verification).some((item) => !validSeal(item)) ||
      Object.values(reviews).some(({ attestation, report }) => !validSeal(attestation) || !validSeal(report))) {
    throw new AgentOpsError("WORKTREE_RECEIPT_INVALID", "The local finish receipt could not be read back intact.");
  }
  return { path, digest: sha256(content), receipt };
}
