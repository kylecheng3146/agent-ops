import { taskContractHash, treeContractHash } from "../task/contract.js";
import type { StoredTaskRecord } from "../task/store.js";
import { showQa, type QaShow } from "./decisions.js";
import { qaDeliveryTree } from "./gate.js";
import type { FileQaStore } from "./store.js";

/** What task status, qa show and Office say about QA: read from saved private state only, never a model or runner. */
export interface QaStatus {
  /** The enrolled delivery root whose QA gates this task; null when no ancestor is enrolled. */
  readonly rootTaskId: string | null;
  readonly state: QaShow["state"] | "not-enrolled";
  /**
   * PASS: a sealed attestation naming the current HEAD and contracts (or, for a finished delivery, the one it
   * finished with). STALE: sealed for another candidate or contract. NOT_REQUIRED: legacy/not enrolled, never PASS.
   */
  readonly outcome: "PASS" | "STALE" | "PENDING" | "NOT_REQUIRED";
  readonly late: boolean;
  /** The delivery is no longer active: its saved QA is history, not a live gate. */
  readonly historical: boolean;
  /** A registered QA writer still owns the task. */
  readonly live: boolean;
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

export async function qaStatus(store: FileQaStore, records: readonly StoredTaskRecord[], taskId: string, head: string | null): Promise<QaStatus> {
  const root = qaDeliveryRoot(records, taskId);
  if (root === null) return NOT_ENROLLED;
  const control = await store.readControl(root.task.id);
  const show = await showQa(store, root.task.id);
  const historical = root.status !== "active";
  let outcome: QaStatus["outcome"] = "PENDING";
  if (control?.state === "passed" && control.attestation !== null) {
    const {version} = await store.get({...control.attestation, kind: "attestation"});
    const tree = qaDeliveryTree(records, root.task.id).map(r => r.task);
    outcome = historical || (version.candidateCommit === head && version.taskContractHash === taskContractHash(root.task) &&
      version.treeContractHash === treeContractHash(tree.length === 0 ? [root.task] : tree)) ? "PASS" : "STALE";
  }
  const plan = control?.plan == null ? null : await store.get({...control.plan, kind: "plan"});
  const questions = show.questions.filter(q => q.required && !q.answered);
  const findings = show.state === "passed" ? [] : show.findings.filter(f => f.blocking);
  const blockers = [
    ...(plan?.environment ?? []).filter(e => e.required && e.status !== "available").map(e => `environment:${e.name}`),
    ...questions.map(q => `question:${q.id}`), ...findings.map(f => `finding:${f.id}`),
    ...(show.native === null ? [] : [`native:${show.native.reason}`]), ...(show.state === "stopped" ? ["stopped"] : [])];
  return {rootTaskId: root.task.id, state: show.state, outcome, late: root.task.qa!.late, historical, live: show.writer !== null,
    findings: findings.length, questions: questions.length, blockers, updatedAt: control?.updatedAt ?? null};
}

/** One line for task status; a legacy task says it is not enrolled, never that QA passed. */
export function renderQaStatus(status: QaStatus, taskId: string): string {
  if (status.rootTaskId === null) return "Independent QA: not enrolled (not required; this is not a QA PASS)";
  const notes = [status.rootTaskId === taskId ? null : `delivery root ${status.rootTaskId}`, status.late ? "adopted late" : null,
    status.historical ? "historical" : null, status.live ? "writer live" : null].filter((n): n is string => n !== null);
  return `Independent QA: ${status.state} · ${status.outcome}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}; ` +
    `blocking findings ${status.findings}; open questions ${status.questions}` +
    (status.blockers.length === 0 ? "" : `; blockers ${status.blockers.join(", ")}`);
}
