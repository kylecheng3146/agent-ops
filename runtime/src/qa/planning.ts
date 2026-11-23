import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { AcceptanceRunner, AgentTask, ReviewTargetId } from "../contracts.js";
import { canonicalJson } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { removeTemporary } from "../fs/temporary.js";
import { redactSecrets } from "../security/redact.js";
import { writePrivateFile } from "../security/permissions.js";
import { acceptanceError } from "../schema/acceptance.js";
import { SCENARIO_DIMENSIONS } from "../surface/schema.js";
import { runVerificationCommand, type VerificationProcessRunner } from "../verify/spawn.js";
import type { CriteriaReviewView } from "../review/criteria.js";
import { isolatedReviewEnvironment } from "../review/execute.js";
import { answeredNothing, deniedToolsOf, extractReviewObject } from "../review/extract.js";
import { buildTargetInvocation } from "../review/invocation.js";
import { extractUsage } from "../review/usage.js";
import { claimQaControl, cloneQaCheckout, qaSession, registerQaProcess, releaseQaControl, selectQaHost, type QaProcessProbe } from "./session.js";
import type { FileQaStore } from "./store.js";
import type { QaCase, QaEnvironment, QaPlan, QaReference, QaState, QaUsage, QaVersion } from "./types.js";
import { parseQaArtifact } from "./validate.js";
import { qaHistory } from "./decisions.js";

const text = {type: "string", minLength: 1, maxLength: 4096};
const strings = {type: "array", items: text};
const id = {type: "string", minLength: 1, maxLength: 128};
const scenario = {type: "object", additionalProperties: false, properties: {applies: {type: "boolean"}, behavior: text, na: text}};
/** What the read-only planner may answer. Versions, sessions and provenance are controller-owned, never model-supplied. */
export const QA_PLAN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["cases", "scenarios", "environment", "questions"],
  properties: {
    cases: {type: "array", minItems: 1, maxItems: 64, items: {type: "object", additionalProperties: false,
      required: ["id", "criterionIds", "surfaceIds", "required", "mode", "preconditions", "actions", "expected", "bindings"],
      properties: {id, criterionIds: strings, surfaceIds: strings, required: {type: "boolean"},
        mode: {type: "string", enum: ["behavioral", "invariant", "nonmechanical"]}, preconditions: strings, actions: strings, expected: text,
        nonmechanicalReason: text, bindings: {type: "array", items: {type: "object", additionalProperties: false, required: ["runnerId", "checkIds", "materials"],
          properties: {runnerId: id, checkIds: strings, redCheckIds: strings, materials: {type: "array", items: {type: "object", additionalProperties: false,
            required: ["path", "role"], properties: {path: text, role: {type: "string", enum: ["test", "fixture", "helper"]}}}}}}}}}},
    scenarios: {type: "object", additionalProperties: false, required: [...SCENARIO_DIMENSIONS],
      properties: Object.fromEntries(SCENARIO_DIMENSIONS.map(k => [k, scenario]))},
    environment: {type: "array", maxItems: 64, items: {type: "object", additionalProperties: false, required: ["name", "required", "status", "evidence"],
      properties: {name: text, required: {type: "boolean"}, status: {type: "string", enum: ["available", "missing", "unknown"]}, evidence: strings}}},
    questions: {type: "array", maxItems: 32, items: {type: "object", additionalProperties: false, required: ["id", "prompt", "required", "criterionIds"],
      properties: {id, prompt: text, required: {type: "boolean"}, criterionIds: strings}}}
  }
};

function planningSchema(options: QaPlanningOptions): Record<string, unknown> {
  const properties = QA_PLAN_SCHEMA.properties;
  const criterionIds = {type: "array", items: {...text, enum: [...new Set(options.tasks.flatMap(t => t.criteria.map(c => c.id)))]}};
  const surfaceIds = options.surfaceIds === undefined ? strings : {type: "array",
    items: options.surfaceIds.length === 0 ? false : {...text, enum: [...options.surfaceIds]}};
  return {...QA_PLAN_SCHEMA, properties: {...properties,
    cases: {...properties.cases, items: {...properties.cases.items, properties: {...properties.cases.items.properties, criterionIds, surfaceIds}}},
    questions: {...properties.questions, items: {...properties.questions.items, properties: {...properties.questions.items.properties, criterionIds}}}}};
}

