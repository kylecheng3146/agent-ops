import { AgentOpsError } from "../../fs/paths.js";
import type { Capability } from "../../install/types.js";

const MARKER = "--managed-by=agent-ops";

interface Handler {
  readonly type: "command";
  readonly command: string;
  readonly timeout: number;
}

export interface AgyHookSettings {
  readonly hooks: Readonly<Record<string, readonly unknown[]>>;
  readonly [key: string]: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function handler(
  runtimePath: string,
  event: "SessionStart" | "PreToolUse" | "Stop",
  platform: NodeJS.Platform,
  completionGate = false
): Handler {
  const gateFlag = completionGate ? " --completion-gate" : "";
  const command = platform === "win32"
    ? `cmd /c node ${JSON.stringify(runtimePath).replaceAll("\\\\", "\\")} agy ${event}${gateFlag} ${MARKER}`
    : `node ${JSON.stringify(runtimePath)} agy ${event}${gateFlag} ${MARKER}`;
  return {
    type: "command",
    command,
    timeout: 30
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function managedHandler(value: unknown, event: "SessionStart" | "PreToolUse" | "Stop"): boolean {
  const candidate = record(value);
  return candidate !== null &&
    exactKeys(candidate, ["type", "command", "timeout"]) &&
    candidate.type === "command" &&
    candidate.timeout === 30 &&
    typeof candidate.command === "string" &&
    (candidate.command.startsWith("node \"") ||
      candidate.command.startsWith("cmd /c node \"")) &&
    (candidate.command.endsWith(` agy ${event} ${MARKER}`) ||
      (event === "Stop" &&
        candidate.command.endsWith(` agy Stop --completion-gate ${MARKER}`)));
}

function managedEvent(value: unknown, event: "PreInvocation" | "PreToolUse" | "Stop"): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  if (event !== "PreToolUse") {
    return managedHandler(value[0], event === "PreInvocation" ? "SessionStart" : "Stop");
  }
  const group = record(value[0]);
  return group !== null &&
    exactKeys(group, ["matcher", "hooks"]) &&
    group.matcher === "run_command" &&
    Array.isArray(group.hooks) &&
    group.hooks.length === 1 &&
    managedHandler(group.hooks[0], "PreToolUse");
}

export function buildAgyHookSettings(
  capabilities: readonly Capability[],
  runtimePath: string,
  platform: NodeJS.Platform = process.platform
): AgyHookSettings {
  if (
    runtimePath.length === 0 ||
    runtimePath.length > 4096 ||
    /[\0\r\n]/u.test(runtimePath) ||
    (platform === "win32" && runtimePath.includes('"'))
  ) {
    throw new AgentOpsError("AGY_HOOK_PATH_INVALID", "agy hook runtime path is invalid.");
  }
  const hooks: Record<string, readonly unknown[]> = {};
  if (capabilities.includes("lifecycle-summary") || capabilities.includes("project-loop")) {
    hooks.PreInvocation = [handler(runtimePath, "SessionStart", platform)];
  }
  if (capabilities.includes("command-policy") || capabilities.includes("project-loop")) {
    hooks.PreToolUse = [{ matcher: "run_command", hooks: [handler(runtimePath, "PreToolUse", platform)] }];
  }
  if (
    capabilities.includes("optional-stop-verify") ||
    capabilities.includes("completion-gate")
  ) {
    hooks.Stop = [handler(
      runtimePath,
      "Stop",
      platform,
      capabilities.includes("completion-gate")
    )];
  }
  return { hooks };
}

export function isAgyManagedHook(value: unknown): boolean {
  const named = record(value)?.["agent-ops"];
  const hook = record(named);
  if (hook === null || hook.enabled !== true) return false;
  const events = Object.keys(hook).filter((key) => key !== "enabled");
  return events.length > 0 &&
    events.every((event) =>
      (event === "PreInvocation" || event === "PreToolUse" || event === "Stop") &&
      managedEvent(hook[event], event)
    );
}

export function isAgyHookRegistered(
  value: unknown,
  capabilities: readonly Capability[]
): boolean {
  const expected = buildAgyHookSettings(capabilities, "probe").hooks;
  if (Object.keys(expected).length === 0) return true;
  const named = record(record(value)?.["agent-ops"]);
  if (named === null || !isAgyManagedHook(value)) return false;
  const eventsMatch = Object.keys(expected)
    .every((event) => managedEvent(
      named[event],
      event as "PreInvocation" | "PreToolUse" | "Stop"
    ));
  if (!eventsMatch || !capabilities.includes("completion-gate")) {
    return eventsMatch;
  }
  const stop = Array.isArray(named.Stop) ? record(named.Stop[0]) : null;
  return typeof stop?.command === "string" &&
    stop.command.endsWith(` agy Stop --completion-gate ${MARKER}`);
}

export function mergeAgyHooks(existing: unknown, managed: AgyHookSettings): Record<string, unknown> {
  const source = record(existing);
  if (source === null) {
    throw new AgentOpsError("AGY_HOOKS_INVALID", "agy hooks must be a JSON object.");
  }
  if (source["agent-ops"] !== undefined && !isAgyManagedHook(source)) {
    throw new AgentOpsError(
      "AGY_HOOK_NAME_CONFLICT",
      "Refusing to replace the existing non-agent-ops hook named agent-ops."
    );
  }
  return { ...source, "agent-ops": { enabled: true, ...managed.hooks } };
}

export function stripAgyHooks(existing: unknown): Record<string, unknown> {
  const source = record(existing);
  if (source === null) {
    throw new AgentOpsError("AGY_HOOKS_INVALID", "agy hooks must be a JSON object.");
  }
  if (source["agent-ops"] !== undefined && !isAgyManagedHook(source)) {
    throw new AgentOpsError("AGY_HOOK_NAME_CONFLICT", "The agent-ops hook is not owned by agent-ops.");
  }
  const { "agent-ops": _owned, ...rest } = source;
  return rest;
}
