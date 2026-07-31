import type { Profile } from "../contracts.js";

export type Capability =
  | "rules"
  | "task"
  | "verify"
  | "review"
  | "lifecycle-summary"
  | "local-log"
  | "command-policy"
  | "optional-stop-verify";

export type CapabilitySupport =
  | "supported"
  | "degraded"
  | "unsupported"
  | "unknown";

export type RuntimeFailureMode =
  | "fail-open"
  | "fail-closed"
  | "native-unknown";

export interface CapabilityRegistrationSpec {
  readonly capability:
    | "lifecycle-summary"
    | "command-policy"
    | "optional-stop-verify";
  readonly normalizedEvent: "session-start" | "command" | "stop";
  readonly nativeEvent: "SessionStart" | "PreToolUse" | "Stop";
  readonly surfaceId: string;
  readonly support: CapabilitySupport;
  readonly runtimeFailure: RuntimeFailureMode;
}

export interface ResolvedProfiles {
  profiles: Profile[];
  capabilities: Capability[];
}