export interface QaPlanningOptions {
  readonly store: FileQaStore;
  /** The delivery checkout; only its committed candidate is cloned for the planner. */
  readonly root: string;
  readonly version: QaVersion;
  readonly originalGoal: string;
  /** The integrated delivery: the root first, then any scoped children it includes. */
  readonly tasks: readonly AgentTask[];
  readonly dependencyTaskIds?: readonly string[];
  readonly scope: "full" | "partial";
  readonly timing: "early" | "late";
  /** Surface ids cases may name; omitted means the task surface is not available to check. */
  readonly surfaceIds?: readonly string[];
  /** Configured acceptance runners the repository trust record authorizes; nothing else may be bound. */
  readonly runners: readonly AcceptanceRunner[];
  /** Immutable task baseline red checks run against, so behavior it already has is planned invariant. */
  readonly baselineCommit?: string;
  readonly advisory: CriteriaReviewView | null;
  readonly available: readonly ReviewTargetId[];
  readonly implementationHost: ReviewTargetId | null;
  readonly implementationSessionId: string;
  readonly controllerId: string;
  readonly explicit?: boolean;
  readonly model?: string;
  readonly effort?: string;
  readonly runner?: VerificationProcessRunner;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
  readonly probe?: QaProcessProbe;
}
export interface QaPlanningResult {
  readonly state: Extract<QaState, "plan-ready" | "awaiting-input" | "blocked">;
  readonly plan: QaReference;
  readonly blockers: readonly string[];
  readonly usage: QaUsage;
}

function redacted(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redacted);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redacted(v)]));
  return value;
}
export function qaPlanningPrompt(snapshot: Record<string, unknown>, schema: Record<string, unknown> = QA_PLAN_SCHEMA): string {
  return ["You are an independent QA planner. You did not write this change and share no conversation with its developer.",
    "The working directory is a read-only clone of the exact candidate commit. Inspect code, tests and configuration as needed; do not modify files or run anything that writes.",
    "Plan acceptance testing of the user-visible tasks in originalGoal within the scoped tasks: map every criterion to at least one case and name the surface ids it exercises.",
    "Cover the happy path and, where the risk warrants it, negative, boundary, retry/concurrency and recovery cases. Answer each of the five scenarios as applies with behavior, or na with a reason; they are not exhaustive.",
    "Bind mechanical cases only to the listed runner ids and the checks/material files QA will add; you cannot choose commands. Use mode nonmechanical with a reason only for requirements that cannot be executed, never for a reproducible bug.",
    "Ids are lowercase kebab-case. Every binding names at least one material file. A behavioral case lists in redCheckIds at least one of its checkIds that must fail by assertion on the baseline; an invariant case has no redCheckIds; a nonmechanical case has no bindings and a nonmechanicalReason. A scenario is either {\"applies\":true,\"behavior\":...} or {\"na\":...}.",
    "Your clone holds the candidate and its history; baselineCommit in DATA, when present, is that immutable baseline (inspect it with git show <baselineCommit>:<path>). Behavior the baseline already has is an invariant case, never behavioral: its checks cannot fail there.",
    "When DATA.baselineCommit is supplied, the controller uses it for EVERY QA case. An individual criterion acceptance.baselineCommit belongs to separate task verification and cannot override QA's baseline. Do not copy that criterion's redCheckIds blindly: inspect the QA baseline for each exact assertion. An invariant needs PASS on both sides; a baseline assertion failure needs a behavioral case with a genuinely red designated check. The task verifier separately proves its own pinned baseline.",
    "List every environment a necessary case needs and whether you observed it available, missing or unknown. Do not list the test material QA will add or the isolated writable checkout the controller provides for authoring: they are not environment. Ask a question only for a genuine requirement, scope or authority decision; never answer one yourself.",
    "Controller-provided execution primitives are not planner environment: the disposable acceptance checkout, subprocess/process launch, loopback bind, ephemeral ports, OS temp/profile directories, and CDP transport used by a bound runner are case preconditions/material requirements. Bind these to the authorized runner/material and let trusted controller execution prove them as PASS or UNKNOWN; do not demand a writable probe in read-only planning. Keep genuine external requirements (including an unobserved or missing installed browser) as required environment blockers.",
    "The advisory in DATA is an earlier data-only criteria review. Consume it as input; it is not executed QA. A plan is not proof: include no verdict.",
    "Use only criterionIds and surfaceIds allowed by the schema. Historical reports and human decisions in DATA retain their exact old versions and references; they are not current proof or answers to a new plan. Inspect prior baseline observations before deciding which checks can be behavioral.",
    "Return only JSON matching this schema.", JSON.stringify(schema),
    "BEGIN UNTRUSTED DATA", canonicalJson(redacted(snapshot)), "END UNTRUSTED DATA"].join("\n");
}

