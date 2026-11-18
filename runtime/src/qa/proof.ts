import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AcceptanceCriterion, AgentOpsConfig, AgentTask, VerificationEvidence } from "../contracts.js";
import { canonicalJson } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { collectQaFollowups } from "../followup/intake.js";
import { readPrivateFile } from "../security/permissions.js";
import { taskContractHash, treeContractHash } from "../task/contract.js";
import { replayAcceptance } from "../verify/acceptance-replay.js";
import { aggregateAcceptanceRun, makeAcceptanceRun, type AcceptanceRun } from "../verify/acceptance-protocol.js";
import { resolveGitCommit, type GitRunner } from "../verify/change-surface.js";
import type { FileEvidenceStore } from "../verify/evidence.js";
import type { VerificationProcessRunner } from "../verify/spawn.js";
import { qaVersionMatches } from "./policy.js";
import type { FileQaStore } from "./store.js";
import type { QaAttempt, QaAuthorResponse, QaCase, QaDecision, QaExecution, QaFinding, QaMaterial, QaMaterialLineage, QaPlan,
  QaQuestion, QaReference, QaReport, QaSession, QaState, QaUsage, QaVersion } from "./types.js";

const CONTRACT_KEYS = ["taskId", "goalHash", "taskContractHash", "treeContractHash", "scopeHash", "policyHash", "configHash"] as const;
/** Goal, task, tree, scope, policy and config; the candidate commit and source may move with repairs and imports. */
export function qaContractsMatch(saved: QaVersion, current: QaVersion): boolean {
  return CONTRACT_KEYS.every(key => saved[key] === current[key]);
}
const fail = (code: string, message: string): never => {throw new AgentOpsError(code, message);};
const bounded = (value: string, max = 4000) => value.length <= max ? value : `${value.slice(0, max - 1)}…`;
const unique = (values: readonly string[]) => [...new Set(values.filter(v => v.trim() !== ""))];

/** Missing token or cost data in any part stays UNKNOWN (null) in the total; nothing is estimated. */
export function qaUsageSum(...parts: readonly QaUsage[]): QaUsage {
  const sum = (key: keyof QaUsage) => parts.some(p => p[key] === null) ? null : parts.reduce((total, p) => total + p[key]!, 0);
  return {inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), totalTokens: sum("totalTokens"), costUsd: sum("costUsd")};
}

export interface QaCaseVerdict {
  readonly status: "PASS" | "FAIL" | "UNKNOWN";
  readonly failedChecks: readonly string[];
  /** A candidate check that failed was green on the immutable baseline: a regression, blocking regardless of the case. */
  readonly introduced: boolean;
  readonly notes: readonly string[];
}
/**
 * Re-derives a case result from saved trusted executions, never from a report or model claim.
 * Behavioral cases need the red checks to fail by assertion on the baseline and every check to
 * pass on the candidate; incomplete, skipped, retried or infrastructure output is UNKNOWN.
 */
