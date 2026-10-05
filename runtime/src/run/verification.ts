import {join} from "node:path";
import {canonicalJson} from "../config/hash.js";
import {sha256} from "../fs/hash.js";
import {AgentOpsError} from "../fs/paths.js";
import {readPrivateFile, writePrivateFile} from "../security/permissions.js";
import {redactSecrets} from "../security/redact.js";
import {taskContractHash} from "../task/contract.js";
import type {StoredTaskRecord} from "../task/store.js";
import {FileEvidenceStore} from "../verify/evidence.js";
import type {VerificationReport} from "../verify/service.js";
import type {VerificationEvidence} from "../contracts.js";
import {deriveFailureObservation, type FailureObservation, type AcceptanceResultForConvergence} from "./convergence.js";
import type {RunRepository, RunState} from "./service.js";

/** Preserve actual failed command reports, which are not completion evidence. */
export async function recordRunVerification(repository: RunRepository, state: RunState, workerId: string,
  task: StoredTaskRecord, report: VerificationReport): Promise<void> {
  if (state.policyBinding === undefined) return;
  const worker = state.workers.find(w => w.workerId === workerId);
  if (worker === undefined || task.task.id !== report.taskId) throw new AgentOpsError("RUN_WORKER_STALE", "Verifier report has no current worker identity.");
  const content = redactSecrets(canonicalJson({schemaVersion: 1, report, taskContractHash: taskContractHash(task.task),
    policyArtifactDigest: state.policyBinding.artifactDigest}));
  const digest = sha256(content);
  const path = join(state.commonDir, "agent-ops/runs", state.runId, "verification", digest + ".json");
  await repository.mutate(state.runId, async current => {
    const saved = current.workers.find(w => w.workerId === workerId);
    if (current.status !== "active" || current.disableRestart || saved?.generation !== worker.generation ||
      current.policyBinding?.artifactDigest !== state.policyBinding!.artifactDigest)
      throw new AgentOpsError("RUN_VERIFICATION_STALE", "Verifier observation belongs to a stale run generation or policy.");
    await writePrivateFile(path, content, current.commonDir);
    return {...current, events: [...current.events, {id: "verify-" + digest, at: new Date().toISOString(), type: "diagnostic" as const,
      code: "RUN_VERIFICATION_OBSERVED", workerId, taskId: report.taskId, detail: canonicalJson({digest})}].slice(-2000)};
  });
}

/** Read current-contract observations; saved raw source fingerprints never identify failures. */
export async function observeRunFailure(state: RunState, root: string, records: readonly StoredTaskRecord[],
  taskId: string, code: string, pendingPinIds: readonly string[]): Promise<FailureObservation> {
  const results = new Map<string, VerificationReport["results"][number]>();
  const acceptance: AcceptanceResultForConvergence[] = [];
  const evidence = new FileEvidenceStore(root, root);
  for (const record of records.filter(r => r.status !== "archived" && r.supersededBy === undefined)) {
    const events = state.events.filter(e => e.code === "RUN_VERIFICATION_OBSERVED" && e.taskId === record.task.id).reverse();
    for (const event of events) {
      const {digest} = JSON.parse(event.detail!);
      if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) throw new AgentOpsError("RUN_VERIFICATION_CHANGED", "Verifier observation digest is invalid.");
      const source = await readPrivateFile(join(state.commonDir, "agent-ops/runs", state.runId, "verification", digest + ".json"), state.commonDir);
      if (source === null || sha256(source) !== digest) throw new AgentOpsError("RUN_VERIFICATION_CHANGED", "Verifier observation is missing or changed.");
      const saved = JSON.parse(source) as {report: VerificationReport; taskContractHash: string; policyArtifactDigest: string};
      if (saved.taskContractHash !== taskContractHash(record.task) || saved.policyArtifactDigest !== state.policyBinding?.artifactDigest) continue;
      for (const result of saved.report.results) results.set(record.task.id + ":" + result.commandId, {...result, commandId: record.task.id + ":" + result.commandId});
      for (const phase of saved.report.acceptance ?? []) {
        const proof = await evidence.load(phase.reference) as VerificationEvidence | null;
        const criterion = record.task.criteria.find(c => c.id === phase.criterionId);
        if (proof?.acceptance === undefined || proof.taskContractHash !== taskContractHash(record.task) || criterion?.acceptance === undefined || criterion.acceptance.mode === "review-only") continue;
        const bindings = criterion.acceptance.bindings.filter(b => b.runnerId === phase.runnerId);
        acceptance.push({...phase, criterionId: record.task.id + ":" + phase.criterionId, checks: proof.acceptance.checks,
          requiredCheckIds: bindings.flatMap(b => b.checkIds), redCheckIds: bindings.flatMap(b => b.redCheckIds ?? [])});
      }
      break;
    }
  }
  return deriveFailureObservation({taskId, status: "FAIL", results: results.size === 0 && acceptance.length === 0 && pendingPinIds.length === 0
    ? [{commandId: code, required: true, status: "FAIL", failureClass: code}] : [...results.values()], acceptance}, {pendingPinIds});
}
