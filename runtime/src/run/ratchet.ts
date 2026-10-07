import {readdir} from "node:fs/promises";
import {join} from "node:path";
import {sha256} from "../fs/hash.js";
import {readPrivateFile} from "../security/permissions.js";
import {REVIEW_ATTESTATION_DIRECTORY, reviewReportDigest} from "../review/attestation.js";
import {validateReviewReport} from "../review/report.js";
import type {StoredTaskRecord} from "../task/store.js";
import {goalHash} from "../task/contract.js";
import {loadFindingPin} from "../task/pin-finding.js";
const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Failed blocking findings need an explicit pin or a recorded recurrence before the next final gate. */
export async function pendingFindingPins(root: string, tasks: readonly StoredTaskRecord[], rootTaskId: string): Promise<string[]> {
  const owner = tasks.find(record => record.task.id === rootTaskId);
  if (owner === undefined) return [];
  const pending = new Set<string>();
  const currentTasks = tasks.filter(record => record.status !== "archived" && record.supersededBy === undefined);
  const directory = join(root, REVIEW_ATTESTATION_DIRECTORY);
  let names: string[];
  try {names = await readdir(directory);} catch {return [];}
  for (const name of names.filter(n => /^[a-f0-9]{64}(?:\.[a-z][a-z0-9-]{0,127})?\.reports\.json$/u.test(n))) {
    const source = await readPrivateFile(join(directory, name), root);
    if (source === null || Buffer.byteLength(source) > 512 * 1024) continue;
    let artifact: unknown;
    try {artifact = JSON.parse(source);} catch {continue;}
    if (!plain(artifact) || artifact.schemaVersion !== 2 || artifact.status !== "FAIL" || artifact.goalHash !== goalHash(owner.task) ||
      !plain(artifact.taskContracts) || !Object.keys(artifact.taskContracts).some(id => tasks.some(record => record.task.id === id))) continue;
    for (const report of [artifact.report, plain(artifact.adversarial) ? artifact.adversarial.report : undefined]) {
      if (!plain(report) || !Array.isArray(report.results) || report.results.some(r => !plain(r) || typeof r.criterionId !== "string")) continue;
      const checked = validateReviewReport(report, report.results.map(r => (r as {criterionId: string}).criterionId));
      if (!checked.ok) continue;
      const digest = reviewReportDigest(checked.value);
      for (const [index, finding] of checked.value.findings.entries()) {
        if (!finding.blocking) continue;
        const reference = digest + ":" + index;
        const pin = sha256(reference);
        let pinned = currentTasks.some(record => record.task.criteria.some(c => c.finding?.pinId === pin));
        if (!pinned) for (const record of currentTasks) {
          for (const criterion of record.task.criteria.filter(c => c.finding !== undefined)) {
            if (!record.revisions?.some(revision => revision.diagnostics.includes("finding:" + reference) &&
              revision.diagnostics.includes("pin:" + criterion.finding!.pinId))) continue;
            try {await loadFindingPin(root, record, reference, criterion, tasks); pinned = true;}
            catch { /* A claimed recurrence without saved source authority cannot discharge a finding. */ }
          }
        }
        if (!pinned) pending.add(reference);
      }
    }
  }
  return [...pending].sort();
}
