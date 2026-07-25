import type { InstallScope } from "../../contracts.js";
import { AgentOpsError } from "../../fs/paths.js";
import type { Capability } from "../../install/types.js";
import type { ClaudeSupportedEvent } from "./events.js";

interface ClaudeCommandHook {
  readonly type: "command";
  readonly command: "node";
  readonly args: readonly string[];
  readonly timeout: number;
}

interface ClaudeMatcherGroup {
  readonly matcher?: string;
  readonly hooks: readonly ClaudeCommandHook[];
}

export interface ClaudeHookSettings {
  readonly hooks: Readonly<Record<string, readonly ClaudeMatcherGroup[]>>;
  readonly [key: string]: unknown;
}

export interface ClaudeSettingsTarget {
  readonly path:
    | ".claude/settings.json"
    | "~/.claude/settings.json";
  readonly requiresWorkspaceTrust: boolean;
}

export function claudeSettingsTarget(
  scope: InstallScope
): ClaudeSettingsTarget {
  return scope === "project"
    ? {
        path: ".claude/settings.json",
        requiresWorkspaceTrust: true
      }
    : {
        path: "~/.claude/settings.json",
        requiresWorkspaceTrust: false
      };
}

export function claudeRoutingBlock(): string {
  return [
    "## Loop Engineering",
    "",
    "Load `.agent-ops/CLAUDE.md` as concise project context.",
    ""
  ].join("\n");
}

function commandHook(
  event: ClaudeSupportedEvent,
  runtimePath: string
): ClaudeCommandHook {
  return {
    type: "command",
    command: "node",
    args: [runtimePath, "claude", event],
    timeout: 30
  };
}

function matcherGroup(
  event: ClaudeSupportedEvent,
  runtimePath: string
): ClaudeMatcherGroup {
  return {
    ...(event === "PreToolUse" ? { matcher: "Bash" } : {}),
    hooks: [commandHook(event, runtimePath)]
  };
}

export function buildClaudeHookSettings(
  capabilities: readonly Capability[],
  runtimePath: string
): ClaudeHookSettings {
  if (
    runtimePath.length === 0 ||
    runtimePath.length > 4096 ||
    runtimePath.includes("\0")
  ) {
    throw new AgentOpsError(
      "CLAUDE_HOOK_PATH_INVALID",
      "Claude hook runtime path is invalid."
    );
  }
  const hooks: Record<string, readonly ClaudeMatcherGroup[]> = {};
  if (capabilities.includes("lifecycle-summary")) {
    hooks.SessionStart = [matcherGroup("SessionStart", runtimePath)];
  }
  if (capabilities.includes("command-policy")) {
    hooks.PreToolUse = [matcherGroup("PreToolUse", runtimePath)];
  }
  if (capabilities.includes("optional-stop-verify")) {
    hooks.Stop = [matcherGroup("Stop", runtimePath)];
  }
  return { hooks };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOwnedGroup(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.hooks)) {
    return false;
  }
  return value.hooks.some((handler) => {
    if (
      !isRecord(handler) ||
      handler.command !== "node" ||
      !Array.isArray(handler.args)
    ) {
      return false;
    }
    return (
      handler.args[1] === "claude" &&
      typeof handler.args[2] === "string"
    );
  });
}

function hookRecord(
  settings: Record<string, unknown>
): Record<string, readonly unknown[]> {
  if (settings.hooks === undefined) {
    return {};
  }
  if (
    !isRecord(settings.hooks) ||
    Object.values(settings.hooks).some((groups) => !Array.isArray(groups))
  ) {
    throw new AgentOpsError(
      "CLAUDE_SETTINGS_INVALID",
      "Claude hook groups must be arrays."
    );
  }
  return settings.hooks as Record<string, readonly unknown[]>;
}

export function mergeClaudeSettings(
  existing: unknown,
  managed: ClaudeHookSettings
): ClaudeHookSettings {
  if (!isRecord(existing)) {
    throw new AgentOpsError(
      "CLAUDE_SETTINGS_INVALID",
      "Claude settings must be a JSON object."
    );
  }
  const existingHooks = hookRecord(existing);
  const hooks: Record<string, readonly ClaudeMatcherGroup[]> = {};
  const eventNames = new Set([
    ...Object.keys(existingHooks),
    ...Object.keys(managed.hooks)
  ]);
  for (const eventName of eventNames) {
    const preserved = (existingHooks[eventName] ?? []).filter(
      (group) => !isOwnedGroup(group)
    ) as ClaudeMatcherGroup[];
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
