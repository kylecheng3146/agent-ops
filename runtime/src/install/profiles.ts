import type { AgentOpsConfig, Profile } from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";
import type { Capability, ResolvedProfiles } from "./types.js";

const PROFILE_ORDER = ["core", "advisory", "guardrails"] as const;

export const PROFILE_CAPABILITIES = {
  core: ["rules", "task", "verify", "review"],
  advisory: ["lifecycle-summary", "local-log"],
  guardrails: ["command-policy"]
} as const satisfies Record<Profile, readonly Capability[]>;

export function resolveProfiles(
  inputProfiles: readonly Profile[]
): ResolvedProfiles {
  if (inputProfiles.length === 0) {
    throw new AgentOpsError(
      "PROFILE_REQUIRED",
      "At least one installation profile is required."
    );
  }

  const selectedProfiles = new Set<Profile>(inputProfiles);
  if (selectedProfiles.has("guardrails")) {
    selectedProfiles.add("core");
  }

  const profiles = PROFILE_ORDER.filter((profile) =>
    selectedProfiles.has(profile)
  );
  const capabilities: Capability[] = [];
  const seenCapabilities = new Set<Capability>();

  for (const profile of profiles) {
    for (const capability of PROFILE_CAPABILITIES[profile]) {
      if (!seenCapabilities.has(capability)) {
        seenCapabilities.add(capability);
        capabilities.push(capability);
      }
    }
  }

  return { profiles: [...profiles], capabilities };
}

export function resolveCapabilities(
  config: AgentOpsConfig
): ResolvedProfiles {
  const resolved = resolveProfiles(config.profiles);
  if (config.features.stopVerification.enabled) {
    resolved.capabilities.push("optional-stop-verify");
  }
  return resolved;
}
