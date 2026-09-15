import type { InstallScope } from "../../contracts.js";
import { AgentOpsError } from "../../fs/paths.js";
import type { Capability } from "../../install/types.js";
import type { ClaudeSupportedEvent } from "./events.js";

interface ClaudeCommandHook {
  readonly type: "command";
  readonly command: string;
  readonly args?: readonly string[];
  readonly shell?: "powershell";
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

const CLAUDE_LOOP_EVENTS: readonly ClaudeSupportedEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop"
];
const CLAUDE_HOOK_MARKER = "--managed-by=agent-ops";
const CLAUDE_LOOP_LAUNCHER =
  "${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-ops-loop.sh";
const CLAUDE_WINDOWS_LOOP_LAUNCHER =
  "${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-ops-loop.ps1";

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

/**
 * The gate flag trails the ownership marker rather than preceding it, unlike
 * agy's flat command string. The marker's position is what identifies a
 * managed handler here, and moving it would make every existing installation
 * read as foreign.
 */
function commandHook(
  event: ClaudeSupportedEvent,
  runtimePath: string,
  completionGate = false
): ClaudeCommandHook {
  return {
    type: "command",
    command: "node",
    args: [
      runtimePath,
      "claude",
      event,
      CLAUDE_HOOK_MARKER,
      ...(completionGate ? ["--completion-gate"] : [])
    ],
    timeout: 30
  };
}

function matcherGroup(
  event: ClaudeSupportedEvent,
  runtimePath: string,
  completionGate = false
): ClaudeMatcherGroup {
  return {
    ...(event === "PreToolUse" ? { matcher: "Bash" } : {}),
    hooks: [commandHook(event, runtimePath, completionGate)]
  };
}

function powershellLoopCommand(event: ClaudeSupportedEvent): string {
  return `& "${CLAUDE_WINDOWS_LOOP_LAUNCHER}" "${event}" "${CLAUDE_HOOK_MARKER}"`;
}

function loopMatcherGroup(
  event: ClaudeSupportedEvent,
  platform: NodeJS.Platform
): ClaudeMatcherGroup {
  const hook: ClaudeCommandHook =
    platform === "win32"
      ? {
          type: "command",
          shell: "powershell",
          command: powershellLoopCommand(event),
          timeout: 30
        }
      : {
          type: "command",
          command: "bash",
          args: [
            CLAUDE_LOOP_LAUNCHER,
            event,
            CLAUDE_HOOK_MARKER
          ],
          timeout: 30
        };
  return {
    ...(event === "PreToolUse" || event === "PermissionRequest"
      ? { matcher: "Bash" }
      : {}),
    hooks: [hook]
  };
}

export function buildClaudeHookSettings(
  capabilities: readonly Capability[],
  runtimePath: string,
  platform: NodeJS.Platform = process.platform
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
  if (capabilities.includes("project-loop")) {
    for (const event of CLAUDE_LOOP_EVENTS) {
      hooks[event] = [loopMatcherGroup(event, platform)];
    }
    // The loop launcher runs a different process, and the completion gate does
    // not live there. Its PreToolUse role is narrow but load-bearing: it is
    // what turns a self-issued `allow-stop` into a question for the user, so
    // the gate needs a handler of its own beside the loop's.
    if (capabilities.includes("completion-gate")) {
      // SessionStart for the same reason: the gate records its per-session
      // baseline there, and a gate that never sees a session start refuses
      // every stop as uninitialized.
      for (const event of ["SessionStart", "PreToolUse"] as const) {
        hooks[event] = [
          ...(hooks[event] ?? []),
          matcherGroup(event, runtimePath)
        ];
      }
    }
  } else {
    if (capabilities.includes("lifecycle-summary")) {
      hooks.SessionStart = [matcherGroup("SessionStart", runtimePath)];
    }
    if (capabilities.includes("command-policy")) {
      hooks.PreToolUse = [matcherGroup("PreToolUse", runtimePath)];
    }
  }
  // The gate supersedes report-only Stop verification: one managed Stop
  // handler, and the gated one already reports everything the other would.
  if (capabilities.includes("completion-gate")) {
    hooks.Stop = [matcherGroup("Stop", runtimePath, true)];
  } else if (capabilities.includes("optional-stop-verify")) {
    hooks.Stop = [matcherGroup("Stop", runtimePath)];
  }
  return { hooks };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The argument vector `commandHook` produces, and nothing else. The ownership
 * marker alone is not proof: it is a plain string anyone may write, and a
 * handler mistaken for ours is a handler `update` rewrites and `uninstall`
 * deletes.
 */
function isManagedNodeArgs(args: unknown): boolean {
  if (!Array.isArray(args) || args.length < 4 || args.length > 5) {
    return false;
  }
  const [runtimePath, harness, event, marker, gate] = args as readonly unknown[];
  // The event is checked for shape, not membership: a handler an older
  // agent-ops wrote for an event this version no longer knows is still ours to
  // remove, and rejecting it would orphan it in the user's settings forever.
  return (
    typeof runtimePath === "string" &&
    runtimePath.length > 0 &&
    harness === "claude" &&
    typeof event === "string" &&
    event.length > 0 &&
    marker === CLAUDE_HOOK_MARKER &&
    (gate === undefined || gate === "--completion-gate")
  );
}

/**
 * Matches only the two command shapes agent-ops actually generates. This is
 * reused by installation inspection so a foreign hook cannot masquerade as
 * ours merely by carrying the marker string.
 */
export function isClaudeManagedHandler(handler: unknown): boolean {
  if (!isRecord(handler) || handler.type !== "command") {
    return false;
  }
  return (
    (handler.command === "node" &&
      isManagedNodeArgs(handler.args)) ||
    (handler.command === "bash" &&
      Array.isArray(handler.args) &&
      handler.args.length === 3 &&
      handler.args[0] === CLAUDE_LOOP_LAUNCHER &&
      CLAUDE_LOOP_EVENTS.includes(handler.args[1] as ClaudeSupportedEvent) &&
      handler.args[2] === CLAUDE_HOOK_MARKER) ||
    (handler.shell === "powershell" &&
      handler.args === undefined &&
      typeof handler.command === "string" &&
      CLAUDE_LOOP_EVENTS.some(
        (event) => handler.command === powershellLoopCommand(event)
      ))
  );
}

function withoutOwnedHandlers(value: unknown): unknown | null {
  if (!isRecord(value) || !Array.isArray(value.hooks)) {
    return value;
  }
  const hooks = value.hooks.filter(
    (handler) => !isClaudeManagedHandler(handler)
  );
  return hooks.length === 0 ? null : { ...value, hooks };
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

/**
 * Removes every agent-ops owned handler and leaves foreign hooks untouched.
 */
export function stripClaudeManagedHooks(
  existing: unknown
): ClaudeHookSettings {
  if (!isRecord(existing)) {
    throw new AgentOpsError(
      "CLAUDE_SETTINGS_INVALID",
      "Claude settings must be a JSON object."
    );
  }
  const existingHooks = hookRecord(existing);
  const hooks: Record<string, readonly ClaudeMatcherGroup[]> = {};
  for (const [eventName, groups] of Object.entries(existingHooks)) {
    const preserved = groups
      .map(withoutOwnedHandlers)
      .filter((group) => group !== null) as ClaudeMatcherGroup[];
    if (preserved.length > 0) {
      hooks[eventName] = preserved;
    }
  }
  return { ...existing, hooks };
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
    const preserved = (existingHooks[eventName] ?? [])
      .map(withoutOwnedHandlers)
      .filter((group) => group !== null) as ClaudeMatcherGroup[];
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
