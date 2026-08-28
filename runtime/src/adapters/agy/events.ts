import type { CapabilityRegistrationSpec } from "../../install/types.js";

export const AGY_CAPABILITY_REGISTRATIONS = [
  {
    capability: "lifecycle-summary",
    normalizedEvent: "session-start",
    nativeEvent: "SessionStart",
    hostEvent: "PreInvocation",
    surfaceId: "agy-hooks",
    support: "degraded",
    runtimeFailure: "fail-open"
  },
  {
    capability: "command-policy",
    normalizedEvent: "command",
    nativeEvent: "PreToolUse",
    surfaceId: "agy-hooks",
    support: "supported",
    runtimeFailure: "fail-closed"
  },
  {
    capability: "optional-stop-verify",
    normalizedEvent: "stop",
    nativeEvent: "Stop",
    surfaceId: "agy-hooks",
    support: "degraded",
    runtimeFailure: "fail-open"
  }
] as const satisfies readonly CapabilityRegistrationSpec[];
