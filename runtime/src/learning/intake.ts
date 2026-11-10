import {lstat, readdir} from "node:fs/promises";
import {join} from "node:path";
import {readDeliveredReceipt} from "../followup/receipt.js";
import type {FollowupSource} from "../followup/intake.js";
import {globsOverlap} from "../escape/lessons.js";
import {AgentOpsError} from "../fs/paths.js";
import {validateEvidence} from "../schema/validate.js";
import {evidenceMatchesContract} from "../task/contract.js";
import {digest, invalid, redactData} from "./data.js";
import {FileLearningStore, type CompletedCase} from "./store.js";

export interface LearningCollection {added: number; warnings: string[]}
export type LearningSource = Pick<FollowupSource, "git" | "mainRoot" | "commonDir">;
function warning(error: unknown): string {
  const code = error instanceof AgentOpsError && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : "LEARNING_COLLECTION_FAILED";
  return `learning: ${code}; completion is unchanged; history intake can be reconciled on normal CLI use.`;
}

/** Read-only source validation shared by import and later provenance revalidation. */
export async function completedCaseFromReceipt(options: LearningSource & {path: string}): Promise<CompletedCase> {
  const {receipt, digest: receiptDigest, reviews} = await readDeliveredReceipt(options);
  if (reviews.some(r => r.provenanceLimit !== "contract-bound") ||
      receipt.tasks.some(r => (receipt.reviews[r.task.id]!.attestation.value as {schemaVersion: number}).schemaVersion !== 3))
    throw new AgentOpsError("LEARNING_SOURCE_INELIGIBLE", "Historical learning requires contract-bound final proof.");
  const ids = new Set(receipt.tasks.map(r => r.task.id));
  for (const record of receipt.tasks) {
    const visited = new Set<string>([record.task.id]);
    let parent = record.task.parentTaskId;
    while (parent !== undefined) {
      if (!ids.has(parent) || visited.has(parent)) invalid("Delivery has an incomplete task tree.");
      visited.add(parent);
      parent = receipt.tasks.find(r => r.task.id === parent)!.task.parentTaskId;
    }
  }
  const paths = [...new Set([...(receipt.fileFingerprints ?? []).map(f => f.path), ...reviews.flatMap(r => [
    ...(r.artifact.report?.changedFilesInspected ?? []),
    ...(r.artifact.adversarial?.report.changedFilesInspected ?? [])
  ])])].filter(p => typeof p === "string" && p.length <= 256 && !p.startsWith("/") && !/[\\\r\n]/u.test(p) &&
    p.split("/").every(part => part !== "" && part !== "." && part !== "..")).sort().slice(0, 64);
  const tasks = receipt.tasks.map(record => {
    const task = record.task;
    const verification = task.criteria.flatMap(c => (record.evidence[c.id] ?? []).filter(ref => !ref.startsWith("review:")).map(reference => {
      const sealed = receipt.verification[reference]!;
      const checked = validateEvidence(sealed.value);
      if (!checked.ok) invalid("Invalid sealed verification.");
      const v = checked.value;
      if (v.status === "PASS" && v.sourceFingerprint === receipt.sourceFingerprint &&
          !evidenceMatchesContract(v.taskContractHash, task)) throw new AgentOpsError("LEARNING_SOURCE_INELIGIBLE", "Verification is not bound to the final task criteria.");
      return {criterionId: c.id, reference, digest: sealed.digest, status: v.status};
    }));
    return {id: task.id, parentTaskId: task.parentTaskId ?? null, goal: task.goal ?? null,
      criteria: task.criteria.map(c => ({id: c.id, description: c.description})), verification,
      review: receipt.reviews[task.id]!.report.digest};
  });
  return redactData({schemaVersion: 1, provenance: {receiptPath: options.path, receiptDigest,
    candidateHead: receipt.candidateHead, targetCommit: receipt.targetCommit, sourceFingerprint: receipt.sourceFingerprint},
    tasks, paths, reviews: [...new Map(reviews.map(r => [r.reportDigest, {taskId: r.taskId, digest: r.reportDigest,
      primary: r.artifact.report!.summary, adversarial: r.artifact.adversarial!.report.summary, status: "PASS" as const}])).values()]
  }) as CompletedCase;
}

