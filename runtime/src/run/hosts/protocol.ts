import { createInterface, type Interface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { AgentOpsError } from "../../fs/paths.js";
import type { NativeJson } from "./types.js";

export type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLine(line: string, source: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    throw new AgentOpsError("NATIVE_PROTOCOL_INVALID", `Invalid JSON from ${source}.`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new AgentOpsError("NATIVE_PROTOCOL_INVALID", `Native ${source} message is not an object.`);
  }
  return parsed;
}

interface PendingRequest {
  readonly resolve: (value: JsonRecord) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

interface EventWaiter {
  readonly resolve: (value: JsonRecord | null) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
}

/** JSONL request/notification channel used by the Codex app server. */
export class JsonRpcSession {
  private readonly lines: Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly events: JsonRecord[] = [];
  private readonly waiters: EventWaiter[] = [];
  private nextId = 1;
  private closed: unknown = null;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly requestTimeoutMs = 30_000
  ) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.receive(line, "stdout"));
    child.once("error", (error) => this.close(error));
    child.once("exit", (code, signal) => {
      this.close(new AgentOpsError(
        "NATIVE_PROCESS_CLOSED",
        `Native process closed (code=${String(code)}, signal=${String(signal)}).`
      ));
    });
  }

  async request(method: string, params: JsonRecord): Promise<JsonRecord> {
    if (this.closed !== null) {
      throw this.closed;
    }
    const id = this.nextId++;
    const request = { jsonrpc: "2.0", id, method, params };
    const response = new Promise<JsonRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentOpsError("NATIVE_REQUEST_TIMEOUT", `Native request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write(request);
    return response;
  }

  notify(method: string, params: JsonRecord = {}): void {
    if (this.closed !== null) {
      throw this.closed;
    }
    this.write({ jsonrpc: "2.0", method, params });
  }

  async nextEvent(signal?: AbortSignal): Promise<JsonRecord | null> {
    if (this.events.length > 0) {
      return this.events.shift() ?? null;
    }
    if (this.closed !== null) {
      return null;
    }
    return new Promise<JsonRecord | null>((resolve, reject) => {
      const waiter: EventWaiter = { resolve, reject, signal };
      if (signal !== undefined) {
        if (signal.aborted) {
          resolve(null);
          return;
        }
        const onAbort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          resolve(null);
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  close(error: unknown = null): void {
    if (this.closed !== null) {
      return;
    }
    this.closed = error ?? new AgentOpsError("NATIVE_PROCESS_CLOSED", "Native process closed.");
    this.lines.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.closed);
    }
    this.pending.clear();
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(null);
    }
  }

  private receive(line: string, source: string): void {
    if (line.trim().length === 0) {
      return;
    }
    let message: JsonRecord;
    try {
      message = parseLine(line, source);
    } catch (error) {
      this.close(error);
      return;
    }
    const id = message.id;
    if (typeof id === "number" && Number.isSafeInteger(id)) {
      const pending = this.pending.get(id);
      if (pending === undefined) {
        this.enqueue(message);
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (isRecord(message.error)) {
        pending.reject(new AgentOpsError(
          "NATIVE_REQUEST_FAILED",
          String(message.error.message ?? "Native request failed"),
          { cause: message.error }
        ));
      } else if (isRecord(message.result)) {
        pending.resolve(message.result);
      } else {
        pending.resolve(message);
      }
      return;
    }
    this.enqueue(message);
  }

  private write(message: JsonRecord): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private enqueue(message: JsonRecord): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(message);
    } else {
      this.events.push(message);
    }
  }
}

/** Newline-delimited stream used by Claude Code's stream-json mode. */
export class JsonLineStream {
  private readonly lines: Interface;
  private readonly events: JsonRecord[] = [];
  private readonly waiters: EventWaiter[] = [];
  private closed = false;

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      if (line.trim().length === 0) {
        return;
      }
      try {
        this.enqueue(parseLine(line, "stdout"));
      } catch (error) {
        this.close(error);
      }
    });
    child.once("error", (error) => this.close(error));
    child.once("exit", () => this.close());
  }

  async next(signal?: AbortSignal): Promise<JsonRecord | null> {
    if (this.events.length > 0) {
      return this.events.shift() ?? null;
    }
    if (this.closed) {
      return null;
    }
    return new Promise<JsonRecord | null>((resolve, reject) => {
      const waiter: EventWaiter = { resolve, reject, signal };
      if (signal !== undefined) {
        if (signal.aborted) {
          resolve(null);
          return;
        }
        const onAbort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          resolve(null);
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  requeue(message: JsonRecord): void {
    this.events.unshift(message);
  }

  close(_error?: unknown): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.lines.close();
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(null);
    }
  }

  private enqueue(message: JsonRecord): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(message);
    } else {
      this.events.push(message);
    }
  }
}

export function asNativePayload(value: unknown): NativeJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => asNativePayload(item));
  }
  if (typeof value === "object") {
    const object: { [key: string]: NativeJson } = {};
    for (const [key, item] of Object.entries(value)) {
      object[key] = asNativePayload(item);
    }
    return object;
  }
  return null;
}
