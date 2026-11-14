import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import type { ReviewTargetId } from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";
import { ClaudeGoalHost } from "../run/hosts/claude.js";
import { CodexGoalHost } from "../run/hosts/codex.js";
import type { NativeGoalEvent, NativeGoalHandle, NativeGoalHost, NativeGoalStartInput } from "../run/hosts/types.js";
import { nativeProviderLimit } from "../run/provider-wait.js";
import type { NativeHostKind } from "../run/types.js";
import { extractUsage } from "../review/usage.js";
import { inspectQaMaterials, type QaInspectedMaterials } from "./materials.js";
import { claimQaControl, cloneQaCheckout, qaOwnerStatus, qaSession, registerQaProcess, releaseQaControl, selectQaHost,
  type QaProcessProbe } from "./session.js";
import type { FileQaStore } from "./store.js";
import type { QaAuthorResponse, QaControl, QaNativeSession, QaReference, QaSession, QaUsage, QaVersion } from "./types.js";
import { parseQaAuthorResponse } from "./validate.js";

/** Relative to the QA checkout; `.agent-ops` can never be material, so the answer is never imported. */
export const QA_RESPONSE_PATH = ".agent-ops/qa-author-response.json";
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * The production writable QA host: the same native transport as run workers, with its default
 * permission mode and sandbox. Command and argv are never taken from task or QA data.
 */
export function qaAuthorHost(kind: NativeHostKind, spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcessWithoutNullStreams): NativeGoalHost {
  const options = spawn === undefined ? {} : {spawn};
  return kind === "claude" ? new ClaudeGoalHost(options) : new CodexGoalHost(options);
}

export function qaAuthorObjective(input: {readonly taskId: string; readonly generation: number; readonly plan: QaReference;
  readonly candidateCommit: string}): string {
  return ["You are an independent QA author in a fresh session, working in an isolated clone of the candidate. You share nothing with its developer.",
    `Write tests, fixtures, helpers or reproduction material for QA plan ${input.plan.digest} of task ${input.taskId}, as NEW files under test locations only.`,
    "Never edit, delete or rename an existing file, never commit, never install dependencies or change configuration, policy, trust or settings, and never weaken an assertion.",
    "If QA needs an existing file changed, list it in requestedEdits with the reason; the developer decides. Do not try to make anything pass.",
    `When done, write ${QA_RESPONSE_PATH} as JSON: {"schemaVersion":1,"generation":${input.generation},"plan":"${input.plan.digest}",` +
      `"candidateCommit":"${input.candidateCommit}","materials":[{"path","role":"test|fixture|helper","caseIds":[...]}],` +
      `"requestedEdits":[{"path","reason"}],"observations":[{"caseId","notes":[...]}],"questions":[{"id","prompt","required","criterionIds":[...]}]}.`,
    "Your report is data for the controller, not a verdict: only controller-run checks on the final candidate can pass QA."].join("\n");
}

export interface QaAuthorOptions {
  readonly store: FileQaStore;
  readonly root: string;
  readonly version: QaVersion;
  readonly plan: QaReference;
  /** A new directory for this generation's isolated clone; preserved after any failure. */
  readonly checkout: string;
  readonly available: readonly ReviewTargetId[];
  readonly implementationHost: ReviewTargetId | null;
  readonly implementationSessionId: string;
  readonly controllerId: string;
  readonly host: (kind: NativeHostKind) => NativeGoalHost;
  readonly explicit?: boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
  readonly probe?: QaProcessProbe;
}
export interface QaAuthorResult {
  readonly control: QaControl;
  readonly session: QaSession;
  readonly response: QaAuthorResponse;
  readonly inspected: QaInspectedMaterials;
  readonly usage: QaUsage;
  readonly checkout: string;
}

async function readResponse(checkout: string): Promise<unknown> {
  const path = join(checkout, ...QA_RESPONSE_PATH.split("/"));
  const status = await lstat(path).catch(() => null);
  if (status === null || !status.isFile() || status.size > MAX_RESPONSE_BYTES)
    throw new AgentOpsError("QA_RESPONSE_INVALID", "The QA author left no bounded regular response file.", {recoveryPaths: [checkout]});
  try {return JSON.parse(await readFile(path, "utf8"));}
  catch (cause) {throw new AgentOpsError("QA_RESPONSE_INVALID", "The QA author response is not JSON.", {cause, recoveryPaths: [checkout]});}
}

/** What one native event means to the QA controller. Model prose is never consulted. */
export type QaHostSignal = "observe" | "stale" | "provider-limit" | "denied" | "completed" | "failed" | "closed";
/**
 * Events strictly before a resume belong to the paused turn and are ignored. A provider limit is
 * transient and resumable; an explicit native permission or organization denial is permanent for
 * automation and needs an explicit user command.
 */