/** Advisory and model-free; neither corrupt history nor bad receipts can invalidate a delivery. */
export async function collectLearningReceipt(options: LearningSource & {path: string}): Promise<LearningCollection> {
  try {
    const value = await completedCaseFromReceipt(options);
    return {added: Number(await new FileLearningStore(options.commonDir).addCase(value)), warnings: []};
  } catch (error) {return {added: 0, warnings: error instanceof AgentOpsError && error.code === "LEARNING_SOURCE_INELIGIBLE" ? [] : [warning(error)]};}
}

export async function reconcileLearning(options: LearningSource): Promise<LearningCollection> {
  const result: LearningCollection = {added: 0, warnings: []};
  try {
    const directory = join(options.commonDir, "agent-ops", "receipts");
    // Validate ancestors through the private reader before enumerating shared state.
    await new FileLearningStore(options.commonDir).caseIds();
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) invalid("Unsafe receipt directory.");
    for (const name of (await readdir(directory)).filter(n => /^[a-f0-9]{64}-[a-f0-9]{40,64}\.json$/u.test(n)).sort()) {
      const collected = await collectLearningReceipt({...options, path: join(directory, name)});
      result.added += collected.added;
      for (const item of collected.warnings) if (!result.warnings.includes(item) && result.warnings.length < 8) result.warnings.push(item);
    }
  } catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push(warning(error));}
  return result;
}

/** Exact redacted facts must still match the original delivered receipt and proof. */
export async function readCompletedCase(options: LearningSource, id: string): Promise<CompletedCase> {
  const value = await new FileLearningStore(options.commonDir).artifact("cases", id) as CompletedCase;
  if (value?.schemaVersion !== 1 || typeof value.provenance?.receiptPath !== "string") invalid("Invalid completed case.");
  const current = await completedCaseFromReceipt({...options, path: value.provenance.receiptPath});
  if (digest(current) !== id) invalid("Completed case source changed.");
  return current;
}

export interface HistoricalCaseContext {id: string; provenance: CompletedCase["provenance"]; paths: string[];
  tasks: {id: string; parentTaskId: string | null; goal: string | null; criteria: {id: string; description: string}[]}[];
  reviewStatus: "PASS"; referenceOnly: "Historical reference; transfer is unvalidated; not verification evidence or adopted experience"}
/** Fixed count/total-byte bounds keep whole reports and advice out of ordinary prompts. */
export async function matchingCompletedCases(options: LearningSource, paths: readonly string[]): Promise<HistoricalCaseContext[]> {
  const contexts: HistoricalCaseContext[] = [];
  let bytes = 0;
  const store = new FileLearningStore(options.commonDir);
  for (const id of (await store.caseIds()).reverse()) {
    if (contexts.length === 3) break;
    try {
      // Filter immutable local facts first so unrelated history does not spawn Git processes.
      const value = await store.artifact("cases", id) as CompletedCase;
      if (!value.paths.some(p => paths.some(path => globsOverlap(p, path)))) continue;
      const context: HistoricalCaseContext = {id, provenance: value.provenance, paths: value.paths,
        tasks: value.tasks.map(t => ({id: t.id, parentTaskId: t.parentTaskId, goal: t.goal,
          criteria: t.criteria})), reviewStatus: "PASS",
        referenceOnly: "Historical reference; transfer is unvalidated; not verification evidence or adopted experience"};
      const size = Buffer.byteLength(JSON.stringify(context));
      if (bytes + size > 12000) continue;
      await readCompletedCase(options, id);
      contexts.push(context); bytes += size;
    } catch { /* Invalid historical sources are never supplied as reference. */ }
  }
  return contexts;
}
