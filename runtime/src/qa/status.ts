import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentOpsConfig, AgentTask } from "../contracts.js";
import { resolveReviewScope } from "../review/scope.js";
import type { StoredTaskRecord } from "../task/store.js";
import { resolveGitCommit, type GitRunner } from "../verify/change-surface.js";
import { calculateSourceFingerprint } from "../verify/source-fingerprint.js";
import { showQa, type QaShow } from "./decisions.js";
import { qaDeliveryTree, qaDeliveryVersion } from "./gate.js";
import { qaVersionMatches } from "./policy.js";
import { nativeQaProbe, qaOwnerStatus, type QaProcessProbe } from "./session.js";
import type { FileQaStore } from "./store.js";
import type { QaVersion } from "./types.js";

const exec = promisify(execFile);

/** What task status, qa show and Office say about QA: read from saved private state only, never a model or runner. */
export interface QaStatus {
  /** The enrolled delivery root whose QA gates this task; null when no ancestor is enrolled. */
  readonly rootTaskId: string | null;
  readonly state: QaShow["state"] | "not-enrolled";
  /**
   * PASS: a sealed attestation naming the complete current delivery version, exactly as the delivery gate compares it
   * (or, for a finished delivery, the one it finished with). STALE: sealed for another candidate, source, config, policy
   * or contract, or the current version is unreadable. NOT_REQUIRED: legacy/not enrolled, never PASS.
   */
  readonly outcome: "PASS" | "STALE" | "PENDING" | "NOT_REQUIRED";
  readonly late: boolean;
  /** The delivery is no longer active: its saved QA is history, not a live gate. */
  readonly historical: boolean;
  /** A registered QA writer still owns the task and its process is confirmed running. */
  readonly live: boolean;
  /** The saved writer, probed without starting anything: an exited writer left no result and blocks until QA runs again. */
  readonly writer?: "live" | "exited" | "unidentified";
  readonly findings: number;
  readonly questions: number;
  readonly blockers: readonly string[];
  readonly updatedAt: string | null;
}

const NOT_ENROLLED: QaStatus = {rootTaskId: null, state: "not-enrolled", outcome: "NOT_REQUIRED", late: false, historical: false,
  live: false, findings: 0, questions: 0, blockers: [], updatedAt: null};

/** The task itself or its nearest enrolled ancestor: children keep local verify, their integrated root carries QA. */
export function qaDeliveryRoot(records: readonly StoredTaskRecord[], taskId: string): StoredTaskRecord | null {
  const seen = new Set<string>();
  for (let record = records.find(r => r.task.id === taskId); record !== undefined && !seen.has(record.task.id);
    record = records.find(r => r.task.id === record!.task.parentTaskId)) {
    seen.add(record.task.id);
    if (record.task.qa !== undefined) return record;
  }
  return null;
}

/** The checkout whose current delivery version an active QA PASS must still name. */
export interface QaCurrent {
  readonly root: string;
  readonly loadConfig: () => Promise<AgentOpsConfig>;
  /** An explicit --base; otherwise the task's recorded review, completion and creation bases are tried. */
  readonly base?: string;
  readonly gitRunner?: GitRunner;
}

function checkoutGit(root: string): GitRunner {
  return {run: async args => await exec("git", [...args], {cwd: root, encoding: "buffer", maxBuffer: 64 * 1024 * 1024})
    .then(r => ({exitCode: 0, stdout: r.stdout}), (e: {code?: unknown; stdout?: Uint8Array}) =>
      ({exitCode: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? new Uint8Array()}))};
}

/**
 * Whether the saved version still names this checkout: the delivery gate's own qaDeliveryVersion/qaVersionMatches over
 * HEAD, the source fingerprint, config and contracts. Git and hashing only: no model or runner. Unreadable is never PASS.
 */