export function classifyQaHostEvent(event: NativeGoalEvent, resumedAt: string | null = null): QaHostSignal {
  if (resumedAt !== null && Date.parse(event.at) < Date.parse(resumedAt)) return "stale";
  const payload = event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload : {};
  const review = payload.review !== null && typeof payload.review === "object" && !Array.isArray(payload.review) ? payload.review : {};
  if ((event.host === "claude" && Array.isArray(payload.permission_denials) && payload.permission_denials.length > 0) ||
    (event.host === "codex" && event.transportMethod === "item/autoApprovalReview/completed" && review.status === "denied")) return "denied";
  if (event.nativeStatus === "usageLimited" || nativeProviderLimit(event.payload) !== null) return "provider-limit";
  return event.type === "completed" ? "completed" : event.type === "error" ? "failed" : event.type === "closed" ? "closed" : "observe";
}

interface QaDrive {
  readonly options: Pick<QaAuthorOptions, "store" | "version" | "plan" | "signal" | "probe">;
  readonly kind: NativeHostKind;
  readonly host: NativeGoalHost;
  readonly session: QaSession;
  readonly held: QaControl;
  readonly checkout: string;
  readonly now: () => string;
  /** Start a fresh session, or resume the paused native one with its pre-resume notifications ignored. */
  readonly open: (input: NativeGoalStartInput) => Promise<NativeGoalHandle>;
  readonly resumedAt: string | null;
}

async function drive(d: QaDrive): Promise<QaAuthorResult> {
  const {options, kind, host, session, checkout, now} = d;
  const taskId = options.version.taskId;
  let held = d.held;
  const recovery = {recoveryPaths: [checkout]};
  let handle: NativeGoalHandle | undefined;
  let usage: QaUsage = {inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null};
  let paused: QaNativeSession["reason"] | null = null, resetAt: string | null = null;
  const context = {runId: `qa-${taskId}`, workerId: `qa-${session.sessionId}`, generation: held.generation, contractHash: options.version.taskContractHash};
  try {
    handle = await d.open({...context, cwd: checkout, sessionId: kind === "claude" ? session.sessionId : randomUUID(),
      ...(d.resumedAt === null ? {} : {manualResumeAt: d.resumedAt}),
      env: {AGENT_OPS_HOST: kind, AGENT_OPS_SESSION_ID: session.sessionId, AGENT_OPS_QA_TASK_ID: taskId, AGENT_OPS_QA_GENERATION: String(held.generation),
        AGENT_OPS_RUN_ID: undefined, AGENT_OPS_WORKER_ID: undefined, AGENT_OPS_WORKER_GENERATION: undefined, AGENT_OPS_AGENT_ID: undefined, CODEX_THREAD_ID: undefined},
      registerProcess: async pid => {held = await registerQaProcess(options.store, held, pid, now(), options.probe);}});
    if (held.owner?.processId == null) throw new AgentOpsError("QA_PROCESS_IDENTITY_REQUIRED", "The QA author process was never registered.", recovery);
    const activation = await host.activate(handle, qaAuthorObjective({taskId, generation: held.generation, plan: options.plan,
      candidateCommit: options.version.candidateCommit}), context);
    // A resumed session continues only once it acknowledges this generation's active goal.
    if (!activation.accepted || (d.resumedAt !== null && activation.nativeStatus !== "active"))
      throw new AgentOpsError("QA_AUTHOR_NOT_ACTIVE", "The QA host did not acknowledge its active goal.", recovery);
    let outcome: "completed" | "failed" | "closed" = "closed";
    for await (const event of host.observe(handle, options.signal === undefined ? {} : {signal: options.signal})) {
      const signal = classifyQaHostEvent(event, d.resumedAt);
      if (signal === "stale") continue;
      // Native events are observations only (proof: false); usage stays UNKNOWN unless the host reports it.
      const reported = kind === "claude" ? extractUsage("claude", JSON.stringify(event.payload), "") : undefined;
      if (reported !== undefined) usage = {inputTokens: reported.inputTokens ?? null, outputTokens: reported.outputTokens ?? null,
        totalTokens: reported.totalTokens ?? null, costUsd: reported.costUsd ?? null};
      if (signal === "denied" || signal === "provider-limit") {
        paused = signal;
        resetAt = signal === "provider-limit" ? nativeProviderLimit(event.payload)?.resetAt ?? null : null;
        break;
      }
      if (signal === "completed") {outcome = "completed"; break;}
      if (signal === "failed") {outcome = "failed"; break;}
      if (signal === "closed") break;
    }
    if (options.signal?.aborted) throw new AgentOpsError("QA_AUTHOR_CANCELLED", "QA authoring was stopped; the checkout is preserved.", recovery);
    await host.stop(handle, context);
    // Output is accepted only from a writer whose death is confirmed.
    if (await qaOwnerStatus(held.owner!, options.probe) !== "dead")
      throw new AgentOpsError("QA_WRITER_STILL_ALIVE", "The QA author has not stopped; its output is not accepted.", recovery);
    if (paused !== null) {
      const native: QaNativeSession = {session, nativeSessionId: handle.threadId ?? handle.sessionId, checkout, reason: paused, resetAt, observedAt: now()};
      // A denial disables automatic continuation; a provider limit keeps it, without a blind retry before its reset.
      held = await releaseQaControl(options.store, held, {state: "blocked", native, ...(paused === "denied" ? {continuation: false} : {})}, now());
      throw paused === "denied"
        ? new AgentOpsError("QA_NATIVE_DENIED", "The native host or organization denied a QA action; only an explicit user command may resume it.", recovery)
        : new AgentOpsError("QA_PROVIDER_LIMIT", `The QA provider limit was reached${resetAt === null ? "" : ` until ${resetAt}`}; the paused session can resume.`, recovery);
    }
    if (outcome !== "completed") throw new AgentOpsError("QA_AUTHOR_FAILED", `The QA author ${outcome} before completing; nothing is imported.`, recovery);
    const response = parseQaAuthorResponse(await readResponse(checkout));
    if (response.generation !== held.generation || response.plan !== options.plan.digest)
      throw new AgentOpsError("QA_STALE_WRITER", "The QA response belongs to another generation or plan.", recovery);
    const inspected = await inspectQaMaterials(checkout, options.version.candidateCommit, response);
    const control = await releaseQaControl(options.store, held, {state: "testing"}, now());
    return {control, session, response, inspected, usage, checkout};
  } catch (error) {
    if (handle !== undefined) await host.stop(handle, context).catch(() => undefined);
    const dead = held.owner === null || held.owner.processId === null ? handle === undefined
      : await qaOwnerStatus(held.owner, options.probe) === "dead";
    // An unconfirmed death keeps the owner saved, so no other generation can take over.
    if (dead && held.owner !== null) await releaseQaControl(options.store, held, {state: "blocked"}, now()).catch(() => undefined);
    if (error instanceof AgentOpsError && error.recoveryPaths !== undefined) throw error;
    throw new AgentOpsError(error instanceof AgentOpsError ? error.code : "QA_AUTHOR_FAILED",
      error instanceof Error ? error.message : "QA authoring failed.", {cause: error, ...recovery});
  }
}

