import { execFile } from "node:child_process";
import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { ReviewTargetId } from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";
import { nativeProcessGroupAlive, signalNativeProcessGroup } from "../run/hosts/util.js";
import { nativeProcessIdentity } from "../run/transport.js";
import type { FileQaStore } from "./store.js";
import type { QaControl, QaOwner, QaSession, QaState } from "./types.js";

const exec = promisify(execFile);
/** Agy keeps its read-only reviewer uses; it is never a writable QA author. */
const WRITABLE: readonly ReviewTargetId[] = ["claude", "codex"];

export interface QaHostChoice { readonly host: ReviewTargetId; readonly fallbackReason: string | null }
/** Prefer a host other than the implementer's; a same-host session is allowed only with its reason recorded. */
export function selectQaHost(request: {readonly implementationHost: ReviewTargetId | null;
  readonly available: readonly ReviewTargetId[]; readonly writable: boolean}): QaHostChoice {
  const eligible = request.available.filter(host => !request.writable || WRITABLE.includes(host));
  const other = eligible.find(host => host !== request.implementationHost);
  if (request.implementationHost !== null && other !== undefined) return {host: other, fallbackReason: null};
  const host = eligible[0];
  if (host === undefined) throw new AgentOpsError("QA_HOST_UNAVAILABLE",
    `No configured ${request.writable ? "writable Claude/Codex " : ""}QA host is available; QA stays unverified.`);
  return {host, fallbackReason: request.implementationHost === null
    ? "The implementation host is unknown, so host independence is unproven; this is a fresh separate session only."
    : `No other configured ${request.writable ? "writable " : ""}QA host is available; using a fresh separate ${host} session.`};
}
export function qaSession(choice: QaHostChoice, input: {readonly sessionId: string; readonly implementationSessionId: string;
  readonly implementationHost: ReviewTargetId | null; readonly writable: boolean}): QaSession {
  if (input.sessionId === input.implementationSessionId)
    throw new AgentOpsError("QA_SESSION_SHARED", "QA cannot share the developer's session or conversation history.");
  if (input.writable && !WRITABLE.includes(choice.host)) throw new AgentOpsError("QA_HOST_UNAVAILABLE", "Only Claude or Codex can author QA materials.");
  return {host: choice.host, sessionId: input.sessionId, implementationSessionId: input.implementationSessionId,
    implementationHost: input.implementationHost, writable: input.writable, fallbackReason: choice.fallbackReason};
}

export interface QaProcessProbe {
  identity(pid: number): Promise<string | null>;
  groupAlive(pid: number): boolean;
  signalGroup(pid: number, signal: NodeJS.Signals): Promise<void>;
}
export const nativeQaProbe: QaProcessProbe = {identity: nativeProcessIdentity,
  groupAlive: pid => process.platform !== "win32" && nativeProcessGroupAlive(pid), signalGroup: signalNativeProcessGroup};

/** Death is a fact about the saved process, never an assumption: an unregistered owner is unidentified. */
export async function qaOwnerStatus(owner: QaOwner, probe: QaProcessProbe = nativeQaProbe): Promise<"dead" | "live" | "unidentified"> {
  if (owner.processId === null || owner.processIdentity === null) return "unidentified";
  const identity = await probe.identity(owner.processId);
  if (identity === owner.processIdentity) return "live";
  // A PID with another start time was reused, which POSIX allows only once the old group is empty.
  if (identity !== null) return "dead";
  return probe.groupAlive(owner.processId) ? "live" : "dead";
}