export function qaCaseVerdict(c: QaCase, executions: readonly QaExecution[], materialDigests?: ReadonlyMap<string, string>): QaCaseVerdict {
  if (c.mode === "nonmechanical") return {status: "UNKNOWN", failedChecks: [], introduced: false,
    notes: [`Nonmechanical: ${c.nonmechanicalReason ?? "no reason"}. Both final reviewers judge it; it is not executed proof.`]};
  if (c.bindings.length === 0 || c.mode === "behavioral" && !c.bindings.some(b => (b.redCheckIds?.length ?? 0) > 0))
    return {status: "UNKNOWN", failedChecks: [], introduced: false, notes: ["Mechanical proof needs bindings and a behavioral case needs a designated red check."]};
  const notes: string[] = [], failedChecks: string[] = [];
  let failed = false, unknown = false, introduced = false;
  for (const binding of c.bindings) {
    const digest = materialDigests?.get(canonicalJson(binding.materials));
    const runs = (phase: "baseline" | "candidate") => executions.filter(e => e.caseId === c.id && e.runnerId === binding.runnerId &&
      (materialDigests === undefined || digest !== undefined && e.materialDigest === digest) && e.run.phase === phase);
    const [baseline, candidate] = [runs("baseline"), runs("candidate")];
    if (baseline.length !== 1 || candidate.length !== 1) {
      unknown = true; notes.push(`${binding.runnerId}: no single trusted baseline and candidate execution.`); continue;
    }
    const before = aggregateAcceptanceRun(baseline[0]!.run, binding.checkIds), after = aggregateAcceptanceRun(candidate[0]!.run, binding.checkIds);
    if (after.status === "UNKNOWN") {unknown = true; notes.push(`${binding.runnerId} candidate: UNKNOWN (${after.failureClass}).`);}
    else {
      const red = after.results.filter(r => r.status !== "PASS").map(r => r.checkId);
      if (red.length > 0) {
        failed = true; failedChecks.push(...red);
        notes.push(`${binding.runnerId} candidate failed by assertion: ${red.join(", ")}.`);
        if (before.status !== "UNKNOWN" && red.some(id => before.results.some(r => r.checkId === id && r.status === "PASS"))) introduced = true;
      } else notes.push(`${binding.runnerId} candidate passed: ${binding.checkIds.join(", ")}.`);
    }
    if (before.status === "UNKNOWN") {unknown = true; notes.push(`${binding.runnerId} baseline: UNKNOWN (${before.failureClass}).`);}
    else if (c.mode === "invariant" && before.status !== "PASS") {
      unknown = true; notes.push(`${binding.runnerId} invariant baseline did not pass: ${before.results.filter(r => r.status !== "PASS").map(r => r.checkId).join(", ")}.`);
    }
    else if (c.mode === "behavioral") {
      const red = binding.redCheckIds ?? [];
      const notRed = red.filter(id =>
        !before.results.some(r => r.checkId === id && r.status === "FAIL" && r.failureClass === "assertion-failed"));
      if (notRed.length > 0) {unknown = true; notes.push(`${binding.runnerId} baseline did not fail by assertion: ${notRed.join(", ")}.`);}
      else if (red.length > 0) notes.push(`${binding.runnerId} baseline failed by assertion: ${red.join(", ")}.`);
    }
  }
  return {status: failed ? "FAIL" : unknown ? "UNKNOWN" : "PASS", failedChecks: unique(failedChecks).sort(), introduced, notes: unique(notes)};
}

/** Match replay's exact path/role/mode/content identity; check IDs alone cannot distinguish material sets. */
async function bindingMaterialDigests(cases: readonly QaCase[], runner: GitRunner, commit: string): Promise<ReadonlyMap<string, string>> {
  const digests = new Map<string, string>(), files = new Map<string, {mode: number; hash: string}>();
  for (const binding of cases.flatMap(c => c.bindings)) {
    const key = canonicalJson(binding.materials);
    if (digests.has(key)) continue;
    const materials = [];
    for (const material of binding.materials) {
      let file = files.get(material.path);
      if (file === undefined) {
        const tree = await runner.run(["ls-tree", "-z", commit, "--", material.path]);
        const entry = Buffer.from(tree.stdout).toString("utf8").match(/^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/u);
        if (tree.exitCode !== 0 || entry === null || entry[3] !== material.path) return fail("QA_MATERIAL_CHANGED", "A bound QA material is not a committed regular file.");
        const blob = await runner.run(["cat-file", "blob", entry[2]!]);
        if (blob.exitCode !== 0 || blob.stdout.byteLength > 1024 * 1024) return fail("QA_MATERIAL_CHANGED", "A bound QA material is unavailable or exceeds its byte limit.");
        file = {mode: entry[1] === "100755" ? 0o755 : 0o644, hash: sha256(blob.stdout)};
        files.set(material.path, file);
      }
      materials.push({path: material.path, role: material.role, ...file});
    }
    digests.set(key, sha256(canonicalJson(materials)));
  }
  return digests;
}

function requiredQuestions(plan: QaPlan, report: QaReport | null): QaQuestion[] {
  return [...plan.questions, ...(report?.questions ?? [])].filter(q => q.required);
}
async function decisions(store: FileQaStore, refs: readonly QaReference[] | undefined): Promise<{ref: QaReference; decision: QaDecision}[]> {
  return await Promise.all((refs ?? []).map(async ref => ({ref, decision: await store.get({...ref, kind: "decision"})})));
}
/** An answer applies to the exact plan and the unchanged goal, task, tree, scope, policy and config it was given for. */
function answered(found: readonly {decision: QaDecision}[], plan: QaReference, version: QaVersion, questionId: string): boolean {
  return found.some(({decision}) => decision.questionId === questionId && decision.plan.digest === plan.digest && qaContractsMatch(decision.version, version));
}

