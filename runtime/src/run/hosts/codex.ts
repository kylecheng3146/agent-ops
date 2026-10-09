import { randomUUID } from "node:crypto";

import { AgentOpsError } from "../../fs/paths.js";
import { JsonRpcSession, type JsonRecord } from "./protocol.js";
import {
  actionResult,
  assertContext,
  commandParts,
  event,
  assertProcessRunning,
  spawnNative,
  stopNativeProcess
} from "./util.js";
import type {
  NativeGoalActionResult,
  NativeGoalEvent,
  NativeGoalHandle,
  NativeGoalHost,
  NativeGoalHostOptions,
  NativeGoalRequestContext,
  NativeGoalStartInput,
  NativeGoalUpdate
} from "./types.js";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRecord(value: unknown, key: string): JsonRecord | null {
  if (!isRecord(value) || !isRecord(value[key])) {
    return null;
  }
  return value[key];
}

function stringField(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function statusField(value: unknown): NativeGoalHandle["goalStatus"] {
  const status = stringField(value, "status");
  return status === "active" || status === "paused" || status === "blocked" ||
    status === "usageLimited" || status === "budgetLimited" || status === "complete"
    ? status
    : "unknown";
}

function resultThreadId(result: JsonRecord, fallback: string | null = null): string {
  const thread = nestedRecord(result, "thread");
  const id = stringField(thread, "id");
  if (id === null) {
    if (fallback !== null) {
      return fallback;
    }
    throw new AgentOpsError("NATIVE_PROTOCOL_INVALID", "Codex app server did not return a thread id.");
  }
  return id;
}

function resultTurnId(result: JsonRecord): string | null {
  const turn = nestedRecord(result, "turn");
  return stringField(turn, "id");
}

export class CodexGoalHost implements NativeGoalHost {
  readonly kind = "codex" as const;
  private readonly sessions = new WeakMap<NativeGoalHandle, JsonRpcSession>();
  private readonly turns = new WeakMap<NativeGoalHandle, string>();
  private readonly now: () => Date;

  constructor(private readonly options: NativeGoalHostOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async start(input: NativeGoalStartInput): Promise<NativeGoalHandle> {
    const handle = await this.open(input, false, null);
    return handle;
  }

  async resume(
    input: NativeGoalStartInput,
    sessionId: string,
    objective?: string
  ): Promise<NativeGoalHandle> {
    if (sessionId.length === 0) {
      throw new AgentOpsError("NATIVE_SESSION_INVALID", "Codex thread id is required to resume.");
    }
    const handle = await this.open(input, true, sessionId);
    if (objective !== undefined) {
      await this.activate(handle, objective, input, input.tokenBudget);
    }
    return handle;
  }

  async activate(
    handle: NativeGoalHandle,
    objective: string,
    context: NativeGoalRequestContext,
    tokenBudget: number | null = null
  ): Promise<NativeGoalActionResult> {
    assertContext(handle, context);
    assertProcessRunning(handle.process);
    if (objective.length === 0 || objective.length > 4000) {
      throw new AgentOpsError("NATIVE_GOAL_INVALID", "Codex goal objective must be 1–4000 characters.");
    }
    const session = this.session(handle);
    const goal = await session.request("thread/goal/set", {
      threadId: handle.threadId,
      objective,
      status: "active",
      tokenBudget
    });
    const turn = await session.request("turn/start", {
      threadId: handle.threadId,
      input: [{ type: "text", text: objective }],
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review"
    });
    const turnId = resultTurnId(turn);
    if (turnId !== null) {
      this.turns.set(handle, turnId);
    }
    return actionResult(true, statusField(nestedRecord(goal, "goal") ?? goal), goal);
  }

  async update(
    handle: NativeGoalHandle,
    update: NativeGoalUpdate
  ): Promise<NativeGoalActionResult> {
    assertContext(handle, update);
    assertProcessRunning(handle.process);
    const session = this.session(handle);
    const goal = await session.request("thread/goal/set", {
      threadId: handle.threadId,
      objective: update.objective,
      status: "active",
      tokenBudget: update.tokenBudget ?? null
    });
    const turnId = this.turns.get(handle);
    let turn: JsonRecord;
    if (turnId === undefined) {
      turn = await session.request("turn/start", {
        threadId: handle.threadId,
        input: [{ type: "text", text: update.objective }],
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review"
      });
    } else {
      try {
        turn = await session.request("turn/steer", {
          threadId: handle.threadId,
          expectedTurnId: turnId,
          input: [{ type: "text", text: update.objective }]
        });
      } catch (error) {
        if (!(error instanceof AgentOpsError) || error.code !== "NATIVE_REQUEST_FAILED") {
          throw error;
        }
        turn = await session.request("turn/start", {
          threadId: handle.threadId,
          input: [{ type: "text", text: update.objective }],
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review"
        });
      }
    }
    const nextTurnId = resultTurnId(turn);
    if (nextTurnId !== null) {
      this.turns.set(handle, nextTurnId);
    }
    return actionResult(true, statusField(nestedRecord(goal, "goal") ?? goal), goal);
  }

  async *observe(
    handle: NativeGoalHandle,
    options: { readonly signal?: AbortSignal } = {}
  ): AsyncIterable<NativeGoalEvent> {
    const session = this.session(handle);
    while (true) {
      const message = await session.nextEvent(options.signal);
      if (message === null) {
        return;
      }
      const mapped = this.mapEvent(handle, message);
      yield {...mapped, ...(typeof message.method === "string" ? {transportMethod: message.method} : {})};
      if (mapped.type === "completed" || mapped.type === "error" || mapped.type === "closed") {
        return;
      }
    }
  }

  async interrupt(
    handle: NativeGoalHandle,
    context: NativeGoalRequestContext
  ): Promise<NativeGoalActionResult> {
    assertContext(handle, context);
    const session = this.session(handle);
    const turnId = this.turns.get(handle);
    if (turnId !== undefined) {
      await session.request("turn/interrupt", { threadId: handle.threadId, turnId });
    }
    const result = await session.request("thread/goal/set", {
      threadId: handle.threadId,
      objective: null,
      status: "paused",
      tokenBudget: null
    });
    return actionResult(true, statusField(nestedRecord(result, "goal") ?? result), result);
  }

  async stop(
    handle: NativeGoalHandle,
    context: NativeGoalRequestContext,
    signal: NodeJS.Signals = "SIGTERM"
  ): Promise<NativeGoalActionResult> {
    assertContext(handle, context);
    let payload: unknown = null;
    try {
      const result = await this.interrupt(handle, context);
      payload = result.payload;
    } catch {
      // A crashed or already closed native process is already stopped.
    }
    await stopNativeProcess(handle.process, signal);
    return actionResult(true, "paused", payload);
  }

  private async open(
    input: NativeGoalStartInput,
    resume: boolean,
    threadId: string | null
  ): Promise<NativeGoalHandle> {
    const parts = commandParts(this.options, "codex", ["app-server", "--listen", "stdio://"]);
    const process = spawnNative(parts.command, parts.args, input.cwd, input.env, this.options);
    const channel = new JsonRpcSession(process, input.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000);
    try {
    if (process.pid !== undefined) await input.registerProcess?.(process.pid);
    await this.sendInitialize(channel);
    let nativeThreadId: string;
    if (resume) {
      const result = await channel.request("thread/resume", {
        threadId,
        cwd: input.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
        excludeTurns: true
      });
      nativeThreadId = resultThreadId(result, threadId);
    } else {
      const result = await channel.request("thread/start", {
        cwd: input.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
        ephemeral: false
      });
      nativeThreadId = resultThreadId(result);
    }
    const handle: NativeGoalHandle = {
      runId: input.runId,
      workerId: input.workerId,
      generation: input.generation,
      contractHash: input.contractHash,
      kind: this.kind,
      sessionId: input.sessionId ?? randomUUID(),
      threadId: nativeThreadId,
      nativeVersion: input.nativeVersion ?? this.options.nativeVersion ?? null,
      cwd: input.cwd,
      processId: process.pid ?? null,
      startedAt: this.now().toISOString(),
      process,
      goalStatus: "unknown"
    };
    this.sessions.set(handle, channel);
    return handle;
    } catch (cause) {
      channel.close(cause);
      if (process.pid !== undefined) await stopNativeProcess(process, "SIGKILL");
      throw cause;
    }
  }

  private async sendInitialize(session: JsonRpcSession): Promise<void> {
    // Keep the notification sequence in one helper so callers cannot send a
    // goal before the app-server handshake is complete.
    await session.request("initialize", {
      capabilities: {experimentalApi: true},
      clientInfo: {
        name: "agent-ops",
        title: "agent-ops native goal host",
        version: "0.8.0"
      }
    });
    session.notify("initialized", {});
  }

  private session(handle: NativeGoalHandle): JsonRpcSession {
    const session = this.sessions.get(handle);
    if (session === undefined) {
      throw new AgentOpsError("NATIVE_SESSION_INVALID", "Unknown Codex native handle.");
    }
    return session;
  }

  private mapEvent(handle: NativeGoalHandle, message: JsonRecord): NativeGoalEvent {
    const method = typeof message.method === "string" ? message.method : "message";
    const payload = isRecord(message.params) ? message.params : message;
    if (method === "thread/goal/updated") {
      const goal = isRecord(payload.goal) ? payload.goal : payload;
      const status = statusField(goal);
      return event(handle, status === "complete" ? "completed" : "goal-updated", status, payload, this.now);
    }
    if (method === "thread/goal/cleared") {
      return event(handle, "goal-updated", "complete", payload, this.now);
    }
    if (method === "turn/completed") {
      this.turns.delete(handle);
      // A completed turn is not necessarily a completed native goal. Native
      // goals can continue automatically after a turn boundary.
      return event(handle, "message", "unknown", payload, this.now);
    }
    if (method === "turn/started") {
      const turn = nestedRecord(payload, "turn");
      const id = stringField(turn, "id");
      if (id !== null) this.turns.set(handle, id);
    }
    if (method.includes("usage") || method.includes("token")) {
      return event(handle, "usage", "unknown", payload, this.now);
    }
    return event(handle, "message", "unknown", payload, this.now);
  }
}