/**
 * Fresh writable QA authoring with owned lifecycle. The native session reuses the run transport's
 * process-group primitives without a nested run or RunState; QA control is the only lease.
 */
export async function runQaAuthor(options: QaAuthorOptions): Promise<QaAuthorResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const taskId = options.version.taskId;
  const choice = selectQaHost({implementationHost: options.implementationHost, available: options.available, writable: true});
  const kind = choice.host as NativeHostKind;
  const session = qaSession(choice, {sessionId: randomUUID(), implementationSessionId: options.implementationSessionId,
    implementationHost: options.implementationHost, writable: true});
  const held = await claimQaControl(options.store, {taskId, controllerId: options.controllerId, session, state: "testing",
    explicit: options.explicit, now: now(), ...(options.probe === undefined ? {} : {probe: options.probe})});
  const host = options.host(kind);
  try {await cloneQaCheckout(options.root, options.checkout, options.version.candidateCommit);}
  catch (error) {
    await releaseQaControl(options.store, held, {state: "blocked"}, now()).catch(() => undefined);
    throw error;
  }
  return await drive({options, kind, host, session, held, checkout: options.checkout, now, open: input => host.start(input), resumedAt: null});
}

export interface QaResumeOptions extends Pick<QaAuthorOptions, "store" | "version" | "plan" | "controllerId" | "host" | "signal" | "now" | "probe"> {
  /** A user command; automatic continuation waits for a known provider reset and never follows a denial. */
  readonly explicit?: boolean;
}
/**
 * Resume the paused native QA session in its preserved checkout. The previous writer's death is
 * confirmed by the claim; notifications from before this resume cannot complete or fail it.
 */
export async function resumeQaAuthor(options: QaResumeOptions): Promise<QaAuthorResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const taskId = options.version.taskId;
  const native = (await options.store.readControl(taskId))?.native;
  if (native === undefined) throw new AgentOpsError("QA_RESUME_UNAVAILABLE", "No paused native QA session is saved for this task.");
  if (options.explicit !== true && native.reason === "provider-limit" && (native.resetAt === null || Date.parse(now()) < Date.parse(native.resetAt)))
    throw new AgentOpsError("QA_PROVIDER_WAIT", "The provider limit has no known reset yet; no blind retry is made.");
  const held = await claimQaControl(options.store, {taskId, controllerId: options.controllerId, session: native.session, state: "testing",
    explicit: options.explicit, now: now(), ...(options.probe === undefined ? {} : {probe: options.probe})});
  const kind = native.session.host as NativeHostKind, host = options.host(kind), resumedAt = now();
  return await drive({options, kind, host, session: native.session, held, checkout: native.checkout, now,
    open: input => host.resume(input, native.nativeSessionId), resumedAt});
}
