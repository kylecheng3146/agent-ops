import type { CapabilityRegistrationSpec } from "../../install/types.js";

export const CLAUDE_SUPPORTED_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "Stop"
] as const;

export type ClaudeSupportedEvent =
  (typeof CLAUDE_SUPPORTED_EVENTS)[number];

export type ClaudeNonInteractiveTrust =
  | "dialog-skipped"
  | "interactive-dialog";

export function claudeNonInteractiveTrust(
  printMode: boolean
): ClaudeNonInteractiveTrust {
  return printMode ? "dialog-skipped" : "interactive-dialog";
}

export const CLAUDE_CAPABILITY_REGISTRATIONS = [
  {
    capability: "lifecycle-summary",
    normalizedEvent: "session-start",
    nativeEvent: "SessionStart",
    surfaceId: "claude-settings",
    support: "unsupported",
    runtimeFailure: "fail-open"
  },
  {
    capability: "command-policy",
    normalizedEvent: "command",
    nativeEvent: "PreToolUse",
    surfaceId: "claude-settings",
    support: "supported",
    runtimeFailure: "fail-closed"
  },
  {
    capability: "optional-stop-verify",
    normalizedEvent: "stop",
    nativeEvent: "Stop",
    surfaceId: "claude-settings",
    support: "unsupported",
    runtimeFailure: "fail-open"
  }
] as const satisfies readonly CapabilityRegistrationSpec[];
