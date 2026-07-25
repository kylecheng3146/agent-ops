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

export interface ResolvedProfiles {
  profiles: Profile[];
  capabilities: Capability[];
}
