import { homedir } from "node:os";
import { join } from "node:path";

import { AgentOpsError } from "../fs/paths.js";
import {
  localStatePaths,
  readPrivateFile,
  withPrivateFileLock,
  writePrivateFile
} from "../security/permissions.js";
import { redactSecrets } from "../security/redact.js";

export interface DiagnosticLogEvent {
  type: "diagnostic";
  code: string;
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

export interface LoopLogEvent {
  type: "loop-event";
  event:
    | "permission-request"
    | "post-compact"
    | "post-tool-use"
    | "pre-compact"
    | "pre-tool-use"
    | "session-start"
    | "subagent-start"
    | "subagent-stop"
    | "user-prompt-submit";
  outcome: "allowed" | "blocked" | "observed";
  code: string;
}

/** Advisory per-source surface discovery counts (EVIDENCE-SURFACE-001); never evidence. */
export interface SurfaceMetricsLogEvent {
  type: "surface-metrics";
  source: "agent" | "hunk-header" | "template-fragment" | "diff-token" | "review";
  hits: number;
  included: number;
  excluded: number;
  postBlockExclusions: number;
  residualRisks: number;
}

/** Escape Loop: a gate that caught something (SURFACE_*, SCENARIO_MISSING, REVIEW_FAIL, VERIFY_RED_GREEN). Code and task only. */
export interface GateCatchLogEvent {
  type: "gate-catch";
  code: string;
  taskId: string;
}

/** Escape Loop R2: one learned rule fired in a surface gate; rule id and outcome counts only. */
export interface EscapeRuleLogEvent {
  type: "escape-rule";
  ruleId: string;
  included: number;
  excluded: number;
}

export type LocalLogEvent =
  | CommandResultLogEvent
  | EscapeRuleLogEvent
  | GateCatchLogEvent
  | SurfaceMetricsLogEvent
  | DiagnosticLogEvent
  | LoopLogEvent
  | TrustChangeLogEvent;

export interface LocalLogOptions {
  anchorDirectory: string;
  maxAgeMs?: number;
  maxBytes?: number;
  now?: string;
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
      !hasExactKeys(value, ["code", "type"]) ||
      typeof value.code !== "string" ||
      !ID_PATTERN.test(value.code)
    ) {
      return invalidEvent();
    }
    return {
      type: "diagnostic",
      code: value.code
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
  if (value.type === "loop-event") {
    if (
      !hasExactKeys(value, ["code", "event", "outcome", "type"]) ||
      typeof value.code !== "string" ||
      !ID_PATTERN.test(value.code) ||
      ![
        "permission-request",
        "post-compact",
        "post-tool-use",
        "pre-compact",
        "pre-tool-use",
        "session-start",
        "subagent-start",
        "subagent-stop",
        "user-prompt-submit"
      ].includes(String(value.event)) ||
      !["allowed", "blocked", "observed"].includes(
        String(value.outcome)
      )
    ) {
      return invalidEvent();
    }
    return {
      type: "loop-event",
      event: value.event as LoopLogEvent["event"],
      outcome: value.outcome as LoopLogEvent["outcome"],
      code: value.code
    };
  }
  if (value.type === "surface-metrics") {
    const counts = ["excluded", "hits", "included", "postBlockExclusions", "residualRisks"] as const;
    if (
      !hasExactKeys(value, [...counts, "source", "type"]) ||
      !["agent", "hunk-header", "template-fragment", "diff-token", "review"].includes(String(value.source)) ||
      counts.some((key) => !Number.isSafeInteger(value[key]) || (value[key] as number) < 0)
    ) {
      return invalidEvent();
    }
    return {
      type: "surface-metrics",
      source: value.source as SurfaceMetricsLogEvent["source"],
      hits: value.hits as number,
      included: value.included as number,
      excluded: value.excluded as number,
      postBlockExclusions: value.postBlockExclusions as number,
      residualRisks: value.residualRisks as number
    };
  }
  if (value.type === "gate-catch") {
    if (!hasExactKeys(value, ["code", "taskId", "type"]) || typeof value.code !== "string" || !ID_PATTERN.test(value.code) ||
      typeof value.taskId !== "string" || !ID_PATTERN.test(value.taskId)) {
      return invalidEvent();
    }
    return { type: "gate-catch", code: value.code, taskId: value.taskId };
  }
  if (value.type === "escape-rule") {
    if (!hasExactKeys(value, ["excluded", "included", "ruleId", "type"]) || typeof value.ruleId !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(value.ruleId) ||
      [value.included, value.excluded].some((n) => !Number.isSafeInteger(n) || (n as number) < 0)) {
      return invalidEvent();
    }
    return { type: "escape-rule", ruleId: value.ruleId, included: value.included as number, excluded: value.excluded as number };
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
  options: LocalLogOptions
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

  await withPrivateFileLock(
    path,
    options.anchorDirectory,
    async () => {
      const source = await readPrivateFile(
        path,
        options.anchorDirectory
      );
      const retained =
        source === null || source.length === 0
          ? []
          : source
              .split("\n")
              .filter((line) => line.length > 0)
              .map(parseStoredLine)
              .filter(
                (entry) =>
                  nowMs - Date.parse(entry.timestamp) <= maxAgeMs
              );
      retained.push(storedEvent);

      const serialized = retained.map(serialize);
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
      await writePrivateFile(
        path,
        serialized.join(""),
        options.anchorDirectory
      );
    }
  );
}

/** Advisory and fail-open: a logging fault never changes the gate that caught something. */
export async function logGateCatch(code: string, taskId: string, home = process.env.AGENT_OPS_HOME ?? homedir()): Promise<void> {
  try {
    const state = localStatePaths(home);
    await appendLocalLog(join(state.logDirectory, "events.ndjson"), {type: "gate-catch", code, taskId}, {anchorDirectory: state.anchorDirectory});
  } catch { /* advisory only */ }
}

/** Read-only and fail-open for reports: unreadable lines are skipped, a missing log is empty. */
export async function readLocalLog(home = process.env.AGENT_OPS_HOME ?? homedir()): Promise<{ timestamp: string; event: LocalLogEvent }[]> {
  try {
    const state = localStatePaths(home);
    const source = await readPrivateFile(join(state.logDirectory, "events.ndjson"), state.anchorDirectory);
    return (source ?? "").split("\n").filter(Boolean).flatMap((line) => {
      try { return [parseStoredLine(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}
