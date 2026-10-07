import type {AgentOpsConfig, VerificationEvidence} from "../contracts.js";
import {calculateConfigHash, canonicalJson} from "../config/hash.js";
import {readPrivateFile} from "../security/permissions.js";
import {join} from "node:path";
import {sha256} from "../fs/hash.js";
import {criterionContractHash, taskContractHash} from "../task/contract.js";
import type {StoredTaskRecord} from "../task/store.js";
import type {FileEvidenceStore} from "./evidence.js";

export interface CriterionCoverage {
  readonly criterionId: string;
  readonly mode: "legacy" | "behavioral" | "invariant" | "review-only";
  readonly status: "proven" | "undischarged";
  readonly evidenceReferences: readonly string[];
  readonly reason: string;
}

/** Only current, paired check evidence discharges a mechanical contract. */
export async function acceptanceCoverage(
  record: StoredTaskRecord, config: AgentOpsConfig, sourceFingerprint: string,
  store: FileEvidenceStore
): Promise<CriterionCoverage[]> {
  const contract = taskContractHash(record.task);
  const configHash = calculateConfigHash(config);
  const rows: CriterionCoverage[] = [];
  for (const criterion of record.task.criteria) {
    const definition = criterion.acceptance;
    const refs = record.evidence[criterion.id] ?? [];
    const matching: Array<{reference: string; evidence: VerificationEvidence}> = [];
    for (const reference of refs) {
      if (reference.startsWith("review:")) continue;
      const evidence = await store.load(reference) as VerificationEvidence | null;
      if (evidence?.schemaVersion === 4 && evidence.taskId === record.task.id &&
        evidence.criterionId === criterion.id && evidence.configHash === configHash &&
        evidence.sourceFingerprint === sourceFingerprint && evidence.taskContractHash === contract &&
        evidence.acceptance?.criterionContractHash === criterionContractHash(criterion)) {
        matching.push({reference, evidence});
      }
    }
    const authenticated: typeof matching = [];
    for (const item of matching) {
      const proof = item.evidence.acceptance!;
      try {
        const source = await readPrivateFile(join(store.root, ...proof.executionArtifact.split("/")), store.root);
        if (source === null || proof.executionArtifact !== ".agent-ops/tasks/acceptance/" + sha256(source) + ".json") continue;
        const artifact = JSON.parse(source);
        if (artifact.commit !== proof.commit || artifact.phase !== proof.phase || artifact.pairedCommit !== proof.pairedCommit ||
            artifact.materialDigest !== proof.materialDigest || artifact.executionDigest !== proof.executionDigest ||
            artifact.runner?.id !== item.evidence.commandId || artifact.run?.completed !== true ||
            artifact.aggregate?.status === "UNKNOWN" || !Array.isArray(artifact.run?.results) ||
            proof.checks.some(check => !artifact.run.results.some((actual: {checkId: string; status: string; failureClass: string; attempts: number}) =>
              actual.checkId === check.checkId && actual.status === check.status && actual.attempts === 1 &&
              (actual.failureClass === "assertion-failed" ? "assertion" : actual.failureClass) === check.failureClass))) continue;
        authenticated.push(item);
      } catch { /* Missing, modified or malformed execution records cannot prove a contract. */ }
    }
    const authenticatedRefs = new Set(authenticated.map(item => item.reference));
    for (let i = 0; i < matching.length; i++) if (!authenticatedRefs.has(matching[i]!.reference)) {
      const item = matching[i]!;
      matching[i] = {...item, evidence: {...item.evidence, status: "UNKNOWN", failureClass: "execution-artifact-invalid"}};
    }
    const row: Pick<CriterionCoverage, "criterionId" | "mode" | "evidenceReferences"> = {criterionId: criterion.id, mode: definition?.mode ?? "legacy",
      evidenceReferences: matching.map(item => item.reference)};
    if (definition === undefined || definition.mode === "review-only") {
      rows.push({...row, status: "undischarged", reason: definition?.mode === "review-only"
        ? "Review-only: " + definition.reviewOnlyReason + "; requires independent review against the original goal."
        : "Requires independent review against the original goal."});
      continue;
    }
    let proven = true;
    for (const binding of definition.bindings) {
      const phase = (name: "baseline" | "candidate") => matching.filter(({evidence}) =>
        evidence.commandId === binding.runnerId && evidence.acceptance?.phase === name &&
        evidence.acceptance.bindingHash === sha256(canonicalJson({runnerId: binding.runnerId, materials: binding.materials})))
        .sort((a, b) => Date.parse(b.evidence.finishedAt) - Date.parse(a.evidence.finishedAt) ||
          (a.evidence.status === "PASS" ? 1 : -1))[0]?.evidence;
      const baseline = phase("baseline");
      const candidate = phase("candidate");
      const base = baseline?.acceptance;
      const head = candidate?.acceptance;
      if (baseline?.status !== "PASS" || candidate?.status !== "PASS" || base === undefined || head === undefined ||
        base.commit !== definition.baselineCommit || head.pairedCommit !== definition.baselineCommit ||
        base.pairedCommit !== head.commit || base.materialDigest !== head.materialDigest ||
        binding.checkIds.some(id => !head.checks.some(check => check.checkId === id && check.status === "PASS")) ||
        binding.checkIds.some(id => !base.checks.some(check => check.checkId === id)) ||
        base.checks.some(check => check.status === "UNKNOWN") ||
        (binding.redCheckIds ?? []).some(id => !base.checks.some(check =>
          check.checkId === id && check.status === "FAIL" && check.failureClass === "assertion"))) proven = false;
    }
    rows.push({...row, status: proven ? "proven" : "undischarged",
      reason: proven ? "Current paired check evidence satisfies the contract." : "Paired check evidence is missing, stale, unknown or non-discriminating."});
  }
  return rows;
}

export function coverageDigest(rows: readonly CriterionCoverage[]): string {
  return sha256(canonicalJson(rows));
}
