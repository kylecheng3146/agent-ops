import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { type RunControlAction, type RunControlRecord, type RunRepository, type RunState } from "./service.js";

export type RunAuthorizationResult = "auto-approved" | "requires-host-approval" | "denied";

export interface RunCommandAuthorization {
  readonly commandDigest: string;
  readonly resourceDigest: string;
  readonly reason: string;
  readonly result: RunAuthorizationResult;
  readonly source: "claude-auto-mode" | "codex-auto-review" | "user" | "repo-trust";
  readonly expiresAt: string;
}

export interface RunControlRequest {
  readonly action: RunControlAction;
  readonly actor: "user" | "coordinator" | "supervisor";
  readonly reason?: string;
  readonly expiresAt?: string | null;
}

const MAX_REASON_LENGTH = 4_096;

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

  /** Record command authorization without persisting command text or secrets. */
  async recordAuthorization(runId: string, authorization: RunCommandAuthorization): Promise<RunState> {
    if (authorization.result === "denied") {
      throw error("RUN_COMMAND_DENIED", "The native host or organization denied this command; run controls cannot bypass it.");
    }
    if (!/^[a-f0-9]{64}$/u.test(authorization.commandDigest) || !/^[a-f0-9]{64}$/u.test(authorization.resourceDigest)) {
      throw error("RUN_AUTHORIZATION_INVALID", "Run authorization must use command and resource digests.");
    }
    if (authorization.reason.length === 0 || authorization.reason.length > MAX_REASON_LENGTH) throw error("RUN_AUTHORIZATION_INVALID", "Run authorization reason is invalid.");
    const at = nowIso(this.#now);
    return await this.#repository.mutate(runId, (current) => ({
      ...current,
      events: [...current.events, {
        id: `auth-${sha256(`${authorization.commandDigest}:${at}`)}`,
        at,
        type: "control",
        code: authorization.result === "auto-approved" ? "RUN_COMMAND_AUTO_APPROVED" : "RUN_COMMAND_HOST_APPROVAL",
        workerId: null,
        taskId: null,
        detail: `${authorization.source}:${authorization.commandDigest}:${authorization.resourceDigest}`
      } as const].slice(-2_000)
    }));
  }
}