async function matchesCurrent(saved: QaVersion, current: QaCurrent, root: StoredTaskRecord, tasks: readonly AgentTask[]): Promise<boolean> {
  const runner = current.gitRunner ?? checkoutGit(current.root);
  let config: AgentOpsConfig, candidateCommit: string;
  try {[config, candidateCommit] = await Promise.all([current.loadConfig(), resolveGitCommit(runner, "HEAD")]);}
  catch {return false;}
  // The fingerprint depends on the base verify used; try the same bases task completion and coverage use.
  const bases = [...new Set([current.base, root.reviewBase, root.completionBase ?? undefined, root.createdSourceCommit, undefined])];
  for (const base of bases) {
    try {
      const scope = await resolveReviewScope({root: current.root, runner, ...(base === undefined ? {} : {base}),
        ...(root.noChangePaths === undefined ? {} : {noChangePaths: root.noChangePaths})});
      const sourceFingerprint = await calculateSourceFingerprint(current.root, scope, runner);
      if (qaVersionMatches(saved, qaDeliveryVersion({tasks, config, candidateCommit, sourceFingerprint}))) return true;
    } catch {/* A dirty tree, missing base or unreadable source cannot match this base. */}
  }
  return false;
}

export async function qaStatus(store: FileQaStore, records: readonly StoredTaskRecord[], taskId: string, current: QaCurrent | null,
  probe: QaProcessProbe = nativeQaProbe): Promise<QaStatus> {
  const root = qaDeliveryRoot(records, taskId);
  if (root === null) return NOT_ENROLLED;
  const control = await store.readControl(root.task.id);
  const show = await showQa(store, root.task.id);
  const historical = root.status !== "active";
  let outcome: QaStatus["outcome"] = "PENDING";
  if (control?.state === "passed" && control.attestation !== null) {
    const {version} = await store.get({...control.attestation, kind: "attestation"});
    const tree = qaDeliveryTree(records, root.task.id).map(r => r.task);
    outcome = historical || (current !== null && await matchesCurrent(version, current, root, tree.length === 0 ? [root.task] : tree))
      ? "PASS" : "STALE";
  }
  const plan = control?.plan == null ? null : await store.get({...control.plan, kind: "plan"});
  const questions = show.questions.filter(q => q.required && !q.answered);
  const findings = show.state === "passed" ? [] : show.findings.filter(f => f.blocking);
  // An owner record alone is not a running writer: a killed session leaves it behind (seen live).
  const owner = control?.owner == null ? null : await qaOwnerStatus(control.owner, probe);
  const writer = owner === null ? undefined : owner === "dead" ? "exited" as const : owner;
  const blockers = [
    ...(plan?.environment ?? []).filter(e => e.required && e.status !== "available").map(e => `environment:${e.name}`),
    ...questions.map(q => `question:${q.id}`), ...findings.map(f => `finding:${f.id}`),
    ...(show.native === null ? [] : [`native:${show.native.reason}`]), ...(show.state === "stopped" ? ["stopped"] : []), ...(writer === "exited" ? ["writer:exited"] : [])];
  return {rootTaskId: root.task.id, state: show.state, outcome, late: root.task.qa!.late, historical, live: writer === "live",
    ...(writer === undefined ? {} : {writer}), findings: findings.length, questions: questions.length, blockers, updatedAt: control?.updatedAt ?? null};
}

/** One line for task status; a legacy task says it is not enrolled, never that QA passed. */
export function renderQaStatus(status: QaStatus, taskId: string): string {
  if (status.rootTaskId === null) return "Independent QA: not enrolled (not required; this is not a QA PASS)";
  const notes = [status.rootTaskId === taskId ? null : `delivery root ${status.rootTaskId}`, status.late ? "adopted late" : null,
    status.historical ? "historical" : null, status.writer === undefined ? (status.live ? "writer live" : null) : `writer ${status.writer}`].filter((n): n is string => n !== null);
  return `Independent QA: ${status.state} · ${status.outcome}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}; ` +
    `blocking findings ${status.findings}; open questions ${status.questions}` +
    (status.blockers.length === 0 ? "" : `; blockers ${status.blockers.join(", ")}`);
}
