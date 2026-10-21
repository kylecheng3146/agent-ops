import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import {canonicalJson, calculateConfigHash} from "../config/hash.js";
import {readRunPolicy} from "./policy.js";
import {join} from "node:path";
import {readPrivateFile, writePrivateFile} from "../security/permissions.js";
import {redactSecrets} from "../security/redact.js";
import { type RunControlAction, type RunControlRecord, type RunRepository, type RunState } from "./service.js";

export type RunAuthorizationResult = "auto-approved" | "requires-host-approval" | "denied" | "unknown";

export interface RunCommandAuthorization {
  readonly commandDigest: string;
  readonly resourceDigest: string;
  readonly reason: string;
  readonly result: RunAuthorizationResult;
  readonly source: "claude-auto-mode" | "codex-auto-review" | "coordinator-policy-review" | "user" | "repo-trust";
  readonly expiresAt: string;
  readonly authorizationId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly nativeSessionId: string | null;
  readonly operation: string;
  readonly command: string;
  readonly resource: string;
  readonly policyConfigHash: string;
  readonly runtimeHash: string;
  readonly policyArtifactDigest: string;
}

export interface RunControlRequest {
  readonly action: RunControlAction;
  readonly actor: "user" | "coordinator" | "supervisor";
  readonly reason?: string;
  readonly expiresAt?: string | null;
}

const MAX_REASON_LENGTH = 4_096;

const RETRY_APPROVAL = "retry-approval:";
const AUTH_ID = /^auth-[a-f0-9]{64}$/u;
const DENIAL_DIAGNOSTIC = "Native authorization could not be accepted; no alternate permission path is allowed.";

/** A manual resume covers initial recovery once, never a subsequent supervisor restart. */
export function nativeResumeTime(state: RunState, now = Date.now()): string | undefined {
  const control = state.controls.at(-1);
  if (control?.action !== "resume" || control.actor !== "user" || control.appliedAt !== null) return undefined;
  const time = Date.parse(control.requestedAt);
  if (!Number.isFinite(time) || !Number.isFinite(now) || time > now ||
      state.events.some(e => e.code === "RUN_SUPERVISOR_START" && (!Number.isFinite(Date.parse(e.at)) || Date.parse(e.at) >= time))) return undefined;
  return control.requestedAt;
}

/** An explicit retry acknowledges a failed reviewer, never a command permission. */
export async function approvalRetryEvents(state: RunState, requested: readonly string[]): Promise<ReadonlySet<string>> {
  const fail = (): never => {throw error("RUN_NOT_RESUMABLE", "Approval retry requires the original, intact Codex usage-limit review failure.");};
  if (!Array.isArray(requested) || requested.some(id => typeof id !== "string" || !AUTH_ID.test(id)) || new Set(requested).size !== requested.length) fail();
  const prior = new Set<string>();
  for (const control of state.controls) {
    if (control.action !== "resume" || control.actor !== "user" || !control.reason?.startsWith(RETRY_APPROVAL)) continue;
    let ids: unknown;
    try {ids = JSON.parse(control.reason.slice(RETRY_APPROVAL.length));} catch {return fail();}
    if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !AUTH_ID.test(id))) fail();
    for (const id of ids as string[]) prior.add(id);
  }
  const ignored = new Set<string>();
  for (const id of new Set([...prior, ...requested])) {
    const index = state.events.findIndex(e => e.id === id);
    const event = state.events[index];
    if (event?.type !== "control" || event.code !== "RUN_COMMAND_DENIED") fail();
    const path = join(state.commonDir, "agent-ops/runs", state.runId, "authorizations", id + ".json");
    let ref: {artifact?: unknown; digest?: unknown; result?: unknown; source?: unknown};
    let authorization: RunCommandAuthorization & {runId: string};
    try {
      ref = JSON.parse(event.detail!);
      const source = await readPrivateFile(path, state.commonDir);
      if (ref.artifact !== path || ref.result !== "denied" || ref.source !== "codex-auto-review" || source === null ||
        Buffer.byteLength(source) > 128 * 1024 || sha256(source) !== ref.digest) fail();
      authorization = JSON.parse(source!);
    } catch {return fail();}
    const a = authorization;
    if (a === null || typeof a !== "object") fail();
    const worker = state.workers.find(w => w.workerId === event.workerId);
    if (a.runId !== state.runId || a.workerId !== event.workerId || worker === undefined || event.taskId !== worker.taskId ||
      !Number.isSafeInteger(a.generation) || a.generation < 1 || a.generation > worker.generation ||
      (!prior.has(id) && (a.generation !== worker.generation || a.nativeSessionId !== worker.nativeSessionId)) ||
      a.source !== "codex-auto-review" || a.result !== "denied" || a.operation !== "command" ||
      typeof a.reason !== "string" || !/^Automatic approval review failed: You[’']ve hit your usage limit(?:[.!]|$)/u.test(a.reason) ||
      typeof a.command !== "string" || typeof a.resource !== "string" ||
      !/^[a-f0-9]{64}$/u.test(a.commandDigest) || !/^[a-f0-9]{64}$/u.test(a.resourceDigest) ||
      typeof a.authorizationId !== "string" || a.authorizationId.length === 0 || a.authorizationId.length > 256 ||
      !(a.nativeSessionId === null || typeof a.nativeSessionId === "string") ||
      id !== "auth-" + sha256(canonicalJson({runId: state.runId, workerId: a.workerId, generation: a.generation,
        nativeSessionId: a.nativeSessionId, source: a.source, id: a.authorizationId}))) fail();
    // Command/resource strings were redacted when saved; their original digests cannot be recomputed.
    let binding = state.policyBinding;
    let matched = false;
    for (let depth = 0; binding !== undefined && depth < 128; depth++) {
      const policy = await readRunPolicy({...state, policyBinding: binding}, binding.runtimeHash, Date.now(), true);
      if (binding.artifactDigest === a.policyArtifactDigest) {
        matched = binding.configHash === a.policyConfigHash && binding.runtimeHash === a.runtimeHash && binding.expiresAt === a.expiresAt;
        break;
      }
      if (policy?.previousDigest == null) break;
      const source = await readPrivateFile(join(state.commonDir, "agent-ops/runs", state.runId, "policies", policy.previousDigest + ".json"), state.commonDir);
      if (source === null || sha256(source) !== policy.previousDigest) fail();
      const previous = JSON.parse(source!);
      binding = {artifactDigest: policy.previousDigest, configHash: calculateConfigHash(previous.config), runtimeHash: previous.runtimeHash, expiresAt: previous.expiresAt};
    }
    if (!matched) fail();
    ignored.add(id);
    const next = state.events.slice(index + 1).find(e => e.workerId === event.workerId && e.code === "RUN_COMMAND_DENIED");
    if (next?.type === "diagnostic" && next.taskId === null && next.detail === DENIAL_DIAGNOSTIC) ignored.add(next.id);
  }
  return ignored;
}

