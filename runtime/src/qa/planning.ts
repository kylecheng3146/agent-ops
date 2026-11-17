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
import { SCENARIO_DIMENSIONS } from "../surface/schema.js";
import { runVerificationCommand, type VerificationProcessRunner } from "../verify/spawn.js";
import type { CriteriaReviewView } from "../review/criteria.js";
import { isolatedReviewEnvironment } from "../review/execute.js";
import { extractReviewObject } from "../review/extract.js";
import { buildTargetInvocation } from "../review/invocation.js";
import { extractUsage } from "../review/usage.js";
import { claimQaControl, cloneQaCheckout, qaSession, registerQaProcess, releaseQaControl, selectQaHost, type QaProcessProbe } from "./session.js";
import type { FileQaStore } from "./store.js";
import type { QaCase, QaEnvironment, QaPlan, QaReference, QaState, QaUsage, QaVersion } from "./types.js";
import { parseQaArtifact } from "./validate.js";

const text = {type: "string", minLength: 1, maxLength: 4096};
const strings = {type: "array", items: text};
const id = {type: "string", minLength: 1, maxLength: 128};
const scenario = {type: "object", additionalProperties: false, properties: {applies: {type: "boolean"}, behavior: text, na: text}};
/** What the read-only planner may answer. Versions, sessions and provenance are controller-owned, never model-supplied. */
export const QA_PLAN_SCHEMA: Record<string, unknown> = {
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
export function qaPlanningPrompt(snapshot: Record<string, unknown>): string {
  return ["You are an independent QA planner. You did not write this change and share no conversation with its developer.",
    "The working directory is a read-only clone of the exact candidate commit. Inspect code, tests and configuration as needed; do not modify files or run anything that writes.",
    "Plan acceptance testing of the user-visible tasks in originalGoal within the scoped tasks: map every criterion to at least one case and name the surface ids it exercises.",
    "Cover the happy path and, where the risk warrants it, negative, boundary, retry/concurrency and recovery cases. Answer each of the five scenarios as applies with behavior, or na with a reason; they are not exhaustive.",
    "Bind mechanical cases only to the listed runner ids and the checks/material files QA will add; you cannot choose commands. Use mode nonmechanical with a reason only for requirements that cannot be executed, never for a reproducible bug.",
    "Ids are lowercase kebab-case. Every binding names at least one material file. A behavioral case lists in redCheckIds at least one of its checkIds that must fail by assertion on the baseline; an invariant case has no redCheckIds; a nonmechanical case has no bindings and a nonmechanicalReason. A scenario is either {\"applies\":true,\"behavior\":...} or {\"na\":...}.",
    "List every environment a necessary case needs and whether you observed it available, missing or unknown. Do not list the test material QA will add or the isolated writable checkout the controller provides for authoring: they are not environment. Ask a question only for a genuine requirement, scope or authority decision; never answer one yourself.",
    "The advisory in DATA is an earlier data-only criteria review. Consume it as input; it is not executed QA. A plan is not proof: include no verdict.",
    "Return only JSON matching this schema.", JSON.stringify(QA_PLAN_SCHEMA),
    "BEGIN UNTRUSTED DATA", canonicalJson(redacted(snapshot)), "END UNTRUSTED DATA"].join("\n");
}

/** The schema admits {applies:false, na}; it means exactly {na}, the stored shape. Anything else is left for validation. */
function notApplicable(answer: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const scenarios = answer?.scenarios;
  if (typeof scenarios !== "object" || scenarios === null || Array.isArray(scenarios)) return answer;
  return {...answer, scenarios: Object.fromEntries(Object.entries(scenarios).map(([k, s]) => {
    const v = s as Record<string, unknown>;
    return [k, typeof v === "object" && v !== null && v.applies === false && Object.keys(v).length === 2 && "na" in v ? {na: v.na} : s];
  }))};
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
      advisory: options.advisory === null ? {unavailable: "No criteria advisory was available; plan from the requirements alone."}
        : {status: options.advisory.report.status, stale: options.advisory.stale, advice: options.advisory.report.advice ?? null}};
    const prompt = qaPlanningPrompt(snapshot);
    if (Buffer.byteLength(prompt) > 256 * 1024) throw new AgentOpsError("QA_PLAN_INPUT_TOO_LARGE", "QA planning input exceeds 256 KiB.");
    directory = await mkdtemp(join(tmpdir(), "agent-ops-qa-plan-"));
    const repository = join(directory, "repository");
    await cloneQaCheckout(options.root, repository, options.version.candidateCommit);
    const invocation = buildTargetInvocation({target: session.host, prompt, responseSchema: QA_PLAN_SCHEMA, repositoryRoot: repository,
      ...(options.model === undefined ? {} : {model: options.model}), ...(options.effort === undefined ? {} : {effort: options.effort})});
    if (invocation === undefined) throw new AgentOpsError("QA_HOST_UNAVAILABLE", "The QA planner has no read-only invocation.");
    const result = await runVerificationCommand({id: "qa-plan", command: invocation.command, args: [...invocation.args], cwd: ".",
      required: false, evidence: {kind: "exit-code"}}, {cwd: repository, timeoutMs: null, stdin: invocation.stdin, replaceEnv: true,
      env: isolatedReviewEnvironment(session.host, directory, process.env),
      ...(options.runner === undefined ? {} : {runner: options.runner}), ...(options.signal === undefined ? {} : {signal: options.signal})});
    usage = usageOf(session.host, result.stdout, result.stderr);
    if (result.failureClass === "aborted") throw new AgentOpsError("QA_PLAN_CANCELLED", "QA planning was cancelled; no plan was saved.");
    if (result.status !== "PASS" || result.stdoutTruncated)
      throw new AgentOpsError("QA_PLAN_NOT_RUN", `The QA planner did not answer (${result.failureClass}); QA stays unverified.`);
    const answer = notApplicable(extractReviewObject(session.host, result.stdout));
    let plan: QaPlan;
    try {
      plan = parseQaArtifact("plan", {schemaVersion: 1, id: `plan-${held.generation}`, version: options.version, originalGoal: options.originalGoal,
        taskIds: options.tasks.map(t => t.id), dependencyTaskIds: [...(options.dependencyTaskIds ?? [])], scope: options.scope, session,
        createdAt: now(), timing: options.timing, advisoryReferences, ...answer});
    } catch {return planError("The QA planner returned an invalid plan; it is not used.");}
    const environment = derive(options, plan.cases, plan.environment);
    const ref = await options.store.put("plan", {...plan, environment});
    const blockers = environment.filter(e => e.required && e.status !== "available").map(e => `${e.name}: ${e.status}`);
    const state = blockers.length > 0 ? "blocked" : plan.questions.some(q => q.required) ? "awaiting-input" : "plan-ready";
    released = true;
    await releaseQaControl(options.store, held, {state, plan: ref}, now());
    return {state, plan: ref, blockers, usage};
  } catch (error) {
    if (!released) await releaseQaControl(options.store, held, {state: "blocked"}, now()).catch(() => undefined);
    throw error;
  } finally {
    // The planner clone is read-only input; nothing in it is diagnostic of a failure.
    if (directory !== undefined) await removeTemporary(directory);
  }
}
