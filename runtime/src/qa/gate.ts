import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentOpsConfig, AgentTask } from "../contracts.js";
import { calculateConfigHash, canonicalJson } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { readPrivateFile } from "../security/permissions.js";
import { goalHash, taskContractHash, treeContractHash } from "../task/contract.js";
import { FileTaskStore, type StoredTaskRecord } from "../task/store.js";
import { qaVersionMatches } from "./policy.js";
import { qaHistory } from "./decisions.js";
import { FileQaStore } from "./store.js";
import type { QaArtifactKind, QaReference, QaVersion } from "./types.js";

const exec = promisify(execFile);

/** What one integrated delivery proves: everything, or exactly the selected tasks on top of already-landed dependencies. */
export interface QaDeliveryScope {
  readonly scope: "full" | "partial";
  readonly dependencyTaskIds: readonly string[];
}
export const FULL_QA_SCOPE: QaDeliveryScope = {scope: "full", dependencyTaskIds: []};

/** The delivery root first, then its live descendants by id: one canonical order for plans, versions and seals. */
export function qaDeliveryTree(records: readonly StoredTaskRecord[], rootId: string): StoredTaskRecord[] {
  const live = records.filter(r => r.status !== "archived" && r.supersededBy === undefined);
  const root = live.find(r => r.task.id === rootId);
  if (root === undefined) return [];
  const ids = new Set([rootId]);
  for (let grown = true; grown;) {
    grown = false;
    for (const r of live) if (r.task.parentTaskId !== undefined && ids.has(r.task.parentTaskId) && !ids.has(r.task.id)) {ids.add(r.task.id); grown = true;}
  }
  return [root, ...live.filter(r => r.task.id !== rootId && ids.has(r.task.id)).sort((a, b) => a.task.id < b.task.id ? -1 : 1)];
}
/** Which tasks the delivery integrates; their contracts are bound separately by the tree hash. */
export function qaScopeHash(taskIds: readonly string[]): string {
  return sha256(canonicalJson({domain: "agent-ops-qa-scope-v1", taskIds: [...taskIds].sort()}));
}
/** The exact version a QA attestation must name for this candidate; the root carries the frozen QA policy. */
export function qaDeliveryVersion(input: {readonly tasks: readonly AgentTask[]; readonly config: AgentOpsConfig;
  readonly candidateCommit: string; readonly sourceFingerprint: string}): QaVersion {
  const root = input.tasks[0]!;
  return {taskId: root.id, goalHash: goalHash(root), taskContractHash: taskContractHash(root), treeContractHash: treeContractHash(input.tasks),
    scopeHash: qaScopeHash(input.tasks.map(t => t.id)), policyHash: root.qa!.policyHash, configHash: calculateConfigHash(input.config),
    candidateCommit: input.candidateCommit, sourceFingerprint: input.sourceFingerprint};
}
async function git(root: string, args: readonly string[]): Promise<string> {
  return (await exec("git", [...args], {cwd: root, maxBuffer: 1024 * 1024})).stdout.trim();
}
export async function qaCommonDirectory(root: string): Promise<string> {
  return resolve(root, await git(root, ["rev-parse", "--git-common-dir"]));
}
async function readTasks(root: string): Promise<readonly StoredTaskRecord[]> {
  return (await new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root).read()).tasks;
}

export interface QaDeliveryProblem { readonly code: string; readonly status: "FAIL"; readonly remedy: string }
/**
 * The one QA evidence check every delivery path shares (task complete, Stop gate, finish, advance,
 * run finalize/recovery and land). Unenrolled tasks return at once: no read, hash or spending.
 * Enrolled tasks need a controller-sealed attestation naming this exact candidate and contracts.
 */
export async function checkQaDeliveryEvidence(stored: StoredTaskRecord, options: {
  readonly root: string;
  readonly config: AgentOpsConfig;
  readonly sourceFingerprint: string;
  readonly records?: readonly StoredTaskRecord[];
  readonly platform?: NodeJS.Platform;
}): Promise<QaDeliveryProblem | null> {
  if (stored.task.qa === undefined) return null;
  const fail = (code: string, remedy: string): QaDeliveryProblem => ({code, status: "FAIL", remedy});
  if ((options.platform ?? process.platform) !== "darwin")
    return fail("QA_UNSUPPORTED_PLATFORM", "This delivery requires independent QA, which is supported only on macOS; it cannot be delivered here.");
  const rerun = `Run agent-ops verify --task ${stored.task.id} on the committed candidate: independent QA executes first; inspect it with agent-ops qa show --task ${stored.task.id}.`;
  try {
    const records = (options.records ?? await readTasks(options.root)).map(r => r.task.id === stored.task.id ? stored : r);
    const tasks = qaDeliveryTree(records, stored.task.id).map(r => r.task);
    if (tasks.length === 0) tasks.push(stored.task);
    const version = qaDeliveryVersion({tasks, config: options.config, candidateCommit: await git(options.root, ["rev-parse", "HEAD"]),
      sourceFingerprint: options.sourceFingerprint});
    const store = new FileQaStore(await qaCommonDirectory(options.root));
    const control = await store.readControl(stored.task.id);
    if (control?.owner != null) return fail("QA_WRITER_LIVE", `A QA session still owns ${stored.task.id}; let it finish or run agent-ops qa stop --task ${stored.task.id}.`);
    if (control?.state === "passed" && control.attestation !== null &&
      qaVersionMatches((await store.get({...control.attestation, kind: "attestation"})).version, version)) return null;
    return fail("QA_REQUIRED", `Required independent QA has no sealed PASS for this exact candidate (QA ${control?.state ?? "not started"}). ${rerun}`);
  } catch (error) {
    return fail("QA_REQUIRED", `QA evidence is unreadable (${error instanceof Error ? error.message : String(error)}). ${rerun}`);
  }
}