function error(code: string, message: string): AgentOpsError {
  return new AgentOpsError(code, message);
}

function replace(state: RunState, controls: readonly RunControlRecord[]): RunState {
  return { ...state, controls };
}

function nowIso(now: () => string): string {
  const value = now();
  if (!Number.isFinite(Date.parse(value))) throw error("RUN_CLOCK_INVALID", "Run clock returned an invalid timestamp.");
  return value;
}

/**
 * Run-scoped controls are an audit record and a coordination boundary. They
 * never turn a repo trust grant into a global permission or bypass a native
 * host's explicit denial.
 */
export class RunControlService {
  readonly #repository: RunRepository;
  readonly #now: () => string;

  constructor(repository: RunRepository, now: () => string = () => new Date().toISOString()) {
    this.#repository = repository;
    this.#now = now;
  }

  async request(runId: string, request: RunControlRequest): Promise<RunState> {
    const now = nowIso(this.#now);
    const reason = request.reason?.trim() ?? null;
    if (reason !== null && (reason.length === 0 || reason.length > MAX_REASON_LENGTH || reason.includes("\0"))) {
      throw error("RUN_CONTROL_REASON_INVALID", "Control reason is empty or too large.");
    }
    return await this.#repository.mutate(runId, (current) => {
      if (request.action === "resume" && ["complete", "blocked"].includes(current.status)) throw error("RUN_NOT_RESUMABLE", `Run ${runId} is ${current.status}.`);
      const control: RunControlRecord = {
        action: request.action,
        actor: request.actor,
        reason,
        requestedAt: now,
        expiresAt: request.expiresAt ?? null,
        appliedAt: null
      };
      const status = request.action === "stop"
        ? "stopping"
        : request.action === "pause"
          ? "paused"
          : request.action === "resume" || request.action === "respond"
            ? "active"
            : current.status;
      return {
        ...replace(current, [...current.controls, control]),
        status,
        // A user-authorized resume re-enables reconciliation. The native
        // process is still restarted only after the supervisor revalidates
        // its generation and worktree lease.
        disableRestart: request.action === "stop" ? true : request.action === "resume" ? false : current.disableRestart,
        awaitingResume: request.action === "resume" ? false : current.awaitingResume
      };
    });
  }

  async markApplied(runId: string, action: RunControlAction, requestedAt: string): Promise<RunState> {
    return await this.#repository.mutate(runId, (current) => {
      const found = current.controls.findIndex((control) => control.action === action && control.requestedAt === requestedAt && control.appliedAt === null);
      if (found < 0) throw error("RUN_CONTROL_NOT_FOUND", `No pending ${action} control was found.`);
      const controls = [...current.controls];
      controls[found] = { ...controls[found]!, appliedAt: nowIso(this.#now) };
      return replace(current, controls);
    });
  }

  async pending(runId: string): Promise<readonly RunControlRecord[]> {
    const state = await this.#repository.read(runId);
    if (state === null) throw error("RUN_NOT_FOUND", `Run not found: ${runId}`);
    return state.controls.filter((control) => control.appliedAt === null);
  }

  /** Keep the complete redacted scope; the digests identify the original input. */
  async recordAuthorization(runId: string, authorization: RunCommandAuthorization): Promise<RunState> {
    if (sha256(authorization.command) !== authorization.commandDigest || sha256(authorization.resource) !== authorization.resourceDigest ||
      !["auto-approved", "requires-host-approval", "denied", "unknown"].includes(authorization.result) ||
      !["claude-auto-mode", "codex-auto-review", "coordinator-policy-review", "user", "repo-trust"].includes(authorization.source) ||
      !Number.isSafeInteger(authorization.generation) || authorization.generation < 1 ||
      authorization.workerId.length === 0 || authorization.workerId.length > 256 ||
      authorization.operation.length === 0 || authorization.operation.length > 256) {
      throw error("RUN_AUTHORIZATION_INVALID", "Run authorization must use command and resource digests.");
    }
    if (authorization.reason.length === 0 || authorization.reason.length > MAX_REASON_LENGTH) throw error("RUN_AUTHORIZATION_INVALID", "Run authorization reason is invalid.");
    const at = nowIso(this.#now);
    if (!Number.isFinite(Date.parse(authorization.expiresAt)) ||
      (authorization.result === "auto-approved" && Date.parse(authorization.expiresAt) <= Date.parse(at)) ||
      !/^[a-f0-9]{64}$/u.test(authorization.policyConfigHash) || !/^[a-f0-9]{64}$/u.test(authorization.runtimeHash) ||
      !/^[a-f0-9]{64}$/u.test(authorization.policyArtifactDigest) ||
      authorization.authorizationId.length === 0 || authorization.authorizationId.length > 256 ||
      authorization.command.length > 32 * 1024 || authorization.resource.length > 32 * 1024)
      throw error("RUN_AUTHORIZATION_INVALID", "Authorization identity, expiry or scope is invalid.");
    const id = "auth-" + sha256(canonicalJson({runId, workerId: authorization.workerId, generation: authorization.generation,
      nativeSessionId: authorization.nativeSessionId, source: authorization.source, id: authorization.authorizationId}));
    const state = await this.#repository.read(runId);
    if (state === null) throw error("RUN_NOT_FOUND", "Run does not exist.");
    const path = join(state.commonDir, "agent-ops/runs", runId, "authorizations", id + ".json");
    const content = canonicalJson({runId, ...authorization, command: redactSecrets(authorization.command),
      resource: redactSecrets(authorization.resource), reason: redactSecrets(authorization.reason)});
    const previous = await readPrivateFile(path, state.commonDir);
    if (previous !== null && previous !== content) throw error("RUN_AUTHORIZATION_CONFLICT", "An authorization identity cannot be reused for a different decision.");
    const saved = await this.#repository.mutate(runId, async current => {
      const worker = current.workers.find(w => w.workerId === authorization.workerId);
      if (worker?.generation !== authorization.generation || worker.nativeSessionId !== authorization.nativeSessionId ||
        current.status !== "active" || current.disableRestart || current.policyBinding?.configHash !== authorization.policyConfigHash ||
        current.policyBinding.runtimeHash !== authorization.runtimeHash || current.policyBinding.expiresAt !== authorization.expiresAt ||
        current.policyBinding.artifactDigest !== authorization.policyArtifactDigest)
        throw error("RUN_AUTHORIZATION_STALE", "Authorization must bind the current worker, run policy and runtime.");
      await writePrivateFile(path, content, current.commonDir);
      if (current.events.some(event => event.id === id)) return current;
      return {...current, events: [...current.events, {
        id,
        at,
        type: "control",
        code: authorization.result === "auto-approved" ? "RUN_COMMAND_AUTO_APPROVED" : authorization.result === "denied" ? "RUN_COMMAND_DENIED" : "RUN_COMMAND_AUTHORIZATION_OBSERVED",
        workerId: authorization.workerId,
        taskId: worker.taskId,
        detail: canonicalJson({artifact: path, digest: sha256(content), result: authorization.result, source: authorization.source})
      } as const].slice(-2_000)
      };
    });
    if (authorization.result === "denied") throw error("RUN_COMMAND_DENIED", "The native host or organization denied this command; its audit is saved and the denial cannot be bypassed.");
    return saved;
  }
}
