import type { AgentOpsConfig, Harness, HarnessId, HookEventName } from "../contracts.js";
import type { DoctorProbeResult, DoctorStatus } from "./doctor.js";
import { harnessDescriptor } from "./harness.js";
import { resolveCapabilities } from "./profiles.js";

const MINIMUM_AGY_VERSION = [1, 1, 12] as const;

export function agyVersionSupported(versionOutput: string): boolean {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/u.exec(versionOutput);
  const version = match?.slice(1).map(Number);
  return version !== undefined && !version.some((part, index) =>
    part < MINIMUM_AGY_VERSION[index]! &&
    version.slice(0, index).every((prior, priorIndex) =>
      prior === MINIMUM_AGY_VERSION[priorIndex]
    )
  );
}

export function agyRuntimeStatus(
  versionOutput: string,
  hooksOutput: string,
  expectedEvents: readonly HookEventName[] = []
): DoctorProbeResult {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/u.exec(versionOutput);
  if (!agyVersionSupported(versionOutput)) {
    return {
      status: "FAIL",
      message: "agy 1.1.12 or newer is required.",
      remediation: "Update agy, then run `agent-ops doctor` again."
    };
  }
  try {
    const parsed = JSON.parse(hooksOutput) as {
      command?: { data?: { hooks?: unknown[] } };
    };
    const hooks = parsed.command?.data?.hooks;
    const loaded = Array.isArray(hooks) && hooks.some((hook) => {
      if (typeof hook !== "object" || hook === null || Array.isArray(hook)) return false;
      const value = hook as { name?: unknown; enabled?: unknown; actions?: unknown };
      const actions = value.actions;
      if (!(value.name === "agent-ops" &&
        value.enabled === true &&
        Array.isArray(actions) &&
        actions.length > 0 &&
        actions.every((action) =>
          typeof action === "object" && action !== null && !Array.isArray(action)
        ))) return false;
      return expectedEvents.every((expected) => actions.some((action) => {
        const nativeEvent = expected === "SessionStart" ? "PreInvocation" : expected;
        return (
          typeof action === "object" && action !== null && !Array.isArray(action) &&
          (action as { event?: unknown }).event === nativeEvent &&
          typeof (action as { command?: unknown }).command === "string" &&
          (action as { command: string }).command.endsWith(
            ` agy ${expected} --managed-by=agent-ops`
          )
        );
      }));
    });
    if (!Array.isArray(hooks) || (expectedEvents.length > 0 && !loaded)) {
      return {
        status: "FAIL",
        message: "agy is installed, but its loaded hook list does not include agent-ops.",
        code: "UPDATE_REQUIRED",
        remediation: "Run `agent-ops update`, restart agy, then run doctor again."
      };
    }
    return {
      status: "PASS",
      message: expectedEvents.length > 0
        ? `agy ${match?.[0]} loaded the agent-ops hook.`
        : `agy ${match?.[0]} meets the minimum supported version.`
    };
  } catch {
    return {
      status: "FAIL",
      message: "agy returned an unreadable /hooks response.",
      remediation: "Run `agy -p \"/hooks\" --output-format json` and inspect the result."
    };
  }
}

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
 * User-scope installs and projects without verification commands can remain
 * untrusted without being broken. A stale binding is a real failure.
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
