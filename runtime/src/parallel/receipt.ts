import {readdir} from "node:fs/promises";
import { join } from "node:path";

import type { AgentOpsConfig } from "../contracts.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { findReviewAttestation, readReviewReportArtifact, REVIEW_ATTESTATION_DIRECTORY } from "../review/attestation.js";
import { resolveReviewScope } from "../review/scope.js";
import { readPrivateFile, writePrivateFile } from "../security/permissions.js";
import { checkTaskCompletionEvidence } from "../task/completion.js";
import type { StoredTaskRecord } from "../task/store.js";
import { FileEvidenceStore } from "../verify/evidence.js";
import {validateEvidence} from "../schema/validate.js";
import { calculateSourceFingerprint } from "../verify/source-fingerprint.js";
import type { GitRunner } from "../verify/change-surface.js";
import type { IntegratedChild } from "./integrate.js";
import type { WorktreeRecord } from "./service.js";
import { validateRunIntegrationReceipt, type IntegrationReceiptBinding } from "../run/integration.js";

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
  /** Raw paired execution artifacts survive checkout cleanup with exact bytes. */
  readonly executionArtifacts?: Readonly<Record<string, SealedValue>>;
  /** Failed reports remain historical source material, never final PASS evidence. */
  readonly historicalReviews?: Readonly<Record<string, SealedValue>>;
  readonly reviews: Readonly<Record<string, { readonly attestation: SealedValue; readonly report: SealedValue }>>;
  readonly residualRisks: readonly string[];
  readonly createdAt: string;
  /** Present only for the explicit verified-no-change final proof path. */
  readonly noChange?: {
    readonly sourceCommit: string;
    readonly contractDigest: string;
    readonly reviewScope: string;
    readonly artifactRefs: readonly string[];
  };
  readonly integrationJournal?: IntegrationReceiptBinding;
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
  readonly noChange?: {
    readonly sourceCommit: string;
    readonly contractDigest: string;
    readonly reviewScope: import("../review/scope.js").ReviewScope;
    readonly artifactRefs: readonly string[];
  };
  readonly integrationJournal?: IntegrationReceiptBinding;
}): Promise<{ readonly path: string; readonly digest: string; readonly receipt: FinishReceipt }> {
  const { record, candidateHead, targetCommit, tasks, config } = options;
  if (options.integrationJournal !== undefined) {
    validateRunIntegrationReceipt(options.integrationJournal, {
      candidateHead, targetCommit, integrationJournal: options.integrationJournal
    });
  }
  const scope = options.noChange?.reviewScope ?? await resolveReviewScope({ root: record.path, runner: options.gitRunner, base: targetCommit });
  if (options.noChange !== undefined && options.noChange.sourceCommit !== candidateHead) {
    throw new AgentOpsError("WORKTREE_NO_CHANGE_SOURCE_MISMATCH", "Verified-no-change receipt must pin the current candidate commit.");
  }
  const sourceFingerprint = await calculateSourceFingerprint(record.path, scope, options.gitRunner);
  if (sourceFingerprint !== options.expectedFingerprint) {
    throw new AgentOpsError("WORKTREE_FINAL_SOURCE_CHANGED", "The final candidate no longer matches the reviewed fingerprint.");
  }
  const evidenceStore = new FileEvidenceStore(record.path, record.path);
  const verification: Record<string, SealedValue> = {};
  const executionArtifacts: Record<string, SealedValue> = {};
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
    for (const references of [task.evidence, ...(task.revisions ?? []).map(revision => revision.previousEvidence)]
      .flatMap(evidence => Object.values(evidence))) {
      for (const reference of references) {
        if (reference.startsWith("review:")) continue;
        const value = await evidenceStore.load(reference);
        if (value === null) throw new AgentOpsError("WORKTREE_FINAL_EVIDENCE_MISSING", `Missing ${reference}.`);
        verification[reference] = seal(value);
        const checked = validateEvidence(value);
        if (!checked.ok) throw new AgentOpsError("WORKTREE_FINAL_EVIDENCE_MISSING", "Historical verification evidence is invalid.");
        const artifact = checked.value.acceptance?.executionArtifact;
        if (artifact !== undefined) {
          const content = await readPrivateFile(join(record.path, artifact), record.path);
          if (content === null || Buffer.byteLength(content) > 4 * 1024 * 1024 ||
            artifact !== ".agent-ops/tasks/acceptance/" + sha256(content) + ".json")
            throw new AgentOpsError("WORKTREE_FINAL_EVIDENCE_MISSING", "Paired execution artifact is missing or changed.");
          executionArtifacts[artifact] = seal(content);
        }
      }
    }
    const attestation = await findReviewAttestation(record.path, sourceFingerprint, task.task.id);
    const report = await readReviewReportArtifact(record.path, sourceFingerprint, task.task.id);
    if (attestation === null || report === null || report.status !== "PASS" || report.taskId !== task.task.id) {
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
  const historicalReviews: Record<string, SealedValue> = {};
  let names: string[];
  try {names = await readdir(join(record.path, REVIEW_ATTESTATION_DIRECTORY));}
  catch (cause) {if ((cause as NodeJS.ErrnoException).code === "ENOENT") names = []; else throw cause;}
  for (const name of names.filter(name => /^[a-f0-9]{64}\.[a-z][a-z0-9-]{0,127}\.reports\.json$/u.test(name))) {
    const path = REVIEW_ATTESTATION_DIRECTORY + "/" + name;
    const content = await readPrivateFile(join(record.path, path), record.path);
    if (content === null || Buffer.byteLength(content) > 512 * 1024) continue;
    let artifact: {status?: string; taskId?: string; sourceFingerprint?: string};
    try {artifact = JSON.parse(content);} catch {continue;}
    if (artifact === null || typeof artifact !== "object" || artifact.status !== "FAIL" ||
      !tasks.some(task => task.task.id === artifact.taskId) ||
      name !== artifact.sourceFingerprint + "." + artifact.taskId + ".reports.json") continue;
    historicalReviews[path] = seal(content);
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
    executionArtifacts,
    historicalReviews,
    reviews,
    residualRisks: [...residualRisks],
    createdAt: new Date().toISOString(),
    ...(options.noChange === undefined ? {} : {
      noChange: {
        sourceCommit: options.noChange.sourceCommit,
        contractDigest: options.noChange.contractDigest,
        reviewScope: JSON.stringify(options.noChange.reviewScope),
        artifactRefs: options.noChange.artifactRefs
      }
    }),
    ...(options.integrationJournal === undefined ? {} : { integrationJournal: options.integrationJournal })
  };
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  const path = receiptPath(options.commonDir, record, candidateHead);
  await writePrivateFile(path, content, options.commonDir);
  const reread = await readPrivateFile(path, options.commonDir);
  if (reread !== content || Object.values(verification).some((item) => !validSeal(item)) ||
      Object.values(executionArtifacts).some(item => !validSeal(item)) ||
      Object.values(historicalReviews).some(item => !validSeal(item)) ||
      Object.values(reviews).some(({ attestation, report }) => !validSeal(attestation) || !validSeal(report))) {
    throw new AgentOpsError("WORKTREE_RECEIPT_INVALID", "The local finish receipt could not be read back intact.");
  }
  return { path, digest: sha256(content), receipt };
}
