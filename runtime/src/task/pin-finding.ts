import {readdir} from "node:fs/promises";
import {join} from "node:path";
import type {AcceptanceCriterion} from "../contracts.js";
import {AgentOpsError} from "../fs/paths.js";
import {sha256} from "../fs/hash.js";
import {readPrivateFile} from "../security/permissions.js";
import {reviewReportDigest, REVIEW_ATTESTATION_DIRECTORY, REVIEW_REPORT_ARTIFACT_SUFFIX, type ReviewReportArtifact} from "../review/attestation.js";
import {validateReviewReport} from "../review/report.js";
import {validateCriterion} from "../schema/validate.js";
import {commitIdentity} from "../schema/acceptance.js";
import {goalHash, taskContractHash} from "./contract.js";
import type {StoredTaskRecord} from "./store.js";

export async function loadFindingPin(root: string, record: StoredTaskRecord, reference: string,
  input: AcceptanceCriterion, records: readonly StoredTaskRecord[] = [record]): Promise<AcceptanceCriterion> {
  const checked = validateCriterion(input.finding !== undefined && input.acceptance !== undefined
    ? {...input, acceptance: {...input.acceptance, baselineCommit: input.finding.candidateCommit}} : input, "$.criterion");
  if (!checked.ok) throw new AgentOpsError("TASK_PIN_CRITERION_INVALID", "Pin requires a valid acceptance criterion.");
  const match = reference.match(/^([a-f0-9]{64}):(0|[1-9][0-9]{0,2})$/u);
  if (match === null) throw new AgentOpsError("TASK_FINDING_REFERENCE_INVALID", "Finding reference must be report digest:finding index.");
  const digest = match[1]!;
  const index = Number(match[2]);
  const directory = join(root, ...REVIEW_ATTESTATION_DIRECTORY.split("/"));
  let names: string[];
  try {names = await readdir(directory);} catch {names = [];}
  const hashes = new Set([taskContractHash(record.task), ...(record.revisions ?? []).flatMap(r => [r.previousHash, r.currentHash])]);
  for (const name of names.filter(n => /^[a-f0-9]{64}(?:\.[a-z][a-z0-9-]{0,127})?\.reports\.json$/u.test(n)).sort()) {
    const source = await readPrivateFile(join(directory, name), root);
    if (source === null || Buffer.byteLength(source) > 512 * 1024) continue;
    let artifact: ReviewReportArtifact;
    try {artifact = JSON.parse(source) as ReviewReportArtifact;} catch {continue;}
    if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) continue;
    if (artifact.tree !== undefined && (typeof artifact.tree !== "object" || artifact.tree === null ||
      !Array.isArray(artifact.tree.taskIds) || typeof artifact.tree.rootTaskId !== "string")) continue;
    if (artifact.schemaVersion !== 2 || artifact.status !== "FAIL" || !commitIdentity(artifact.candidateCommit) ||
      artifact.taskContracts?.[record.task.id] === undefined || !hashes.has(artifact.taskContracts[record.task.id]!) ||
      name !== artifact.sourceFingerprint + (artifact.taskId === undefined ? "" : "." + artifact.taskId) + REVIEW_REPORT_ARTIFACT_SUFFIX) continue;
    const owner = artifact.tree === undefined ? record : records.find(r => r.task.id === artifact.tree!.rootTaskId);
    if (owner === undefined || artifact.goalHash !== goalHash(owner.task) ||
      (artifact.tree === undefined ? artifact.taskId !== record.task.id : !artifact.tree.taskIds.includes(record.task.id))) continue;
    for (const report of [artifact.report, artifact.adversarial?.report]) {
      if (typeof report !== "object" || report === null || !Array.isArray(report.results) ||
        report.results.some(r => typeof r !== "object" || r === null || typeof r.criterionId !== "string")) continue;
      const valid = validateReviewReport(report, report.results.map(r => r.criterionId));
      if (!valid.ok || reviewReportDigest(valid.value) !== digest || index >= valid.value.findings.length) continue;
      const finding = valid.value.findings[index]!;
      if (input.acceptance === undefined || input.acceptance.mode === "invariant")
        throw new AgentOpsError("TASK_PIN_ACCEPTANCE_REQUIRED", "Pinned findings require behavioral red checks or an explicit review-only contract.");
      const pinId = sha256(digest + ":" + index);
      const requestedPin = input.finding?.pinId;
      const existing = record.task.criteria.find(c => c.finding?.pinId === (requestedPin ?? pinId));
      if (requestedPin !== undefined && existing === undefined)
        throw new AgentOpsError("TASK_PIN_UNKNOWN", "Explicit recurrence must name an existing pin ID.");
      if (existing !== undefined && requestedPin === undefined) {
        if (input.id !== existing.id) throw new AgentOpsError("TASK_PIN_EXISTS", "This finding already has a criterion; name its pin ID to record recurrence.");
        return structuredClone(existing);
      }
      return {...structuredClone(input), id: existing?.id ?? input.id,
        acceptance: {...input.acceptance, baselineCommit: existing?.acceptance?.baselineCommit ?? artifact.candidateCommit},
        finding: existing?.finding ?? {pinId, reportDigest: digest, findingIndex: index,
          candidateCommit: artifact.candidateCommit, criterionIds: [...finding.criterionIds]}};
    }
  }
  throw new AgentOpsError("TASK_FINDING_NOT_FOUND", "No saved failed report binds this finding to the task's goal, contract and candidate commit.");
}
