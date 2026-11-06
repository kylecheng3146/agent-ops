import {randomUUID} from "node:crypto";
import {sha256} from "../fs/hash.js";
import {canonicalJson} from "../config/hash.js";
import {budgetExpired} from "./scheduler.js";
import {AgentOpsError} from "../fs/paths.js";
import type {NativeGoalEvent} from "./hosts/types.js";
import type {RunRepository, RunState} from "./service.js";
import type {NativeGoalHost} from "./supervisor.js";

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Read structured provider errors only; model prose cannot schedule a resume. */
export function nativeProviderLimit(value: unknown): {reason: string; resetAt: string | null; updatedAt?: number} | null {
  if (!record(value)) return null;
  const nodes: Record<string, unknown>[] = [value];
  for (let i = 0; i < nodes.length && i < 16; i++)
    for (const key of ["error", "codexErrorInfo", "apiErrorParams", "rate_limit_info", "quotaLimits", "rateLimits", "primary", "secondary", "turn", "goal"])
      if (record(nodes[i][key]) && nodes.length < 16) nodes.push(nodes[i][key] as Record<string, unknown>);
  const code = nodes.flatMap(n => [n.apiError, n.code, n.codexErrorInfo, n.type, n.status]).find(v => typeof v === "string" &&
    /^(?:usage_limit_reached|rate_limit_exceeded|rate_limit_error|quota_exceeded|usageLimitExceeded|usageLimited)$/iu.test(v));
  if (typeof code !== "string") return null;
  const times = nodes.flatMap(n => [n.resetsAt, n.resetAt]).map(v => typeof v === "number" && Number.isFinite(v)
    ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN).filter(t => Number.isFinite(t) && t > 0 && t < 8.64e15);
  const updated = nodes.map(n => n.updatedAt).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
  return {...(updated.length === 0 ? {} : {updatedAt: Math.max(...updated.map(t => t < 1e12 ? t * 1000 : t))}), reason: code, resetAt: times.length === 0 ? null : new Date(Math.max(...times)).toISOString()};
}

export async function recordProviderWait(repository: RunRepository, event: NativeGoalEvent): Promise<void> {
  if (event.nativeStatus !== "usageLimited") return;
  const limit = nativeProviderLimit(event.payload) ?? {reason: "usageLimited", resetAt: null};
  let resetAt = limit.resetAt;
  await repository.mutate(event.runId, state => {
    const worker = state.workers.find(w => w.workerId === event.workerId);
    const resumed = [...state.events].reverse().find(e => {
      if (e.code !== "RUN_PROVIDER_QUOTA_RESUME" || e.workerId !== event.workerId || e.detail === null) return false;
      try {const detail = JSON.parse(e.detail); return detail.generation === event.generation && detail.nativeSessionId === worker?.nativeSessionId;}
      catch {return false;}
    });
    if (resumed !== undefined && limit.updatedAt !== undefined && limit.updatedAt < Date.parse(resumed.at)) return state;
    if (resumed !== undefined && state.events.some(e => e.workerId === event.workerId && e.code === "RUN_PROVIDER_QUOTA_WAIT" &&
      e.at <= resumed.at && e.detail !== null && JSON.parse(e.detail).resetAt === limit.resetAt)) {
      if (Date.parse(event.at) <= Date.parse(resumed.at)) return state;
      if (resetAt !== null && Date.parse(resetAt) <= Date.parse(event.at)) resetAt = null;
    }
    if (!["active", "budget-limited"].includes(state.status) || state.disableRestart || state.awaitingResume || worker === undefined ||
      worker.generation !== event.generation || worker.host !== event.host || state.host !== event.host ||
      !["running", "idle"].includes(worker.status) || worker.stopIntent !== null) return state;
    if (state.providerWait?.resetAt != null && Date.parse(state.providerWait.resetAt) > Date.parse(event.at))
      resetAt = resetAt === null ? state.providerWait.resetAt : new Date(Math.max(Date.parse(resetAt), Date.parse(state.providerWait.resetAt))).toISOString();
    const wait = {workerId: worker.workerId, generation: worker.generation, host: worker.host,
      nativeSessionId: worker.nativeSessionId, nativeJobId: worker.nativeJobId, resetAt, reason: limit.reason,
      observedAt: event.at, fingerprint: sha256(canonicalJson({workerId: worker.workerId, generation: worker.generation, resetAt, reason: limit.reason}))};
    return {...state, providerWait: wait, status: resetAt === null ? "paused" : "budget-limited",
      awaitingResume: resetAt === null, disableRestart: resetAt === null,
      events: [...state.events, {id: randomUUID(), at: event.at, type: "diagnostic" as const,
        code: resetAt === null ? "RUN_PROVIDER_QUOTA_UNKNOWN" : "RUN_PROVIDER_QUOTA_WAIT", workerId: worker.workerId,
        taskId: worker.taskId, detail: canonicalJson(wait)}].slice(-2000)};
  });
}

