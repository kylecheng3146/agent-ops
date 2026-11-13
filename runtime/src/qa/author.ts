import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import type { ReviewTargetId } from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";
import { ClaudeGoalHost } from "../run/hosts/claude.js";
import { CodexGoalHost } from "../run/hosts/codex.js";
import type { NativeGoalHandle, NativeGoalHost } from "../run/hosts/types.js";
import type { NativeHostKind } from "../run/types.js";
import { extractUsage } from "../review/usage.js";
import { inspectQaMaterials, type QaInspectedMaterials } from "./materials.js";
import { claimQaControl, cloneQaCheckout, qaOwnerStatus, qaSession, registerQaProcess, releaseQaControl, selectQaHost,
  type QaProcessProbe } from "./session.js";
import type { FileQaStore } from "./store.js";
import type { QaAuthorResponse, QaControl, QaReference, QaSession, QaUsage, QaVersion } from "./types.js";
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
  let held = await claimQaControl(options.store, {taskId, controllerId: options.controllerId, session, state: "testing",
    explicit: options.explicit, now: now(), ...(options.probe === undefined ? {} : {probe: options.probe})});
  const recovery = {recoveryPaths: [options.checkout]};
  const host = options.host(kind);
  let handle: NativeGoalHandle | undefined;
  let usage: QaUsage = {inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null};
  const context = {runId: `qa-${taskId}`, workerId: `qa-${session.sessionId}`, generation: held.generation, contractHash: options.version.taskContractHash};
  try {
    await cloneQaCheckout(options.root, options.checkout, options.version.candidateCommit);
    handle = await host.start({...context, cwd: options.checkout, sessionId: kind === "claude" ? session.sessionId : randomUUID(),
      env: {AGENT_OPS_HOST: kind, AGENT_OPS_SESSION_ID: session.sessionId, AGENT_OPS_QA_TASK_ID: taskId, AGENT_OPS_QA_GENERATION: String(held.generation),
        AGENT_OPS_RUN_ID: undefined, AGENT_OPS_WORKER_ID: undefined, AGENT_OPS_WORKER_GENERATION: undefined, AGENT_OPS_AGENT_ID: undefined, CODEX_THREAD_ID: undefined},
      registerProcess: async pid => {held = await registerQaProcess(options.store, held, pid, now(), options.probe);}});
    if (held.owner?.processId == null) throw new AgentOpsError("QA_PROCESS_IDENTITY_REQUIRED", "The QA author process was never registered.", recovery);
    const activation = await host.activate(handle, qaAuthorObjective({taskId, generation: held.generation, plan: options.plan,
      candidateCommit: options.version.candidateCommit}), context);
    if (!activation.accepted) throw new AgentOpsError("QA_AUTHOR_NOT_ACTIVE", "The QA host did not acknowledge its goal.", recovery);
    let outcome: "completed" | "failed" | "closed" = "closed";
    for await (const event of host.observe(handle, options.signal === undefined ? {} : {signal: options.signal})) {
      // Native events are observations only (proof: false); usage stays UNKNOWN unless the host reports it.
      const reported = kind === "claude" ? extractUsage("claude", JSON.stringify(event.payload), "") : undefined;
      if (reported !== undefined) usage = {inputTokens: reported.inputTokens ?? null, outputTokens: reported.outputTokens ?? null,
        totalTokens: reported.totalTokens ?? null, costUsd: reported.costUsd ?? null};
      if (event.type === "completed") {outcome = "completed"; break;}
      if (event.type === "error") {outcome = "failed"; break;}
      if (event.type === "closed") break;
    }
    if (options.signal?.aborted) throw new AgentOpsError("QA_AUTHOR_CANCELLED", "QA authoring was stopped; the checkout is preserved.", recovery);
    await host.stop(handle, context);
    // Output is accepted only from a writer whose death is confirmed.
    if (await qaOwnerStatus(held.owner!, options.probe) !== "dead")
      throw new AgentOpsError("QA_WRITER_STILL_ALIVE", "The QA author has not stopped; its output is not accepted.", recovery);
    if (outcome !== "completed") throw new AgentOpsError("QA_AUTHOR_FAILED", `The QA author ${outcome} before completing; nothing is imported.`, recovery);
    const response = parseQaAuthorResponse(await readResponse(options.checkout));
    if (response.generation !== held.generation || response.plan !== options.plan.digest)
      throw new AgentOpsError("QA_STALE_WRITER", "The QA response belongs to another generation or plan.", recovery);
    const inspected = await inspectQaMaterials(options.checkout, options.version.candidateCommit, response);
    const control = await releaseQaControl(options.store, held, {state: "testing"}, now());
    return {control, session, response, inspected, usage, checkout: options.checkout};
  } catch (error) {
    if (handle !== undefined) await host.stop(handle, context).catch(() => undefined);
    const dead = held.owner === null || held.owner.processId === null ? handle === undefined
      : await qaOwnerStatus(held.owner, options.probe) === "dead";
    // An unconfirmed death keeps the owner saved, so no other generation can take over.
    if (dead) await releaseQaControl(options.store, held, {state: "blocked"}, now()).catch(() => undefined);
    if (error instanceof AgentOpsError && error.recoveryPaths !== undefined) throw error;
    throw new AgentOpsError(error instanceof AgentOpsError ? error.code : "QA_AUTHOR_FAILED",
      error instanceof Error ? error.message : "QA authoring failed.", {cause: error, ...recovery});
  }
}
