import type { AgentOpsConfig, Harness, HarnessId } from "../contracts.js";
import type { DoctorStatus } from "./doctor.js";
import { harnessDescriptor } from "./harness.js";
import { resolveProfiles } from "./profiles.js";

export interface HookRegistrationInput {
  readonly harness: Harness;
  readonly profiles: AgentOpsConfig["profiles"];
  /** Current hook settings per harness; a missing entry counts as absent. */
  readonly sources: Partial<Record<HarnessId, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasManagedHandler(
  source: unknown,
  events: readonly string[],
  isManaged: (handler: unknown) => boolean
): boolean {
  if (!isRecord(source) || !isRecord(source.hooks)) {
    return false;
  }
  const registered = source.hooks;
  return events.every((event) => {
    const groups = registered[event];
    return (
      Array.isArray(groups) &&
      groups.some(
        (group) =>
          isRecord(group) &&
          Array.isArray(group.hooks) &&
          group.hooks.some(isManaged)
      )
    );
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
  const { capabilities } = resolveProfiles(input.profiles);
  return input.harness.every((id) => {
    const descriptor = harnessDescriptor(id);
    const events = Object.keys(
      descriptor.buildHooks(capabilities, "probe").hooks
    );
    return (
      events.length === 0 ||
      hasManagedHandler(
        input.sources[id],
        events,
        descriptor.isManagedHandler
      )
    );
  });
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
