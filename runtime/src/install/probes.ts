import type { AgentOpsConfig, Harness, HarnessId } from "../contracts.js";
import type { DoctorStatus } from "./doctor.js";
import { harnessDescriptor } from "./harness.js";
import { resolveCapabilities } from "./profiles.js";

export interface HookRegistrationInput {
  readonly harness: Harness;
  readonly config: AgentOpsConfig;
  /** Current hook settings per harness; a missing entry counts as absent. */
  readonly sources: Partial<Record<HarnessId, unknown>>;
}

/**
 * Returns the harness ids missing an agent-ops owned handler for the hook
 * events implied by the installed profiles. Empty when installations without
 * hook capabilities have nothing to register.
 */
export function hookRegistrationDrift(
  input: HookRegistrationInput
): readonly HarnessId[] {
  const capabilities =
    input.config.profiles.length === 0
      ? []
      : resolveCapabilities(input.config).capabilities;
  return input.harness.filter((id) => {
    const descriptor = harnessDescriptor(id);
    return !descriptor.control.hookRegistered(input.sources[id], capabilities);
  });
}

/**
 * Hook registration is satisfied when every hook event implied by the
 * installed profiles carries an agent-ops owned handler for every installed
 * harness. Installations without hook capabilities have nothing to register.
 */
export function hookRegistrationSatisfied(
  input: HookRegistrationInput
): boolean {
  return hookRegistrationDrift(input).length === 0;
}

/**
 * Smoke availability stays UNKNOWN until the repository declares a
 * verification command; the toolkit never invents one.
 */
export function smokeAvailabilityStatus(
  config: AgentOpsConfig
): DoctorStatus {
  return config.verification.commands.length > 0 ? "PASS" : "UNKNOWN";
}

/**
 * Installation approval never grants trust, so an ungranted repository is
 * unconfigured rather than broken. A stale binding is a real failure.
 */
export function repositoryTrustStatus(
  trust: "TRUSTED" | "STALE" | "UNTRUSTED"
): DoctorStatus {
  return trust === "TRUSTED"
    ? "PASS"
    : trust === "STALE"
      ? "FAIL"
      : "UNKNOWN";
}