export interface QaAttemptOptions {
  readonly store: FileQaStore;
  /** The delivery checkout: a clean committed final candidate after material import. */
  readonly root: string;
  readonly version: QaVersion;
  /** Immutable task baseline: behavioral cases must fail there by assertion. */
  readonly baselineCommit: string;
  /** Trusted configuration; only its acceptance runners can execute cases. */
  readonly config: AgentOpsConfig;
  readonly trusted: boolean;
  readonly gitRunner: GitRunner;
  readonly processRunner: VerificationProcessRunner;
  readonly evidenceStore: FileEvidenceStore;
  /** The confirmed-dead author's accepted contribution, already imported into this exact candidate. */
  readonly author: {
    readonly session: QaSession;
    readonly generation: number;
    readonly startedAt: string;
    readonly usage: QaUsage;
    readonly materials: readonly QaMaterial[];
    readonly materialDigest: string;
    readonly lineage: QaMaterialLineage;
    readonly observations: QaAuthorResponse["observations"];
    readonly questions: readonly QaQuestion[];
  };
  readonly now?: () => string;
  readonly signal?: AbortSignal;
}
export interface QaAttemptResult {
  readonly state: QaState;
  readonly attempt: QaReference;
  readonly report: QaReference;
  /** Cases whose executions were reused from an attempt with the exact same plan, version and materials. */
  readonly reused: readonly string[];
  readonly blockers: readonly string[];
  readonly followupWarnings: readonly string[];
}

async function savedExecution(options: QaAttemptOptions, caseId: string, runnerId: string,
  row: {readonly phase: "baseline" | "candidate"; readonly status: string; readonly failureClass: string; readonly reference: string}): Promise<QaReference> {
  const {root} = options;
  const evidence = await options.evidenceStore.load(row.reference) as VerificationEvidence | null;
  const artifact = evidence?.acceptance?.executionArtifact;
  if (evidence?.acceptance === undefined || artifact === undefined) return fail("QA_EXECUTION_INVALID", "Trusted replay evidence is unavailable.");
  const [evidenceSource, artifactSource] = await Promise.all([row.reference, artifact].map(path => readPrivateFile(join(root, ...path.split("/")), root)));
  if (evidenceSource == null || artifactSource == null) return fail("QA_EXECUTION_INVALID", "Trusted replay artifacts are unavailable.");
  const saved = (JSON.parse(artifactSource) as {run: AcceptanceRun | null}).run;
  // An UNKNOWN replay (exit-code mismatch, timeout, build or hook error) is recorded as incomplete, never as a result.
  const run = row.status !== "UNKNOWN" && saved !== null ? saved : makeAcceptanceRun({executionId: saved?.executionId ?? randomUUID(),
    framework: saved?.framework ?? "unknown", frameworkVersion: saved?.frameworkVersion ?? "unknown", phase: row.phase, results: [],
    completed: false, diagnostics: [`replay ${row.failureClass}`]});
  return await options.store.put("execution", {schemaVersion: 1, version: options.version, caseId, runnerId,
    materialDigest: evidence.acceptance.materialDigest, run, evidenceReferences: [
      {path: row.reference, digest: sha256(evidenceSource)}, {path: artifact, digest: sha256(artifactSource)}]});
}

/**
 * Executes the plan's mechanical cases on the exact final candidate through trusted acceptance
 * replay, records a report and returns in-scope failures to the developer. Nothing here seals proof.
 */
