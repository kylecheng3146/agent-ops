import { AgentOpsError } from "../fs/paths.js";
import {
  readPrivateFile,
  writePrivateFile
} from "../security/permissions.js";
import { redactSecrets } from "../security/redact.js";

export interface DiagnosticLogEvent {
  type: "diagnostic";
  code: string;
  message: string;
}

export interface CommandResultLogEvent {
  type: "command-result";
  commandId: string;
  status: "FAIL" | "PASS" | "UNKNOWN";
  exitCode: number | null;
  durationMs: number;
}

export interface TrustChangeLogEvent {
  type: "trust-change";
  action: "grant" | "revoke";
  remoteIdentity: string;
  result: "changed" | "unchanged";
}

export type LocalLogEvent =
  | CommandResultLogEvent
  | DiagnosticLogEvent
  | TrustChangeLogEvent;

export interface LocalLogOptions {
  now?: string;
  maxAgeMs?: number;
  maxBytes?: number;
}

interface StoredEvent {
  timestamp: string;
  event: LocalLogEvent;
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected]
      .sort()
      .every((key, index) => actual[index] === key)
  );
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    value.length > 0 &&
    value.length <= 4096
  );
}

function invalidEvent(): never {
  throw new AgentOpsError(
    "LOG_EVENT_INVALID",
    "Local log event contains unsupported or invalid fields."
  );
}

function sanitizeEvent(value: unknown): LocalLogEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    return invalidEvent();
  }
  if (value.type === "diagnostic") {
    if (
      !hasExactKeys(value, ["code", "message", "type"]) ||
      typeof value.code !== "string" ||
      !ID_PATTERN.test(value.code) ||
      !isBoundedString(value.message)
    ) {
      return invalidEvent();
    }
    return {
      type: "diagnostic",
      code: value.code,
      message: redactSecrets(value.message)
    };
  }
  if (value.type === "command-result") {
    if (
      !hasExactKeys(value, [
        "commandId",
        "durationMs",
        "exitCode",
        "status",
        "type"
      ]) ||
      typeof value.commandId !== "string" ||
      !ID_PATTERN.test(value.commandId) ||
      !["FAIL", "PASS", "UNKNOWN"].includes(String(value.status)) ||
      (value.exitCode !== null &&
        (!Number.isSafeInteger(value.exitCode) ||
          (value.exitCode as number) < 0)) ||
      !Number.isSafeInteger(value.durationMs) ||
      (value.durationMs as number) < 0
    ) {
      return invalidEvent();
    }
    return {
      type: "command-result",
      commandId: value.commandId,
      status: value.status as CommandResultLogEvent["status"],
      exitCode: value.exitCode as number | null,
      durationMs: value.durationMs as number
    };
  }
  if (value.type === "trust-change") {
    if (
      !hasExactKeys(value, [
        "action",
        "remoteIdentity",
        "result",
        "type"
      ]) ||
      !["grant", "revoke"].includes(String(value.action)) ||
      !isBoundedString(value.remoteIdentity) ||
      !["changed", "unchanged"].includes(String(value.result))
    ) {
      return invalidEvent();
    }
    return {
      type: "trust-change",
      action: value.action as TrustChangeLogEvent["action"],
      remoteIdentity: redactSecrets(value.remoteIdentity),
      result: value.result as TrustChangeLogEvent["result"]
    };
  }
  return invalidEvent();
}

function serialize(stored: StoredEvent): string {
  return `${JSON.stringify({
    timestamp: stored.timestamp,
    ...stored.event
  })}\n`;
}

function parseStoredLine(line: string): StoredEvent {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new AgentOpsError(
      "LOG_CORRUPT",
      "Local log contains invalid JSON.",
      { cause: error }
    );
  }
  if (
    !isRecord(value) ||
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp))
  ) {
    throw new AgentOpsError(
      "LOG_CORRUPT",
      "Local log contains an invalid timestamp."
    );
  }
  const { timestamp, ...event } = value;
  return {
    timestamp,
    event: sanitizeEvent(event)
  };
}

function positiveOption(
  value: number | undefined,
  fallback: number
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgentOpsError(
      "LOG_RETENTION_INVALID",
      "Local log retention limits must be positive integers."
    );
  }
  return value;
}

export async function appendLocalLog(
  path: string,
  event: LocalLogEvent,
  options: LocalLogOptions = {}
): Promise<void> {
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    throw new AgentOpsError(
      "LOG_TIMESTAMP_INVALID",
      "Local log timestamp must be ISO-compatible."
    );
  }
  const maxAgeMs = positiveOption(
    options.maxAgeMs,
    DEFAULT_MAX_AGE_MS
  );
  const maxBytes = positiveOption(options.maxBytes, DEFAULT_MAX_BYTES);
  const storedEvent: StoredEvent = {
    timestamp: now,
    event: sanitizeEvent(event)
  };
  const newLine = serialize(storedEvent);
  if (Buffer.byteLength(newLine) > maxBytes) {
    throw new AgentOpsError(
      "LOG_EVENT_TOO_LARGE",
      "Local log event exceeds the configured byte limit."
    );
  }

  const source = await readPrivateFile(path);
  const retained =
    source === null || source.length === 0
      ? []
      : source
          .split("\n")
          .filter((line) => line.length > 0)
          .map(parseStoredLine)
          .filter(
            (entry) => nowMs - Date.parse(entry.timestamp) <= maxAgeMs
          );
  retained.push(storedEvent);

  let serialized = retained.map(serialize);
  let totalBytes = serialized.reduce(
    (total, line) => total + Buffer.byteLength(line),
    0
  );
  while (serialized.length > 1 && totalBytes > maxBytes) {
    const removed = serialized.shift();
    if (removed !== undefined) {
      totalBytes -= Buffer.byteLength(removed);
    }
  }
  await writePrivateFile(path, serialized.join(""));
}
