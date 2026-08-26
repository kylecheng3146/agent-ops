import type {
  HarnessId,
  HookEventName,
  InstallScope,
  ManagedHookRecord
} from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";
import { harnessDescriptor, harnessHookPath } from "./harness.js";
import type { Capability } from "./types.js";

export const CLAUDE_HOOK_PATH = ".claude/settings.json";
export const CODEX_HOOK_PATH = ".codex/hooks.json";

export interface HookRegistrationPlan {
  readonly record: ManagedHookRecord;
  readonly content: string;
  readonly disclosure: "opaque";
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
  scope: InstallScope,
  root?: string
): string {
  // ponytail: user scope resolves against AGENT_OPS_HOME, so the same
  // root can resolve a scope-specific harness path.
  return harnessHookPath(harness, scope, root);
}

/**
 * Builds the merged settings file for one harness, preserving foreign hooks.
 * Returns null when the selected capabilities register no events at all.
 */
export function planHookRegistration(options: {
  readonly harness: HarnessId;
  readonly scope: InstallScope;
  readonly path?: string;
  readonly capabilities: readonly Capability[];
  readonly runtimePath: string;
  readonly platform?: NodeJS.Platform;
  readonly currentSource: string | null;
}): HookRegistrationPlan | null {
  const descriptor = harnessDescriptor(options.harness);
  if (
    descriptor.control.buildHooks === undefined ||
    descriptor.control.mergeHooks === undefined
  ) {
    // File-backed adapters (currently opencode) track their plugin as a
    // managed artifact rather than as a ManagedHookRecord.
    return null;
  }
  const path = options.path ?? hookRegistrationPath(options.harness, options.scope);
  const managed = descriptor.control.buildHooks(
    options.capabilities,
    options.runtimePath,
    options.platform
  );
  const events = Object.keys(managed.hooks) as HookEventName[];
  if (events.length === 0) {
    return null;
  }
  const existing = parseSettings(path, options.currentSource);
  const merged = descriptor.control.mergeHooks(existing, managed);
  return {
    content: format(merged),
    disclosure: "opaque",
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
  readonly disclosure: "opaque";
}

function onlyManagedRemains(
  harness: HarnessId,
  value: Record<string, unknown>
): boolean {
  const ownKeys = new Set(
    harnessDescriptor(harness).control.ownSettingsKeys ?? []
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
  const descriptor = harnessDescriptor(record.harness);
  if (descriptor.control.stripHooks === undefined) {
    throw new AgentOpsError(
      "HOOK_REMOVAL_UNSUPPORTED",
      `Harness hook records are not supported for ${record.harness}.`
    );
  }
  const existing = parseSettings(record.path, currentSource);
  const stripped = descriptor.control.stripHooks(existing);
  return {
    path: record.path,
    disclosure: "opaque",
    content: onlyManagedRemains(record.harness, stripped)
      ? null
      : format(stripped)
  };
}