export async function executeQaAttempt(options: QaAttemptOptions): Promise<QaAttemptResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const {store, version, author} = options, taskId = version.taskId;
  const control = await store.readControl(taskId);
  if (control === null || control.plan === null) return fail("QA_NOT_STARTED", "QA has no plan for this task.");
  if (control.owner !== null) return fail("QA_WRITER_LIVE", "A QA writer still owns this task; its checks cannot run yet.");
  if (!control.continuation) return fail("QA_CONTINUATION_DISABLED", "QA was stopped for this task; only an explicit QA command may continue it.");
  if (control.state !== "testing" || control.generation !== author.generation)
    return fail("QA_STALE_WRITER", "This QA contribution belongs to another generation or state.");
  const plan = await store.get({...control.plan, kind: "plan"});
  if (!qaContractsMatch(plan.version, version)) return fail("QA_PLAN_STALE", "The QA plan describes another goal, contract, scope, policy or config; plan again.");
  if (await resolveGitCommit(options.gitRunner, "HEAD") !== version.candidateCommit || author.lineage.importedCommit !== version.candidateCommit)
    return fail("QA_CANDIDATE_MOVED", "QA executes only the exact imported final candidate.");
  for (const material of author.materials) {
    const blob = await options.gitRunner.run(["show", `${version.candidateCommit}:${material.path}`]);
    if (blob.exitCode !== 0 || sha256(Buffer.from(blob.stdout)) !== material.digest)
      return fail("QA_MATERIAL_CHANGED", `QA material ${material.path} differs in the final candidate.`);
  }
  // Reuse requires the exact same plan, version (commit, source, contracts, config, policy) and materials.
  const previous = control.attempt === null ? null : await store.get({...control.attempt, kind: "attempt"});
  const reusable = previous !== null && previous.plan.digest === control.plan.digest && qaVersionMatches(previous.version, version) &&
    previous.materialDigest === author.materialDigest ? previous.executions : [];
  const prior = await Promise.all(reusable.map(async ref => ({ref, execution: await store.get({...ref, kind: "execution"})})));
  const configured = new Set((options.config.verification.acceptanceRunners ?? []).map(r => r.id));
  const mechanical = plan.cases.filter(c => c.mode !== "nonmechanical");
  const materialDigests = await bindingMaterialDigests(mechanical.filter(c => c.bindings.every(b => configured.has(b.runnerId))), options.gitRunner, version.candidateCommit);
  // A PASS or FAIL observed under unchanged conditions stands; re-running it would be a blind retry. UNKNOWN may re-execute.
  const reused = mechanical.filter(c => qaCaseVerdict(c, prior.filter(p => p.execution.caseId === c.id).map(p => p.execution), materialDigests).status !== "UNKNOWN").map(c => c.id);
  const runnable = mechanical.filter(c => !reused.includes(c.id) && c.bindings.every(b => configured.has(b.runnerId)));
  const refs = new Map<string, QaReference[]>(reused.map(id => [id, prior.filter(p => p.execution.caseId === id).map(p => p.ref)]));
  if (runnable.length > 0) {
    // Cases become criteria of a QA-only task id, so their evidence never mixes with the delivery task's own.
    const criteria: AcceptanceCriterion[] = runnable.map(c => ({id: c.id, description: c.expected, verifierIds: [],
      acceptance: {mode: c.mode as "behavioral" | "invariant", baselineCommit: options.baselineCommit, bindings: c.bindings.map(b => structuredClone(b))}}));
    const rows = await replayAcceptance({root: options.root, task: {schemaVersion: 2, id: `${taskId}-qa`, title: "Independent QA cases", criteria},
      config: options.config, gitRunner: options.gitRunner, processRunner: options.processRunner, evidenceStore: options.evidenceStore,
      sourceFingerprint: version.sourceFingerprint, trusted: options.trusted, scope: "project", ...(options.signal === undefined ? {} : {signal: options.signal})});
    for (const row of rows) refs.set(row.criterionId, [...refs.get(row.criterionId) ?? [], await savedExecution(options, row.criterionId, row.runnerId, row)]);
  }
  const executions = new Map<string, QaExecution[]>();
  for (const [caseId, list] of refs) executions.set(caseId, await Promise.all(list.map(ref => store.get({...ref, kind: "execution"}))));
  const previousReport = control.report === null ? null : await store.get({...control.report, kind: "report"});
  const notesFor = (caseId: string) => author.observations.filter(o => o.caseId === caseId).flatMap(o => o.notes.map(n => bounded(`QA author note (data): ${n}`)));
  const verdicts = new Map(plan.cases.map(c => [c.id, c.mode !== "nonmechanical" && !c.bindings.every(b => configured.has(b.runnerId)) && !reused.includes(c.id)
    ? {status: "UNKNOWN" as const, failedChecks: [], introduced: false, notes: ["A bound runner is not configured and authorized; the case was not executed."]}
    : qaCaseVerdict(c, executions.get(c.id) ?? [], materialDigests)]));
  const results: QaReport["results"] = plan.cases.map(c => {
    const verdict = verdicts.get(c.id)!;
    return {caseId: c.id, status: verdict.status, executions: refs.get(c.id) ?? [],
      observations: unique([...verdict.notes.map(n => bounded(n)), ...(reused.includes(c.id) ? ["Reused an execution with unchanged plan, version and materials."] : []), ...notesFor(c.id)])};
  });
  const findings: QaFinding[] = [];
  for (const c of plan.cases) {
    const verdict = verdicts.get(c.id)!;
    if (verdict.status !== "FAIL") continue;
    const failing = (executions.get(c.id) ?? []).flatMap((e, i) => e.run.phase === "candidate" ? [refs.get(c.id)![i]!] : []);
    findings.push({id: `finding-${c.id}`.slice(0, 128), caseId: c.id, criterionIds: [...c.criterionIds], surfaceIds: [...c.surfaceIds],
      blocking: c.required || verdict.introduced, introduced: verdict.introduced, reproducible: true,
      summary: bounded(`Case ${c.id} failed on candidate ${version.candidateCommit.slice(0, 12)}: ${verdict.failedChecks.join(", ")}.`),
      reproduction: unique([...c.preconditions.map(p => bounded(`Given: ${p}`)), ...c.actions.map(a => bounded(a)),
        ...c.bindings.map(b => `Run configured runner ${b.runnerId} for checks ${b.checkIds.join(", ")} at ${version.candidateCommit}.`)]),
      expected: bounded(c.expected), actual: bounded(verdict.notes.join(" ")), locations: [], executions: failing});
  }
  // An unclosed blocking finding is never dropped: only the same case passing on a new candidate closes it.
  for (const earlier of previousReport?.findings ?? [])
    if (earlier.blocking && verdicts.get(earlier.caseId)?.status !== "PASS" && !findings.some(f => f.id === earlier.id)) findings.push(earlier);
  const attempt = await store.put("attempt", {schemaVersion: 1, id: `attempt-${author.generation}`, version, generation: author.generation,
    plan: control.plan, session: author.session, startedAt: author.startedAt, finishedAt: now(), materials: [...author.materials],
    materialDigest: author.materialDigest, executions: unique([...refs.values()].flat().map(r => r.digest)).map(digest => ({kind: "execution" as const, digest})),
    usage: author.usage, lineage: author.lineage} satisfies QaAttempt);
  const report: QaReport = {schemaVersion: 1, id: `report-${author.generation}`, version, attempt, createdAt: now(), results, findings, questions: [...author.questions]};
  const reportRef = await store.put("report", report);
  const blocking = findings.filter(f => f.blocking);
  const unmet = plan.cases.filter(c => c.required && c.mode !== "nonmechanical" && verdicts.get(c.id)!.status === "UNKNOWN").map(c => c.id);
  const environment = plan.environment.filter(e => e.required && e.status !== "available").map(e => e.name);
  const found = await decisions(store, control.decisions);
  const planRef = control.plan;
  const open = requiredQuestions(plan, report).filter(q => !answered(found, planRef, version, q.id)).map(q => q.id);
  // Semantic progress compares failing cases, checks, requirements and environment, never wording or commit churn.
  const semantic = blocking.length + unmet.length + environment.length === 0 ? null : sha256(canonicalJson({
    findings: blocking.map(f => ({caseId: f.caseId, criterionIds: [...f.criterionIds].sort(), checks: verdicts.get(f.caseId)?.failedChecks ?? []}))
      .sort((a, b) => a.caseId < b.caseId ? -1 : 1), unmet: [...unmet].sort(), environment: [...environment].sort()}));
  const progress = semantic === null ? null : {semanticHash: semantic,
    consecutive: control.progress?.semanticHash === semantic ? control.progress.consecutive + 1 : 1, at: now()};
  const noProgress = progress !== null && progress.consecutive >= 2;
  const state: QaState = noProgress ? "blocked" : blocking.length > 0 ? "awaiting-repair"
    : unmet.length + environment.length > 0 ? "blocked" : open.length > 0 ? "awaiting-input" : "testing";
  await store.updateControl(taskId, control.revision, current => ({...current!, revision: current!.revision + 1, state, attempt, report: reportRef,
    progress, continuation: !noProgress, updatedAt: now()})).catch(error => {
    if (error instanceof AgentOpsError && error.code === "QA_CONTROL_CHANGED")
      throw new AgentOpsError("QA_STALE_WRITER", "QA control moved (stop, takeover or another result); this result is rejected.", {cause: error});
    throw error;
  });
  const followup = await collectQaFollowups({commonDir: store.commonDir, report, reportDigest: reportRef.digest});
  const blockers = [...(noProgress ? [`no-progress: the same semantic failure repeated for ${progress!.consecutive} consecutive rounds`] : []),
    ...blocking.map(f => `finding:${f.id}`), ...unmet.map(id => `unexecuted:${id}`), ...environment.map(name => `environment:${name}`), ...open.map(id => `question:${id}`)];
  return {state, attempt, report: reportRef, reused, blockers, followupWarnings: followup.warnings};
}

