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

const COMMAND_PREFIX = "agent-ops hook codex ";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandHook(event: CodexSupportedEvent): CodexCommandHook {
  const command = `${COMMAND_PREFIX}${event}`;
  return {
    type: "command",
    command,
    commandWindows: command,
    timeout: 30,
    statusMessage: `Running agent-ops ${event}`
  };
}

function matcherGroup(event: CodexSupportedEvent): CodexMatcherGroup {
  return {
    ...(event === "PreToolUse" ? { matcher: "^Bash$" } : {}),
    hooks: [commandHook(event)]
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
  capabilities: readonly Capability[]
): CodexHookConfig {
  const hooks: Record<string, readonly CodexMatcherGroup[]> = {};
  if (capabilities.includes("lifecycle-summary")) {
    hooks.SessionStart = [matcherGroup("SessionStart")];
  }
  if (capabilities.includes("command-policy")) {
    hooks.PreToolUse = [matcherGroup("PreToolUse")];
  }
  if (capabilities.includes("optional-stop-verify")) {
    hooks.Stop = [matcherGroup("Stop")];
  }
  return {
    description: "Portable agent-ops lifecycle hooks.",
    hooks
  };
}

function isOwnedGroup(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.hooks)) {
    return false;
  }
  return value.hooks.some(
    (hook) =>
      isRecord(hook) &&
      typeof hook.command === "string" &&
      hook.command.startsWith(COMMAND_PREFIX)
  );
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
    const preserved = (existingHooks[eventName] ?? []).filter(
      (group) => !isOwnedGroup(group)
    ) as CodexMatcherGroup[];
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