interface SealedValue { readonly digest: string; readonly value: unknown }
const seal = (value: unknown): SealedValue => ({digest: sha256(JSON.stringify(value)), value});
/** Receipt copy of one enrolled delivery's QA proof; private QA state and checkouts may be cleaned up after finish. */
export interface QaReceiptProof {
  readonly attestation: string;
  readonly scope: QaDeliveryScope["scope"];
  /** Only the full scope may claim the whole goal; a partial landing proves its selected tasks and dependencies. */
  readonly fullGoal: boolean;
  readonly taskIds: readonly string[];
  readonly dependencyTaskIds: readonly string[];
  /** `${kind}/${digest}`: plan, attempt, report, executions, decisions and the attestation, byte-identical to the QA store. */
  readonly artifacts: Readonly<Record<string, SealedValue>>;
  /** Trusted replay evidence and raw execution artifacts the executions reference, by delivery-checkout path. */
  readonly evidence: Readonly<Record<string, SealedValue>>;
}
/** Collects every artifact behind a current attestation; anything missing or changed refuses the receipt. */
export async function sealQaReceiptProof(store: FileQaStore, attestationRef: QaReference, root: string): Promise<QaReceiptProof> {
  const artifacts: Record<string, SealedValue> = {}, evidence: Record<string, SealedValue> = {};
  const take = async <K extends QaArtifactKind>(kind: K, digest: string) => {
    const value = await store.get({kind, digest} as QaReference & {kind: K});
    artifacts[`${kind}/${digest}`] = seal(value);
    return value;
  };
  const attestation = await take("attestation", attestationRef.digest);
  const plan = await take("plan", attestation.plan.digest);
  const report = await take("report", attestation.report.digest);
  await take("attempt", report.attempt.digest);
  for (const ref of attestation.decisions) await take("decision", ref.digest);
  for (const ref of attestation.executions) {
    const execution = await take("execution", ref.digest);
    for (const file of execution.evidenceReferences) {
      if (!/^\.agent-ops\/tasks\/(?:acceptance\/[a-f0-9]{64}\.json|evidence\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*-[a-f0-9]{16}\.json)$/u.test(file.path))
        throw new AgentOpsError("QA_EXECUTION_INVALID", "QA proof may include only trusted replay evidence paths.");
      const content = await readPrivateFile(join(root, ...file.path.split("/")), root);
      if (content === null || sha256(content) !== file.digest) throw new Error(`QA execution evidence ${file.path} is missing or changed.`);
      evidence[file.path] = seal(content);
    }
  }
  return {attestation: attestationRef.digest, scope: plan.scope, fullGoal: plan.scope === "full", taskIds: [...plan.taskIds],
    dependencyTaskIds: [...plan.dependencyTaskIds], artifacts, evidence};
}
/** True when every sealed QA artifact still has its store identity and the attestation names this receipt's candidate. */
export function validQaReceiptProof(proof: QaReceiptProof, receipt: {readonly candidateHead: string; readonly sourceFingerprint: string}, taskId: string): boolean {
  try {
    for (const [key, sealed] of Object.entries(proof.artifacts)) {
      const digest = key.split("/")[1];
      if (sealed.digest !== sha256(JSON.stringify(sealed.value)) || sha256(canonicalJson(sealed.value)) !== digest) return false;
    }
    for (const [path, sealed] of Object.entries(proof.evidence))
      if (typeof sealed.value !== "string" || sealed.digest !== sha256(JSON.stringify(sealed.value)) || path.includes("..")) return false;
    const attestation = proof.artifacts[`attestation/${proof.attestation}`]?.value as {version?: QaVersion; plan?: QaReference; report?: QaReference} | undefined;
    const plan = attestation?.plan === undefined ? undefined : proof.artifacts[`plan/${attestation.plan.digest}`]?.value as {scope?: string} | undefined;
    return attestation?.version?.taskId === taskId && attestation.version.candidateCommit === receipt.candidateHead &&
      attestation.version.sourceFingerprint === receipt.sourceFingerprint && plan?.scope === proof.scope &&
      proof.fullGoal === (proof.scope === "full") && attestation.report !== undefined && proof.artifacts[`report/${attestation.report.digest}`] !== undefined;
  } catch {return false;}
}

