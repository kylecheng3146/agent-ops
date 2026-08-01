import type { CapabilityRegistrationSpec } from "../../install/types.js";

export const OPENCODE_SUPPORTED_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "Stop"
] as const;

export type OpencodeSupportedEvent =
  (typeof OPENCODE_SUPPORTED_EVENTS)[number];

/**
 * opencode exposes plugin hooks rather than named lifecycle events. Only
 * `tool.execute.before` is documented as able to stop an action, so blocking
 * outcomes for the other two stay UNKNOWN the way the Codex adapter records
 * unconfirmed native behavior.
 */
export const OPENCODE_PLUGIN_HOOKS: Readonly<
  Record<OpencodeSupportedEvent, string>
> = {
  SessionStart: "plugin-init",
  PreToolUse: "tool.execute.before",
  Stop: "event:session.idle"
};

export const OPENCODE_PRE_TOOL_BLOCKING = "throws" as const;
export const OPENCODE_STOP_BLOCKING = "UNKNOWN" as const;

/**
 * A plugin's factory runs once when opencode starts, not once per session, so
 * SessionStart is a degraded approximation rather than an equivalent.
 */
export const OPENCODE_SESSION_START_FIDELITY = "app-init" as const;

export const OPENCODE_CAPABILITY_REGISTRATIONS = [
  {
    capability: "lifecycle-summary",
    normalizedEvent: "session-start",
    nativeEvent: "SessionStart",
    surfaceId: "opencode-plugin",
    support: "degraded",
    runtimeFailure: "fail-open"
  },
  {
    capability: "command-policy",
    normalizedEvent: "command",
    nativeEvent: "PreToolUse",
    surfaceId: "opencode-plugin",
    support: "supported",
    runtimeFailure: "fail-closed"
  },
  {
    capability: "optional-stop-verify",
    normalizedEvent: "stop",
    nativeEvent: "Stop",
    surfaceId: "opencode-plugin",
    support: "degraded",
    runtimeFailure: "fail-open"
  }
] as const satisfies readonly CapabilityRegistrationSpec[];