/** Resume the existing writer only. A lost process or authority requires manual recovery. */
export async function resumeProviderWait(repository: RunRepository, host: NativeGoalHost, runId: string,
  revalidate: (state: RunState) => Promise<void>, now = Date.now()): Promise<boolean> {
  const state = await repository.read(runId), wait = state?.providerWait;
  if (state === null || wait == null || state.status !== "budget-limited" || state.disableRestart || state.awaitingResume) return false;
  const worker = state.workers.find(w => w.workerId === wait.workerId);
  try {
    if (budgetExpired(state, now)) throw new AgentOpsError("RUN_BUDGET_EXHAUSTED", "Legacy finite runs require explicit resume before upgrade.");
    if (worker === undefined || worker.generation !== wait.generation || worker.host !== wait.host || state.host !== wait.host ||
      worker.nativeSessionId !== wait.nativeSessionId || worker.nativeJobId !== wait.nativeJobId || worker.stopIntent !== null ||
      !["running", "idle"].includes(worker.status) || worker.nativeSessionId === null)
      throw new AgentOpsError("RUN_PROVIDER_WAIT_STALE", "Quota wait no longer owns its original native writer.");
    const writers = state.workers.filter(w => ["running", "idle"].includes(w.status));
    for (const writer of writers) {
      if (writer.nativeSessionId === null || writer.host !== wait.host || writer.stopIntent !== null)
        throw new AgentOpsError("RUN_PROVIDER_WAIT_STALE", "Quota wait lost a registered writer.");
      const observation = await host.inspect({...writer, nativeSessionId: writer.nativeSessionId, instance: state.nativeInstance});
      if (!observation.processAlive || observation.processIdentity !== writer.processIdentity)
        throw new AgentOpsError("RUN_PROVIDER_WORKER_UNAVAILABLE", "Quota-wait writer is unavailable; preserve its checkout for manual recovery.");
    }
    if (wait.resetAt === null || Date.parse(wait.resetAt) > now) return false;
    const eligible = await repository.read(runId);
    if (eligible?.status !== "budget-limited" || eligible.disableRestart || eligible.awaitingResume ||
      eligible.providerWait?.fingerprint !== wait.fingerprint) return false;
    await revalidate(eligible);
    let resumed = false;
    const active = await repository.mutate(runId, current => {
      const owner = current.workers.find(w => w.workerId === wait.workerId);
      if (owner?.generation !== wait.generation || owner.nativeSessionId !== wait.nativeSessionId || owner.nativeJobId !== wait.nativeJobId ||
        owner.stopIntent !== null || current.host !== wait.host ||
        current.status !== "budget-limited" || current.disableRestart || current.awaitingResume ||
        current.providerWait?.fingerprint !== wait.fingerprint) return current;
      resumed = true;
      return {...current, status: "active"};
    });
    if (!resumed) return false;
    await revalidate(active);
    const latest = await repository.read(runId);
    if (latest?.status !== "active" || latest.disableRestart || latest.awaitingResume || latest.providerWait?.fingerprint !== wait.fingerprint) return false;
    if (latest.currentContractHash !== state.currentContractHash)
      throw new AgentOpsError("RUN_PROVIDER_WAIT_STALE", "Contract changed during quota recovery.");
    for (const writer of writers) {
      const current = await repository.read(runId);
      const owned = current?.workers.find(w => w.workerId === writer.workerId);
      if (current?.status !== "active" || current.disableRestart || current.awaitingResume || current.providerWait?.fingerprint !== wait.fingerprint) return false;
      if (owned?.generation !== writer.generation || owned.nativeSessionId !== writer.nativeSessionId ||
        owned.nativeJobId !== writer.nativeJobId || owned.ownerSessionId !== writer.ownerSessionId ||
        owned.processId !== writer.processId || owned.processIdentity !== writer.processIdentity || owned.stopIntent !== null ||
        !["running", "idle"].includes(owned.status))
        throw new AgentOpsError("RUN_PROVIDER_WAIT_STALE", "Quota recovery writer changed before send.");
      await host.send({...writer, nativeSessionId: writer.nativeSessionId!, instance: current.nativeInstance,
        message: "Provider quota reset. Continue the assigned task in this same checkout, preserving all existing work and evidence.", generation: writer.generation});
      await repository.appendEvent(runId, {type: "diagnostic", code: "RUN_PROVIDER_QUOTA_RESUME", at: new Date(now).toISOString(),
        workerId: writer.workerId, taskId: writer.taskId,
        detail: canonicalJson({generation: writer.generation, nativeSessionId: writer.nativeSessionId, fingerprint: wait.fingerprint})});
      await repository.appendEvent(runId, {type: "diagnostic", code: "RUN_REPAIR_SENT", workerId: writer.workerId, taskId: writer.taskId,
        detail: canonicalJson({generation: writer.generation, nativeSessionId: writer.nativeSessionId, quota: wait.fingerprint})});
    }
    await repository.mutate(runId, current => current.status === "active" && !current.disableRestart &&
      current.providerWait?.fingerprint === wait.fingerprint ? {...current, providerWait: null} : current);
    return true;
  } catch (cause) {
    await repository.mutate(runId, current => current.disableRestart || !["active", "budget-limited"].includes(current.status) ||
      current.providerWait?.fingerprint !== wait.fingerprint ? current : ({...current,
      status: "paused", disableRestart: true, awaitingResume: true, providerWait: null,
      events: [...current.events, {id: randomUUID(), at: new Date(now).toISOString(), type: "diagnostic" as const,
        code: cause instanceof AgentOpsError ? cause.code : "RUN_PROVIDER_RESUME_FAILED", workerId: wait.workerId,
        taskId: worker?.taskId ?? null, detail: "Quota recovery requires manual reconciliation; source and authority are preserved."}].slice(-2000)}));
    return false;
  }
}