/** Reuse the sealed receipt format so a read-only reviewer can inspect the original controller records. */
export async function qaReviewArtifact(store: FileQaStore, stored: StoredTaskRecord, version: QaVersion, root: string):
  Promise<{readonly path: string; readonly digest: string; readonly content: string}> {
  const control = await store.readControl(stored.task.id);
  if (control?.state !== "passed" || control.attestation === null)
    throw new AgentOpsError("QA_PROOF_REQUIRED", "Review needs a sealed independent QA proof.");
  const attestation = await store.get({...control.attestation, kind: "attestation"});
  if (!qaVersionMatches(attestation.version, version))
    throw new AgentOpsError("QA_PROOF_STALE", "The QA proof is not current for this review.");
  const proof = await sealQaReceiptProof(store, control.attestation, root), historicalDecisions: Record<string, SealedValue> = {};
  for (const ref of (control.decisions ?? []).slice(-8)) {
    if (attestation.decisions.some(d => d.digest === ref.digest)) continue;
    const decision = await store.get({...ref, kind: "decision"});
    if (decision.version.taskId === version.taskId && decision.version.goalHash === version.goalHash)
      historicalDecisions[`decision/${ref.digest}`] = seal(decision);
  }
  const content = JSON.stringify({schemaVersion: 1, proof, historicalDecisions,
    authority: "Only proof.attestation names current QA proof; historicalDecisions retain their original versions and are not answers to a new plan."}), digest = sha256(content);
  return {path: `.agent-ops/tasks/qa-proof/${stored.task.id}-${digest}.json`, digest, content};
}

const cut = (value: string, max = 240) => value.length <= max ? value : `${value.slice(0, max - 1)}…`;
/**
 * Compact QA facts both final reviewers inspect as untrusted DATA: materials, coverage, provenance,
 * independence, fallback, nonmechanical cases and lineage. Never a review report or attestation.
 */
export async function qaReviewData(store: FileQaStore, stored: StoredTaskRecord, version: QaVersion): Promise<Record<string, unknown>> {
  const control = await store.readControl(stored.task.id);
  const get = async <K extends QaArtifactKind>(ref: QaReference | null | undefined, kind: K) =>
    ref == null ? null : await store.get({...ref, kind} as QaReference & {kind: K});
  const attestation = control?.state === "passed" ? await get(control.attestation, "attestation") : null;
  const plan = await get(attestation?.plan ?? control?.plan, "plan");
  const report = await get(attestation?.report ?? control?.report, "report");
  const attempt = await get(report?.attempt, "attempt");
  const decisions = await Promise.all((attestation?.decisions ?? []).map(ref => store.get({...ref, kind: "decision"})));
  return {taskId: stored.task.id, enrollment: stored.task.qa, state: control?.state ?? "not-started",
    current: attestation !== null && qaVersionMatches(attestation.version, version), attestation: control?.attestation?.digest ?? null,
    plan: plan === null ? null : {timing: plan.timing, scope: plan.scope, taskIds: plan.taskIds, dependencyTaskIds: plan.dependencyTaskIds,
      session: plan.session, environment: plan.environment.map(e => ({name: e.name, required: e.required, status: e.status})),
      cases: plan.cases.map(c => ({id: c.id, criterionIds: c.criterionIds, surfaceIds: c.surfaceIds, required: c.required, mode: c.mode,
        expected: cut(c.expected), ...(c.nonmechanicalReason === undefined ? {} : {nonmechanicalReason: cut(c.nonmechanicalReason)}),
        bindings: c.bindings.map(b => ({runnerId: b.runnerId, checkIds: b.checkIds, redCheckIds: b.redCheckIds ?? [], materials: b.materials.map(m => m.path)}))}))},
    attempt: attempt === null ? null : {generation: attempt.generation, session: attempt.session, lineage: attempt.lineage ?? null,
      candidateCommit: attempt.version.candidateCommit, materials: attempt.materials.map(m => ({path: m.path, role: m.role, digest: m.digest})), usage: attempt.usage},
    results: report?.results.map(r => ({caseId: r.caseId, status: r.status, observations: r.observations.slice(0, 4).map(o => cut(o, 200))})) ?? [],
    findings: report?.findings.map(f => ({id: f.id, caseId: f.caseId, blocking: f.blocking, introduced: f.introduced, summary: cut(f.summary)})) ?? [],
    decisions: decisions.map(d => ({questionId: d.questionId, answer: cut(d.answer), answeredBy: d.answeredBy})),
    history: await qaHistory(store, control, version),
    nonmechanicalCaseIds: attestation?.nonmechanicalCaseIds ?? []};
}