/**
 * Shapes a live planner returns that have exactly one stricter meaning: a scenario {applies:false, na} is {na}, and an
 * "invariant" case that designates red checks is behavioral (its red checks must fail on the baseline, never weaker).
 */
function normalizePlanAnswer(answer: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (answer === undefined) return answer;
  if (Object.keys(answer).some(key => !Object.hasOwn(QA_PLAN_SCHEMA.properties, key)))
    planError("The QA planner returned fields outside its response schema; the plan is not used.");
  const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const scenarios = object(answer.scenarios) ? Object.fromEntries(Object.entries(answer.scenarios).map(([k, s]) =>
    [k, object(s) && s.applies === false && Object.keys(s).length === 2 && "na" in s ? {na: s.na} : s])) : answer.scenarios;
  const cases = Array.isArray(answer.cases) ? answer.cases.map(c => object(c) && c.mode === "invariant" && Array.isArray(c.bindings) &&
    c.bindings.some(b => object(b) && Array.isArray(b.redCheckIds) && b.redCheckIds.length > 0) ? {...c, mode: "behavioral"} : c) : answer.cases;
  return {cases, scenarios, environment: answer.environment, questions: answer.questions};
}
/** The first case rule a rejected plan breaks, so the operator sees why it was not used. */
function caseRuleError(answer: Record<string, unknown> | undefined, baselineCommit: string): string {
  for (const c of Array.isArray(answer?.cases) ? answer.cases as Record<string, unknown>[] : []) {
    const error = acceptanceError({mode: c?.mode === "nonmechanical" ? "review-only" : c?.mode, baselineCommit, bindings: c?.bindings,
      ...(c?.nonmechanicalReason === undefined ? {} : {reviewOnlyReason: c.nonmechanicalReason})});
    if (error !== undefined) return ` Case ${String(c?.id).slice(0, 128)}: ${error}`;
  }
  return "";
}
function planError(message: string): never {throw new AgentOpsError("QA_PLAN_INVALID", message);}
/** Controller checks the model cannot satisfy by assertion: requirement mapping, surfaces and runner authority. */
function derive(options: QaPlanningOptions, cases: readonly QaCase[], environment: readonly QaEnvironment[]): QaEnvironment[] {
  const criteria = new Set(options.tasks.flatMap(task => task.criteria.map(c => c.id)));
  for (const c of cases) {
    if (c.criterionIds.some(id => !criteria.has(id))) planError(`Case ${c.id} names a criterion outside the scoped tasks.`);
    if (options.surfaceIds !== undefined && c.surfaceIds.some(id => !options.surfaceIds!.includes(id))) planError(`Case ${c.id} names an unknown surface.`);
    if (c.mode !== "nonmechanical" && c.bindings.length === 0) planError(`Mechanical case ${c.id} has no runner binding.`);
  }
  const unmapped = [...criteria].filter(id => !cases.some(c => c.criterionIds.includes(id)));
  if (unmapped.length > 0) planError(`The plan leaves criteria without a case: ${unmapped.join(", ")}.`);
  const authorized = new Set(options.runners.map(r => r.id)), derived: QaEnvironment[] = [];
  for (const runnerId of [...new Set(cases.flatMap(c => c.bindings.map(b => b.runnerId)))].sort())
    derived.push({name: `runner:${runnerId}`, required: cases.some(c => c.required && c.bindings.some(b => b.runnerId === runnerId)),
      status: authorized.has(runnerId) ? "available" : "missing",
      evidence: [authorized.has(runnerId) ? "Configured acceptance runner authorized by the repository trust record."
        : "Not an authorized configured acceptance runner; QA cannot choose commands."]});
  return [...environment.filter(e => !derived.some(d => d.name === e.name)), ...derived];
}
function usageOf(target: ReviewTargetId, stdout: string, stderr: string): QaUsage {
  const u = extractUsage(target, stdout, stderr);
  return {inputTokens: u?.inputTokens ?? null, outputTokens: u?.outputTokens ?? null, totalTokens: u?.totalTokens ?? null, costUsd: u?.costUsd ?? null};
}