/** A sealed attestation is reused only while every version input is unchanged. */
export async function currentQaAttestation(store: FileQaStore, version: QaVersion): Promise<QaReference | null> {
  const control = await store.readControl(version.taskId);
  if (control?.state !== "passed" || control.attestation === null) return null;
  const attestation = await store.get({...control.attestation, kind: "attestation"});
  return qaVersionMatches(attestation.version, version) ? control.attestation : null;
}

export interface QaSealOptions {
  readonly store: FileQaStore;
  readonly version: QaVersion;
  /** The integrated delivery: the root first, then its scoped tasks, whose hashes the version binds. */
  readonly tasks: readonly AgentTask[];
  readonly gitRunner: GitRunner;
  readonly now?: () => string;
}
/**
 * The controller-computed QA verdict. Every input is re-checked against the current candidate and
 * contracts; decisions answer questions but never waive a failed, unexecuted or environment-blocked case.
 */
export async function sealQaAttestation(options: QaSealOptions): Promise<{readonly attestation: QaReference; readonly reused: boolean}> {
  const {store, version} = options, now = options.now ?? (() => new Date().toISOString());
  const current = await currentQaAttestation(store, version);
  if (current !== null) return {attestation: current, reused: true};
  const control = await store.readControl(version.taskId);
  if (control === null) return fail("QA_NOT_STARTED", "This task has no QA state.");
  if (control.owner !== null) return fail("QA_WRITER_LIVE", "A live or unidentified QA writer owns this task; nothing is sealed.");
  if (!control.continuation) return fail("QA_CONTINUATION_DISABLED", "QA was stopped for this task; nothing is sealed.");
  if (control.state !== "testing" || control.plan === null || control.attempt === null || control.report === null)
    return fail("QA_NOT_READY", `QA is ${control.state}; only a tested candidate can be sealed.`);
  const plan = await store.get({...control.plan, kind: "plan"}), attempt = await store.get({...control.attempt, kind: "attempt"});
  const report = await store.get({...control.report, kind: "report"});
  if (report.attempt.digest !== control.attempt.digest || attempt.plan.digest !== control.plan.digest)
    return fail("QA_STATE_INVALID", "QA plan, attempt and report do not form one lineage.");
  if (!qaVersionMatches(report.version, version) || !qaVersionMatches(attempt.version, version))
    return fail("QA_PROOF_STALE", "QA observations describe another candidate, source, contract, policy or config; re-execute.");
  if (!qaContractsMatch(plan.version, version)) return fail("QA_PLAN_STALE", "The QA plan describes another goal, contract, scope, policy or config.");
  const [root] = options.tasks;
  if (root?.id !== version.taskId || taskContractHash(root) !== version.taskContractHash || treeContractHash(options.tasks) !== version.treeContractHash ||
    canonicalJson(options.tasks.map(t => t.id)) !== canonicalJson(plan.taskIds))
    return fail("QA_PROOF_STALE", "The scoped task tree no longer matches the QA version.");
  if (await resolveGitCommit(options.gitRunner, "HEAD") !== version.candidateCommit) return fail("QA_CANDIDATE_MOVED", "The delivery moved after QA executed.");
  if (attempt.lineage === undefined) return fail("QA_LINEAGE_REQUIRED", "The attempt does not name its material import lineage.");
  for (const material of attempt.materials) {
    const blob = await options.gitRunner.run(["show", `${version.candidateCommit}:${material.path}`]);
    if (blob.exitCode !== 0 || sha256(Buffer.from(blob.stdout)) !== material.digest)
      return fail("QA_MATERIAL_CHANGED", `QA material ${material.path} differs in the final candidate.`);
  }
  const refs = unique(report.results.flatMap(r => r.executions.map(e => e.digest))).map(digest => ({kind: "execution" as const, digest}));
  const executions = await Promise.all(refs.map(async ref => ({ref, execution: await store.get(ref)})));
  if (executions.some(({ref, execution}) => !qaVersionMatches(execution.version, version) || !attempt.executions.some(a => a.digest === ref.digest)))
    return fail("QA_PROOF_STALE", "An execution was not observed on this exact final candidate by this attempt.");
  const blockers: {code: string; detail: string}[] = [];
  const materialDigests = await bindingMaterialDigests(plan.cases.filter(c => report.results.some(r => r.caseId === c.id && r.executions.length > 0)),
    options.gitRunner, version.candidateCommit);
  for (const f of report.findings.filter(f => f.blocking)) blockers.push({code: "QA_BLOCKING_FINDING", detail: `${f.id} (${f.caseId})`});
  const nonmechanical: string[] = [];
  for (const c of plan.cases) {
    const result = report.results.find(r => r.caseId === c.id);
    const verdict = qaCaseVerdict(c, executions.filter(({ref, execution}) => execution.caseId === c.id &&
      result?.executions.some(r => r.digest === ref.digest)).map(e => e.execution), materialDigests);
    if (c.mode === "nonmechanical") {
      if (c.required && result?.status !== "FAIL") nonmechanical.push(c.id);
      else if (c.required) blockers.push({code: "QA_REQUIRED_CASE_UNMET", detail: c.id});
    } else if ((c.required && verdict.status !== "PASS") || (verdict.status === "FAIL" && verdict.introduced))
      blockers.push({code: "QA_REQUIRED_CASE_UNMET", detail: `${c.id}: ${verdict.status}`});
  }
  if (!plan.cases.some(c => c.required)) blockers.push({code: "QA_REQUIRED_CASE_UNMET", detail: "the plan has no required case"});
  // Reasoned inspection cannot stand in for a criterion the task itself made mechanically testable.
  for (const task of options.tasks) for (const criterion of task.criteria)
    if (criterion.acceptance !== undefined && criterion.acceptance.mode !== "review-only" &&
      !plan.cases.some(c => c.required && c.mode !== "nonmechanical" && c.criterionIds.includes(criterion.id)))
      blockers.push({code: "QA_MECHANICAL_DOWNGRADE", detail: criterion.id});
  for (const e of plan.environment.filter(e => e.required && e.status !== "available")) blockers.push({code: "QA_ENVIRONMENT_MISSING", detail: e.name});
  const found = await decisions(store, control.decisions);
  for (const q of requiredQuestions(plan, report)) if (!answered(found, control.plan, version, q.id)) blockers.push({code: "QA_DECISION_REQUIRED", detail: q.id});
  if (blockers.length > 0) throw new AgentOpsError(blockers[0]!.code, `QA cannot pass: ${blockers.map(b => `${b.code} ${b.detail}`).join("; ")}.`);
  const used = found.filter(({decision}) => decision.plan.digest === control.plan!.digest && qaContractsMatch(decision.version, version)).map(d => d.ref);
  const attestation = await store.put("attestation", {schemaVersion: 1, version, plan: control.plan, report: control.report, executions: refs,
    decisions: used, materialDigest: attempt.materialDigest, caseIds: plan.cases.filter(c => c.required).map(c => c.id),
    nonmechanicalCaseIds: nonmechanical, session: attempt.session, generation: attempt.generation, sealedAt: now()});
  await store.updateControl(version.taskId, control.revision, saved => ({...saved!, revision: saved!.revision + 1, state: "passed", attestation,
    progress: null, updatedAt: now()})).catch(error => {
    if (error instanceof AgentOpsError && error.code === "QA_CONTROL_CHANGED")
      throw new AgentOpsError("QA_STALE_WRITER", "QA control moved while sealing; nothing was sealed.", {cause: error});
    throw error;
  });
  return {attestation, reused: false};
}
