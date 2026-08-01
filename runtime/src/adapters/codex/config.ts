import type { InstallScope } from "../../contracts.js";
import { AgentOpsError } from "../../fs/paths.js";
import type { Capability } from "../../install/types.js";
import type { CodexSupportedEvent } from "./events.js";

interface CodexCommandHook {
  readonly type: "command";
  readonly command: string;
  readonly commandWindows: string;
  readonly timeout: number;
  readonly statusMessage: string;
}

interface CodexMatcherGroup {
  readonly matcher?: string;
  readonly hooks: readonly CodexCommandHook[];
}

export interface CodexHookConfig {
  readonly description?: unknown;
  readonly hooks: Readonly<Record<string, readonly CodexMatcherGroup[]>>;
  readonly [key: string]: unknown;
}

export interface CodexHookTarget {
  readonly path: ".codex/hooks.json";
  readonly representation: "json";
  readonly requiresProjectTrust: boolean;
}

export const CODEX_MANAGED_MARKER = "--managed-by=agent-ops";

/**
 * Releases up to 0.1.4 registered a bare `agent-ops` command resolved through
 * PATH. Detection still recognizes it so an update replaces it instead of
 * leaving the hijackable handler behind.
 */
const LEGACY_COMMAND_PREFIX = "agent-ops hook codex ";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRuntimePath(runtimePath: string): void {
  if (
    runtimePath.length === 0 ||
    runtimePath.length > 4096 ||
    runtimePath.includes("\0") ||
    // The command is a single shell string, so a quote would break the
    // argument boundary the surrounding quotes establish.
    runtimePath.includes('"')
  ) {
    throw new AgentOpsError(
      "CODEX_HOOK_PATH_INVALID",
      "Codex hook runtime path is invalid."
    );
  }
}

function commandHook(
  event: CodexSupportedEvent,
  runtimePath: string
): CodexCommandHook {
  const command =
    `node "${runtimePath}" codex ${event} ${CODEX_MANAGED_MARKER}`;
  return {
    type: "command",
    command,
    commandWindows: command,
    timeout: 30,
    statusMessage: `Running agent-ops ${event}`
  };
}

function matcherGroup(
  event: CodexSupportedEvent,
  runtimePath: string
): CodexMatcherGroup {
  return {
    ...(event === "PreToolUse" ? { matcher: "^Bash$" } : {}),
    hooks: [commandHook(event, runtimePath)]
  };
}

export function codexHookTarget(scope: InstallScope): CodexHookTarget {
  return {
    path: ".codex/hooks.json",
    representation: "json",
    requiresProjectTrust: scope === "project"
  };
}

export function buildCodexHookConfig(
  capabilities: readonly Capability[],
  runtimePath: string
): CodexHookConfig {
  assertRuntimePath(runtimePath);
  const hooks: Record<string, readonly CodexMatcherGroup[]> = {};
  if (capabilities.includes("lifecycle-summary")) {
    hooks.SessionStart = [matcherGroup("SessionStart", runtimePath)];
  }
  if (capabilities.includes("command-policy")) {
    hooks.PreToolUse = [matcherGroup("PreToolUse", runtimePath)];
  }
  if (capabilities.includes("optional-stop-verify")) {
    hooks.Stop = [matcherGroup("Stop", runtimePath)];
  }
  return {
    description: "agent-ops lifecycle hooks.",
    hooks
  };
}

function isOwnedHandler(hook: unknown): boolean {
  return (
    isRecord(hook) &&
    typeof hook.command === "string" &&
    (hook.command.includes(CODEX_MANAGED_MARKER) ||
      hook.command.startsWith(LEGACY_COMMAND_PREFIX))
  );
}

function withoutOwnedHandlers(value: unknown): unknown | null {
  if (!isRecord(value) || !Array.isArray(value.hooks)) {
    return value;
  }
  const hooks = value.hooks.filter(
    (hook) => !isOwnedHandler(hook)
  );
  return hooks.length === 0 ? null : { ...value, hooks };
}

function hookRecord(
  value: unknown
): Record<string, readonly unknown[]> {
  if (!isRecord(value)) {
    throw new AgentOpsError(
      "CODEX_HOOK_CONFIG_INVALID",
      "Codex hook configuration must be a JSON object."
    );
  }
  if (value.hooks === undefined) {
    return {};
  }
  if (
    !isRecord(value.hooks) ||
    Object.values(value.hooks).some((groups) => !Array.isArray(groups))
  ) {
    throw new AgentOpsError(
      "CODEX_HOOK_CONFIG_INVALID",
      "Codex hook groups must be arrays."
    );
  }
  return value.hooks as Record<string, readonly unknown[]>;
}

/**
 * Removes every agent-ops owned handler and leaves foreign hooks untouched.
 */
export function stripCodexManagedHooks(
  existing: unknown
): CodexHookConfig {
  const existingHooks = hookRecord(existing);
  const hooks: Record<string, readonly CodexMatcherGroup[]> = {};
  for (const [eventName, groups] of Object.entries(existingHooks)) {
    const preserved = groups
      .map(withoutOwnedHandlers)
      .filter((group) => group !== null) as CodexMatcherGroup[];
    if (preserved.length > 0) {
      hooks[eventName] = preserved;
    }
  }
  return { ...(existing as Record<string, unknown>), hooks };
}

export function mergeCodexHookConfig(
  existing: unknown,
  managed: CodexHookConfig
): CodexHookConfig {
  if (!isRecord(existing)) {
    throw new AgentOpsError(
      "CODEX_HOOK_CONFIG_INVALID",
      "Codex hook configuration must be a JSON object."
    );
  }
  const existingHooks = hookRecord(existing);
  const hooks: Record<string, readonly CodexMatcherGroup[]> = {};
  const eventNames = new Set([
    ...Object.keys(existingHooks),
    ...Object.keys(managed.hooks)
  ]);
  for (const eventName of eventNames) {
    const preserved = (existingHooks[eventName] ?? [])
      .map(withoutOwnedHandlers)
      .filter((group) => group !== null) as CodexMatcherGroup[];
    const additions = managed.hooks[eventName] ?? [];
    if (preserved.length > 0 || additions.length > 0) {
      hooks[eventName] = [...preserved, ...additions];
    }
  }
  return {
    ...existing,
    hooks
  };
}