/**
 * Independent read-only planning after the data-only criteria advisory. The result is a stored plan
 * and a control state; it never becomes an attestation, so it cannot be mistaken for executed proof.
 */
export async function runQaPlanning(options: QaPlanningOptions): Promise<QaPlanningResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const taskId = options.version.taskId;
  if (options.tasks[0]?.id !== taskId) throw new AgentOpsError("QA_PLAN_INVALID", "The plan must bind the delivery root it versions.");
  const choice = selectQaHost({implementationHost: options.implementationHost, available: options.available, writable: false});
  const session = qaSession(choice, {sessionId: randomUUID(), implementationSessionId: options.implementationSessionId,
    implementationHost: options.implementationHost, writable: false});
  const claimed = await claimQaControl(options.store, {taskId, controllerId: options.controllerId, session, state: "planning",
    explicit: options.explicit, now: now(), ...(options.probe === undefined ? {} : {probe: options.probe})});
  // ponytail: the read-only planner runs inside this controller, so the controller is the owner whose death is checked.
  const held = await registerQaProcess(options.store, claimed, process.pid, now(), options.probe).catch(async error => {
    await releaseQaControl(options.store, claimed, {state: "blocked"}, now()).catch(() => undefined);
    throw error;
  });
  let usage: QaUsage = {inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null};
  let directory: string | undefined, released = false;
  let diagnostic: {stdout: string; stderr: string; failureClass: string} | undefined;
  try {
    const advisoryReferences = [];
    if (options.advisory !== null) {
      const path = relative(options.root, options.advisory.reportPath).split(sep).join("/");
      advisoryReferences.push({path, digest: sha256(await readFile(options.advisory.reportPath))});
    }
    const snapshot = {originalGoal: options.originalGoal, scope: options.scope, timing: options.timing,
      tasks: options.tasks.map(t => ({id: t.id, title: t.title, intent: t.intent ?? null, criteria: t.criteria, surface: t.surface ?? null})),
      dependencyTaskIds: options.dependencyTaskIds ?? [], surfaceIds: options.surfaceIds ?? null,
      runners: options.runners.map(r => ({id: r.id, adapter: r.adapter})),
      history: await qaHistory(options.store, held, options.version),
      ...(options.baselineCommit === undefined ? {} : {baselineCommit: options.baselineCommit}),
      advisory: options.advisory === null ? {unavailable: "No criteria advisory was available; plan from the requirements alone."}
        : {status: options.advisory.report.status, stale: options.advisory.stale, advice: options.advisory.report.advice ?? null}};
    const schema = planningSchema(options);
    if (canonicalJson(schema) !== canonicalJson(redacted(schema)))
      throw new AgentOpsError("QA_PLAN_INPUT_INVALID", "QA planner IDs must not contain secret-shaped values.");
    let prompt = qaPlanningPrompt(snapshot, schema);
    directory = await mkdtemp(join(tmpdir(), "agent-ops-qa-plan-"));
    const repository = join(directory, "repository");
    if (session.host === "agy") prompt = [
      `Repository root: ${repository}`,
      "Run every repository-relative inspection in that directory. For terminal commands, use only git status, git diff, git log, or git show; read specific files with file-reading tools instead of ls, find, cat, rg, or git ls-tree.",
      "Return the requested QA plan JSON, not an implementation plan. Do not create or edit files or ask the user to proceed.",
      prompt
    ].join("\n");
    if (Buffer.byteLength(prompt) > 256 * 1024) throw new AgentOpsError("QA_PLAN_INPUT_TOO_LARGE", "QA planning input exceeds 256 KiB.");
    await cloneQaCheckout(options.root, repository, options.version.candidateCommit);
    const invocation = buildTargetInvocation({target: session.host, prompt, responseSchema: schema, repositoryRoot: repository,
      ...(options.model === undefined ? {} : {model: options.model}), ...(options.effort === undefined ? {} : {effort: options.effort})});
    if (invocation === undefined) throw new AgentOpsError("QA_HOST_UNAVAILABLE", "The QA planner has no read-only invocation.");
    const result = await runVerificationCommand({id: "qa-plan", command: invocation.command, args: [...invocation.args], cwd: ".",
      required: false, evidence: {kind: "exit-code"}}, {cwd: repository, timeoutMs: null, stdin: invocation.stdin, replaceEnv: true,
      env: isolatedReviewEnvironment(session.host, directory, process.env),
      ...(options.runner === undefined ? {} : {runner: options.runner}), ...(options.signal === undefined ? {} : {signal: options.signal})});
    usage = usageOf(session.host, result.stdout, result.stderr);
    diagnostic = {stdout: Buffer.from(redactSecrets(result.stdout)).subarray(0, 32768).toString("utf8"),
      stderr: Buffer.from(redactSecrets(result.stderr)).subarray(0, 32768).toString("utf8"), failureClass: result.failureClass};
    if (result.failureClass === "aborted") throw new AgentOpsError("QA_PLAN_CANCELLED", "QA planning was cancelled; no plan was saved.");
    const denied = deniedToolsOf(session.host, result.stdout);
    if (denied.length > 0) throw new AgentOpsError("QA_NATIVE_DENIED",
      `The native host denied QA planning tools (${redactSecrets(denied.join(", ")).slice(0, 512)}); automatic continuation is disabled.`);
    if (result.status !== "PASS" || result.stdoutTruncated)
      throw new AgentOpsError("QA_PLAN_NOT_RUN", `The QA planner did not answer (${result.failureClass}); QA stays unverified.`);
    if (answeredNothing(session.host, result.stdout)) throw new AgentOpsError("QA_PLAN_NOT_RUN", "The QA planner ended its turn without answering; QA stays unverified.");
    const answer = normalizePlanAnswer(extractReviewObject(session.host, result.stdout));
    let plan: QaPlan;
    try {
      plan = parseQaArtifact("plan", {schemaVersion: 1, id: `plan-${held.generation}`, version: options.version, originalGoal: options.originalGoal,
        taskIds: options.tasks.map(t => t.id), dependencyTaskIds: [...(options.dependencyTaskIds ?? [])], scope: options.scope, session,
        createdAt: now(), timing: options.timing, advisoryReferences, ...answer});
    } catch {return planError(`The QA planner returned an invalid plan; it is not used.${caseRuleError(answer, options.version.candidateCommit)}`);}
    const environment = derive(options, plan.cases, plan.environment);
    const criteria = new Set(options.tasks.flatMap(t => t.criteria.map(c => c.id)));
    if (plan.questions.some(q => q.criterionIds.some(id => !criteria.has(id)))) planError("A question names a criterion outside the scoped tasks.");
    const ref = await options.store.put("plan", {...plan, environment});
    const blockers = environment.filter(e => e.required && e.status !== "available").map(e => `${e.name}: ${e.status}`);
    const state = blockers.length > 0 ? "blocked" : plan.questions.some(q => q.required) ? "awaiting-input" : "plan-ready";
    released = true;
    await releaseQaControl(options.store, held, {state, plan: ref}, now());
    return {state, plan: ref, blockers, usage};
  } catch (error) {
    if (!released) await releaseQaControl(options.store, held, {state: "blocked",
      ...(error instanceof AgentOpsError && error.code === "QA_NATIVE_DENIED" ? {continuation: false, plan: null} : {})}, now()).catch(() => undefined);
    if (diagnostic !== undefined) await writePrivateFile(join(options.store.directory, "planning-diagnostics", `${session.sessionId}.json`),
      `${canonicalJson({schemaVersion: 1, version: options.version, session, usage, observedAt: now(), ...diagnostic,
        error: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 4096)})}\n`, options.store.commonDir).catch(() => {
        throw new AgentOpsError("QA_PLAN_DIAGNOSTIC_FAILED", "QA planning failed and its rejected output could not be saved privately.", {cause: error});
      });
    throw error;
  } finally {
    // Rejected answers are saved privately before removing the read-only clone.
    if (directory !== undefined) await removeTemporary(directory);
  }
}
