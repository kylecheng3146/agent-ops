import { randomUUID } from "node:crypto";

import { AgentOpsError } from "../../fs/paths.js";
import { JsonLineStream, type JsonRecord } from "./protocol.js";
import {
  actionResult,
  assertContext,
  assertProcessRunning,
  event,
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

function stringField(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function goalStatus(value: unknown): NativeGoalHandle["goalStatus"] {
  if (isRecord(value)) {
    const subtype = stringField(value, "subtype");
    if (subtype === "success") return "complete";
    if (subtype === "error_max_budget_usd" || subtype === "error_max_turns") return "budgetLimited";
    const status = stringField(value, "status");
    if (status === "active" || status === "paused" || status === "blocked" ||
      status === "usageLimited" || status === "budgetLimited" || status === "complete") {
      return status;
    }
  }
  return "unknown";
}

function writeMessage(handle: NativeGoalHandle, text: string): void {
  handle.process.stdin.write(`${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }]
    }
  })}\n`);
}

export class ClaudeGoalHost implements NativeGoalHost {
  readonly kind = "claude" as const;
  private readonly streams = new WeakMap<NativeGoalHandle, JsonLineStream>();
  private readonly now: () => Date;

  constructor(private readonly options: NativeGoalHostOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async start(input: NativeGoalStartInput): Promise<NativeGoalHandle> {
    return this.open(input, false, null);
  }

  async resume(
    input: NativeGoalStartInput,
    sessionId: string,
    objective?: string
  ): Promise<NativeGoalHandle> {
    if (sessionId.length === 0) {
      throw new AgentOpsError("NATIVE_SESSION_INVALID", "Claude session id is required to resume.");
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
      throw new AgentOpsError("NATIVE_GOAL_INVALID", "Claude goal objective must be 1–4000 characters.");
    }
    const condition = tokenBudget === null
      ? `/goal ${objective}`
      : `/goal ${objective} or stop after ${tokenBudget} tokens`;
    writeMessage(handle, condition);
    return actionResult(true, "active", { objective, tokenBudget });
  }

  async update(
    handle: NativeGoalHandle,
    update: NativeGoalUpdate
  ): Promise<NativeGoalActionResult> {
    assertContext(handle, update);
    assertProcessRunning(handle.process);
    return this.activate(handle, update.objective, update, update.tokenBudget ?? null);
  }

  async *observe(
    handle: NativeGoalHandle,
    options: { readonly signal?: AbortSignal } = {}
  ): AsyncIterable<NativeGoalEvent> {
    const stream = this.stream(handle);
    while (true) {
      const message = await stream.next(options.signal);
      if (message === null) {
        return;
      }
      const mapped = this.mapEvent(handle, message);
      yield mapped;
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
    if (handle.process.exitCode === null && handle.process.signalCode === null) {
      handle.process.kill("SIGINT");
    }
    return actionResult(true, "paused", { signal: "SIGINT" });
  }

  async stop(
    handle: NativeGoalHandle,
    context: NativeGoalRequestContext,
    signal: NodeJS.Signals = "SIGTERM"
  ): Promise<NativeGoalActionResult> {
    assertContext(handle, context);
    await stopNativeProcess(handle.process, signal);
    return actionResult(true, "paused", { signal });
  }

  private async open(
    input: NativeGoalStartInput,
    resume: boolean,
    sessionId: string | null
  ): Promise<NativeGoalHandle> {
    const requestedSessionId = sessionId ?? input.sessionId ?? randomUUID();
    const defaultArgs = resume
      ? [
          "-p",
          "--resume", requestedSessionId,
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--verbose", "--include-partial-messages",
          "--permission-mode", "auto",
          "--permission-prompts", "none"
        ]
      : [
          "-p",
          "--session-id", requestedSessionId,
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--verbose", "--include-partial-messages",
          "--permission-mode", "auto",
          "--permission-prompts", "none"
        ];
    const command = this.options.command ?? "claude";
    const args = this.options.args ?? defaultArgs;
    const process = spawnNative(command, args, input.cwd, input.env, this.options);
    const stream = new JsonLineStream(process);
    try {
      if (process.pid !== undefined) await input.registerProcess?.(process.pid);
    } catch (cause) {
      stream.close(cause);
      if (process.pid !== undefined) await stopNativeProcess(process, "SIGKILL");
      throw cause;
    }
    const handle: NativeGoalHandle = {
      runId: input.runId,
      workerId: input.workerId,
      generation: input.generation,
      contractHash: input.contractHash,
      kind: this.kind,
      // --session-id and --resume make this identity durable before the first
      // user message. Claude can emit startup hook events before system/init,
      // so start intentionally does not wait for that event.
      sessionId: requestedSessionId,
      threadId: null,
      nativeVersion: input.nativeVersion ?? this.options.nativeVersion ?? null,
      cwd: input.cwd,
      processId: process.pid ?? null,
      startedAt: this.now().toISOString(),
      process,
      goalStatus: "unknown"
    };
    this.streams.set(handle, stream);
    return handle;
  }

  private stream(handle: NativeGoalHandle): JsonLineStream {
    const stream = this.streams.get(handle);
    if (stream === undefined) {
      throw new AgentOpsError("NATIVE_SESSION_INVALID", "Unknown Claude native handle.");
    }
    return stream;
  }

  private mapEvent(handle: NativeGoalHandle, payload: JsonRecord): NativeGoalEvent {
    const type = stringField(payload, "type");
    if (type === "result") {
      const subtype = stringField(payload, "subtype");
      return event(
        handle,
        subtype === "success" ? "completed" : "error",
        goalStatus(payload),
        payload,
        this.now
      );
    }
    if (type === "error" || (type === "system" && stringField(payload, "subtype") === "error")) {
      return event(handle, "error", goalStatus(payload), payload, this.now);
    }
    if (isRecord(payload.usage) || typeof payload.total_cost_usd === "number") {
      return event(handle, "usage", goalStatus(payload), payload, this.now);
    }
    if (type === "system" && stringField(payload, "subtype") === "goal") {
      return event(handle, "goal-updated", goalStatus(payload), payload, this.now);
    }
    return event(handle, "message", goalStatus(payload), payload, this.now);
  }
}