export interface QaClaim {
  readonly taskId: string;
  readonly controllerId: string;
  readonly session: QaSession;
  readonly state: Extract<QaState, "planning" | "testing">;
  /** A user-initiated command may restart after Stop; automatic continuation may not. */
  readonly explicit?: boolean;
  readonly now: string;
  readonly probe?: QaProcessProbe;
}
/** A new generation exists only after the previous owner's death is confirmed and saved. */
export async function claimQaControl(store: FileQaStore, claim: QaClaim): Promise<QaControl> {
  let current = await store.readControl(claim.taskId);
  if (current !== null && current.owner !== null) {
    const status = await qaOwnerStatus(current.owner, claim.probe);
    if (status === "live") throw new AgentOpsError("QA_WRITER_LIVE", "A QA session for this task is still running; stop it before another takes over.");
    if (status === "unidentified") throw new AgentOpsError("QA_WRITER_UNIDENTIFIED",
      "A previous QA owner never registered a process, so its death cannot be confirmed; run qa stop for this task first.");
    current = await store.updateControl(claim.taskId, current.revision, saved => ({...saved!, revision: saved!.revision + 1,
      owner: null, state: "blocked", updatedAt: claim.now}));
  }
  if (current !== null && !current.continuation && claim.explicit !== true)
    throw new AgentOpsError("QA_CONTINUATION_DISABLED", "QA was stopped for this task; only an explicit QA command may continue it.");
  return await store.updateControl(claim.taskId, current?.revision ?? 0, saved => ({schemaVersion: 1, taskId: claim.taskId,
    revision: (saved?.revision ?? 0) + 1, generation: (saved?.generation ?? 0) + 1, state: claim.state, continuation: true,
    owner: {controllerId: claim.controllerId, session: claim.session, processId: null, processIdentity: null},
    plan: saved?.plan ?? null, attempt: saved?.attempt ?? null, report: saved?.report ?? null,
    // An owned generation cannot also hold a sealed verdict; a claimed native pause is consumed.
    attestation: null, progress: saved?.progress ?? null, updatedAt: claim.now,
    ...(saved?.decisions === undefined ? {} : {decisions: saved.decisions})}));
}
function owns(current: QaControl | null, held: QaControl): current is QaControl {
  return current !== null && current.generation === held.generation && current.continuation &&
    current.owner?.controllerId === held.owner?.controllerId && current.owner?.session.sessionId === held.owner?.session.sessionId;
}
function stale(error: unknown): never {
  if (error instanceof AgentOpsError && error.code === "QA_CONTROL_CHANGED")
    throw new AgentOpsError("QA_STALE_WRITER", "QA control moved to another owner, generation or stop; this session's result is rejected.", {cause: error});
  throw error;
}
/** Provisional ownership is durable before a native handshake can wait or fail. */
export async function registerQaProcess(store: FileQaStore, held: QaControl, pid: number, now: string,
  probe: QaProcessProbe = nativeQaProbe): Promise<QaControl> {
  const identity = await probe.identity(pid);
  if (identity === null) throw new AgentOpsError("QA_PROCESS_IDENTITY_REQUIRED", "Cannot register an unidentified QA process.");
  return await store.updateControl(held.taskId, held.revision, current => {
    if (!owns(current, held)) throw new AgentOpsError("QA_STALE_WRITER", "Stop or takeover fenced this QA process registration.");
    return {...current, revision: current.revision + 1, owner: {...current.owner!, processId: pid, processIdentity: identity}, updatedAt: now};
  }).catch(stale);
}
/** Releases only the exact generation and owner that claimed it; anything else is a stale result. */
export async function releaseQaControl(store: FileQaStore, held: QaControl,
  patch: Partial<Pick<QaControl, "state" | "plan" | "attempt" | "report" | "continuation" | "progress" | "native">>, now: string): Promise<QaControl> {
  return await store.updateControl(held.taskId, held.revision, current => {
    if (!owns(current, held)) throw new AgentOpsError("QA_STALE_WRITER", "QA control moved to another owner, generation or stop; this session's result is rejected.");
    return {...current, ...patch, revision: current.revision + 1, owner: null, updatedAt: now};
  }).catch(stale);
}

async function waitDead(owner: QaOwner, probe: QaProcessProbe): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    if (await qaOwnerStatus(owner, probe) === "dead") return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return await qaOwnerStatus(owner, probe) === "dead";
}
/**
 * User Stop for an ordinary task: fence first, then confirm the registered process group is gone.
 * The isolated checkout is never removed here; dirty material stays for diagnosis.
 */
export async function stopQa(store: FileQaStore, taskId: string, now: string, probe: QaProcessProbe = nativeQaProbe): Promise<QaControl> {
  const current = await store.readControl(taskId);
  if (current === null) throw new AgentOpsError("QA_NOT_STARTED", "This task has no QA state to stop.");
  if (current.owner === null && (current.state === "passed" || current.state === "stopped")) return current;
  // Continuation off makes every later registration or result from this generation fail its compare-and-swap.
  const fenced = await store.updateControl(taskId, current.revision, saved => ({...saved!, revision: saved!.revision + 1,
    continuation: false, updatedAt: now}));
  const owner = fenced.owner;
  if (owner !== null && owner.processId !== null && await qaOwnerStatus(owner, probe) !== "dead") {
    await probe.signalGroup(owner.processId, "SIGTERM");
    if (!await waitDead(owner, probe)) {
      await probe.signalGroup(owner.processId, "SIGKILL");
      if (!await waitDead(owner, probe)) throw new AgentOpsError("QA_WRITER_STILL_ALIVE",
        "The registered QA process group has not stopped; ownership is preserved and takeover is refused.");
    }
  }
  return await store.updateControl(taskId, fenced.revision, saved => ({...saved!, revision: saved!.revision + 1,
    owner: null, state: "stopped", continuation: false, updatedAt: now}));
}

/**
 * A separate clone at the exact commit, with no remote back to the delivery repository.
 * This keeps QA writes out of delivered content; it is not an OS sandbox.
 */
export async function cloneQaCheckout(repositoryRoot: string, destination: string, commit: string): Promise<void> {
  if (await lstat(destination).then(() => true, () => false))
    throw new AgentOpsError("QA_CHECKOUT_EXISTS", "A QA checkout already exists there; it is preserved, never overwritten.", {recoveryPaths: [destination]});
  await mkdir(dirname(destination), {recursive: true});
  try {
    await exec("git", ["clone", "--no-hardlinks", "--quiet", "--no-checkout", "--", repositoryRoot, destination], {maxBuffer: 1024 * 1024});
    for (const args of [["checkout", "--quiet", "--detach", commit], ["remote", "remove", "origin"]])
      await exec("git", args, {cwd: destination, maxBuffer: 1024 * 1024});
  } catch (cause) {
    throw new AgentOpsError("QA_CHECKOUT_FAILED", "Could not create the isolated QA checkout at the exact candidate commit.", {cause, recoveryPaths: [destination]});
  }
}
