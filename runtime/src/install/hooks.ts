import type {
  HookEventName,
  InstallScope,
  ManagedHookRecord
} from "../contracts.js";
import {
  buildClaudeHookSettings,
  mergeClaudeSettings,
  stripClaudeManagedHooks
} from "../adapters/claude/config.js";
import {
  buildCodexHookConfig,
  mergeCodexHookConfig,
  stripCodexManagedHooks
} from "../adapters/codex/config.js";
import { AgentOpsError } from "../fs/paths.js";
import type { HarnessId } from "./harness.js";
import type { Capability } from "./types.js";

export const CLAUDE_HOOK_PATH = ".claude/settings.json";
export const CODEX_HOOK_PATH = ".codex/hooks.json";

export interface HookRegistrationPlan {
  readonly record: ManagedHookRecord;
  readonly content: string;
}

function format(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseSettings(
  path: string,
  source: string | null
): unknown {
  if (source === null || source.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new AgentOpsError(
      "HOOK_SETTINGS_INVALID_JSON",
      `Hook settings are not valid JSON: ${path}`,
      { cause: error }
    );
  }
}

export function hookRegistrationPath(
  harness: HarnessId,
  scope: InstallScope
): string {
  // ponytail: user scope resolves against AGENT_OPS_HOME, so the same
  // relative path serves both scopes.
  void scope;
  return harness === "claude" ? CLAUDE_HOOK_PATH : CODEX_HOOK_PATH;
}

/**
 * Builds the merged settings file for one harness, preserving foreign hooks.
 * Returns null when the selected capabilities register no events at all.
 */
export function planHookRegistration(options: {
  readonly harness: HarnessId;
  readonly scope: InstallScope;
  readonly capabilities: readonly Capability[];
  readonly runtimePath: string;
  readonly currentSource: string | null;
}): HookRegistrationPlan | null {
  const path = hookRegistrationPath(options.harness, options.scope);
  const managed =
    options.harness === "claude"
      ? buildClaudeHookSettings(
          options.capabilities,
          options.runtimePath
        )
      : buildCodexHookConfig(
          options.capabilities,
          options.runtimePath
        );
  const events = Object.keys(managed.hooks) as HookEventName[];
  if (events.length === 0) {
    return null;
  }
  const existing = parseSettings(path, options.currentSource);
  const merged =
    options.harness === "claude"
      ? mergeClaudeSettings(
          existing,
          managed as ReturnType<typeof buildClaudeHookSettings>
        )
      : mergeCodexHookConfig(
          existing,
          managed as ReturnType<typeof buildCodexHookConfig>
        );
  return {
    content: format(merged),
    record: {
      id: `${options.harness}-hooks`,
      path,
      harness: options.harness,
      events,
      owner: "agent-ops"
    }
  };
}

export interface HookRemovalPlan {
  readonly path: string;
  readonly content: string | null;
}

function onlyManagedRemains(
  harness: HarnessId,
  value: Record<string, unknown>
): boolean {
  const ownKeys = new Set(
    harness === "codex" ? ["hooks", "description"] : ["hooks"]
  );
  const hooks = value.hooks;
  return (
    Object.keys(value).every((key) => ownKeys.has(key)) &&
    typeof hooks === "object" &&
    hooks !== null &&
    Object.keys(hooks).length === 0
  );
}

/**
 * Strips owned handlers from a hook settings file. The file is removed only
 * when nothing but agent-ops content is left, so foreign settings survive.
 */
export function planHookRemoval(
  record: ManagedHookRecord,
  currentSource: string
): HookRemovalPlan {
  const existing = parseSettings(record.path, currentSource);
  const stripped =
    record.harness === "claude"
      ? stripClaudeManagedHooks(existing)
      : stripCodexManagedHooks(existing);
  return {
    path: record.path,
    content: onlyManagedRemains(record.harness, stripped)
      ? null
      : format(stripped)
  };
}
