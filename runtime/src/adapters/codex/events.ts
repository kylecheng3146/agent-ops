import type { CapabilityRegistrationSpec } from "../../install/types.js";

export const CODEX_SUPPORTED_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "Stop"
] as const;

export type CodexSupportedEvent =
  (typeof CODEX_SUPPORTED_EVENTS)[number];

export type CodexMatcherSupport = "tool-name" | "unsupported";

export function codexMatcherSupport(
  event: string
): CodexMatcherSupport {
  return event === "PreToolUse" ? "tool-name" : "unsupported";
}

export const CODEX_CAPABILITY_REGISTRATIONS = [
  {
    capability: "lifecycle-summary",
    normalizedEvent: "session-start",
    nativeEvent: "SessionStart",
    surfaceId: "codex-hooks",
    support: "supported",
    runtimeFailure: "fail-open"
  },
  {
    capability: "command-policy",
    normalizedEvent: "command",
    nativeEvent: "PreToolUse",
    surfaceId: "codex-hooks",
    support: "unknown",
    runtimeFailure: "native-unknown"
  },
  {
    capability: "optional-stop-verify",
    normalizedEvent: "stop",
    nativeEvent: "Stop",
    surfaceId: "codex-hooks",
    support: "unsupported",
    runtimeFailure: "fail-open"
  }
] as const satisfies readonly CapabilityRegistrationSpec[];
