import { AgentOpsError } from "../fs/paths.js";
import { qaContractsMatch } from "./proof.js";
import { qaVersionMatches } from "./policy.js";
import type { FileQaStore } from "./store.js";
import type { QaControl, QaPlan, QaReference, QaReport, QaState, QaUsage, QaVersion } from "./types.js";

export interface QaRespondInput {
  readonly store: FileQaStore;
  readonly version: QaVersion;
  readonly questionId: string;
  /** A genuine human answer relayed verbatim; QA or developer agents must never compose one. */
  readonly answer: string;
  readonly answeredBy: string;
  readonly now: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Historical context keeps its original versions and references; it grants no current proof or answer authority. */
export async function qaHistory(store: FileQaStore, control: QaControl | null, version: QaVersion): Promise<Record<string, unknown>> {
  const sameGoal = (v: QaVersion) => v.taskId === version.taskId && v.goalHash === version.goalHash;
  const reports = [], decisionRefs = new Map<string, QaReference>();
  const reportIds = new Set<string>();
  let saved = control, scanned = 0;
  for (; saved !== null && scanned < 64; scanned++) {
    if (saved.report !== null && !reportIds.has(saved.report.digest) && reports.length < 2) {
      reportIds.add(saved.report.digest);
      const r = await store.get({...saved.report, kind: "report"});
      if (sameGoal(r.version)) reports.push({reference: saved.report, version: r.version,
        contractsMatch: qaContractsMatch(r.version, version), attempt: r.attempt, createdAt: r.createdAt,
        results: r.results.slice(0, 16).map(result => ({caseId: result.caseId, status: result.status,
          executions: result.executions.slice(0, 2), observations: result.observations.slice(0, 2).map(o => o.slice(0, 160))}))});
    }
    for (const ref of [...(saved.decisions ?? [])].reverse()) if (!decisionRefs.has(ref.digest) && decisionRefs.size < 8) decisionRefs.set(ref.digest, ref);
    if (saved.revision <= 1 || reports.length === 2 && decisionRefs.size === 8) break;
    saved = await store.readControlHistory(version.taskId, saved.revision - 1);
  }
  const decisions = [];
  for (const reference of decisionRefs.values()) {
    const d = await store.get({...reference, kind: "decision"});
    if (sameGoal(d.version)) decisions.push({reference, version: d.version, contractsMatch: qaContractsMatch(d.version, version),
      plan: d.plan, questionId: d.questionId, answer: d.answer.slice(0, 512), answerTruncated: d.answer.length > 512,
      answeredBy: d.answeredBy, answeredAt: d.answeredAt});
  }
  return {authority: "Historical context only; not current proof or answers to a new plan.",
    report: reports[0] ?? null, previousReports: reports.slice(1),
    limits: {controlRevisions: 64, reports: 2, reportResults: 16, decisions: 8, answerCharacters: 512, observationCharacters: 160}, decisions};
}
/**
 * Binds one human answer to the exact task, plan question and contract version, then resumes the
 * work that waited for it. Only questions QA actually asked can be answered; an answer is never a
 * waiver, because sealing still re-checks every required case and environment mechanically.
 */
export async function respondQa(input: QaRespondInput): Promise<QaControl> {
  const {store, version} = input, taskId = version.taskId;
  if ((input.env ?? process.env).AGENT_OPS_QA_TASK_ID !== undefined)
    throw new AgentOpsError("QA_ANSWER_NOT_HUMAN", "A QA session cannot answer its own questions; a human answer must be relayed.");
  const control = await store.readControl(taskId);
  if (control === null || control.plan === null) throw new AgentOpsError("QA_NOT_STARTED", "This task has no QA plan with questions.");
  // An optional question stays answerable while the plan waits for its author; a live writer is never interrupted.
  if ((control.state !== "awaiting-input" && control.state !== "plan-ready") || control.owner !== null)
    throw new AgentOpsError("QA_NOT_AWAITING_INPUT", `QA is ${control.state}; it is not waiting for a human answer.`);
  const plan = await store.get({...control.plan, kind: "plan"});
  const report = control.report === null ? null : await store.get({...control.report, kind: "report"});
  const asked = [...plan.questions, ...(report?.questions ?? [])];
  if (!asked.some(q => q.id === input.questionId))
    throw new AgentOpsError("QA_QUESTION_UNKNOWN", "QA did not ask that question; answers cannot introduce new decisions or waivers.");
  if (!qaContractsMatch(plan.version, version))
    throw new AgentOpsError("QA_PLAN_STALE", "The question belongs to another goal, contract, scope, policy or config.");
  const saved = await Promise.all((control.decisions ?? []).map(ref => store.get({...ref, kind: "decision"})));
  if (saved.some(d => d.questionId === input.questionId && d.plan.digest === control.plan!.digest && qaContractsMatch(d.version, version)))
    throw new AgentOpsError("QA_QUESTION_ANSWERED", "That question already has a recorded human answer.");
  const decision = await store.put("decision", {schemaVersion: 1, version, plan: control.plan, questionId: input.questionId,
    answer: input.answer, answeredBy: input.answeredBy, answeredAt: input.now});
  const decisions = [...(control.decisions ?? []), decision];
  const answeredIds = new Set([...saved.filter(d => d.plan.digest === control.plan!.digest && qaContractsMatch(d.version, version)).map(d => d.questionId),
    input.questionId]);
  const waiting = asked.some(q => q.required && !answeredIds.has(q.id));
  // Planning questions resume planning-ready work; questions raised while testing resume testing.
  const state: QaState = waiting ? "awaiting-input" : control.state === "plan-ready" || control.report === null ? "plan-ready" : "testing";
  return await store.updateControl(taskId, control.revision, current => ({...current!, revision: current!.revision + 1, decisions, state, updatedAt: input.now}));
}

export interface QaShow {
  readonly taskId: string;
  readonly state: QaState | "not-started";
  /** Whether saved proof or observations describe the given current version; null when no version was given. */
  readonly stale: boolean | null;
  readonly generation: number;
  readonly continuation: boolean;
  readonly writer: {readonly host: string; readonly sessionId: string; readonly processId: number | null} | null;
  readonly plan: {readonly digest: string; readonly timing: QaPlan["timing"]; readonly scope: QaPlan["scope"]; readonly cases: number;
    readonly host: string; readonly fallbackReason: string | null} | null;
  readonly results: Readonly<Record<"PASS" | "FAIL" | "UNKNOWN", number>>;
  readonly findings: readonly {readonly id: string; readonly caseId: string; readonly blocking: boolean}[];
  readonly questions: readonly {readonly id: string; readonly prompt: string; readonly required: boolean; readonly answered: boolean}[];
  readonly native: {readonly reason: string; readonly resetAt: string | null} | null;
  readonly attestation: string | null;
  /** Reported by the host only; anything not reported is UNKNOWN, never estimated. */
  readonly usage: {readonly [K in keyof QaUsage]: number | "UNKNOWN"};
}
/** Reads saved private QA state only: no model, host, runner or write is ever started here. */
export async function showQa(store: FileQaStore, taskId: string, version?: QaVersion): Promise<QaShow> {
  const control = await store.readControl(taskId);
  const unknown = {inputTokens: "UNKNOWN", outputTokens: "UNKNOWN", totalTokens: "UNKNOWN", costUsd: "UNKNOWN"} as const;
  if (control === null) return {taskId, state: "not-started", stale: null, generation: 0, continuation: false, writer: null, plan: null,
    results: {PASS: 0, FAIL: 0, UNKNOWN: 0}, findings: [], questions: [], native: null, attestation: null, usage: unknown};
  const plan = control.plan === null ? null : await store.get({...control.plan, kind: "plan"});
  const report: QaReport | null = control.report === null ? null : await store.get({...control.report, kind: "report"});
  const attempt = control.attempt === null ? null : await store.get({...control.attempt, kind: "attempt"});
  const attestation = control.attestation === null ? null : await store.get({...control.attestation, kind: "attestation"});
  const decisions = await Promise.all((control.decisions ?? []).map(ref => store.get({...ref, kind: "decision"})));
  const proof = attestation?.version ?? report?.version ?? null;
  const results = {PASS: 0, FAIL: 0, UNKNOWN: 0};
  for (const r of report?.results ?? []) results[r.status]++;
  return {taskId, state: control.state, stale: version === undefined || proof === null ? null : !qaVersionMatches(proof, version),
    generation: control.generation, continuation: control.continuation,
    writer: control.owner === null ? null : {host: control.owner.session.host, sessionId: control.owner.session.sessionId, processId: control.owner.processId},
    plan: plan === null ? null : {digest: control.plan!.digest, timing: plan.timing, scope: plan.scope, cases: plan.cases.length,
      host: plan.session.host, fallbackReason: plan.session.fallbackReason},
    results, findings: (report?.findings ?? []).map(f => ({id: f.id, caseId: f.caseId, blocking: f.blocking})),
    questions: [...(plan?.questions ?? []), ...(report?.questions ?? [])].map(q => ({id: q.id, prompt: q.prompt, required: q.required,
      answered: decisions.some(d => d.questionId === q.id && d.plan.digest === control.plan?.digest)})),
    native: control.native === undefined ? null : {reason: control.native.reason, resetAt: control.native.resetAt},
    attestation: control.attestation?.digest ?? null,
    usage: Object.fromEntries((Object.keys(unknown) as (keyof QaUsage)[]).map(k => [k, attempt?.usage[k] ?? "UNKNOWN"])) as QaShow["usage"]};
}
