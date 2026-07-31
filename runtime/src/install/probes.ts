import type { AgentOpsConfig, Harness } from "../contracts.js";
import { buildClaudeHookSettings } from "../adapters/claude/config.js";
import {
  buildCodexHookConfig,
  CODEX_MANAGED_MARKER
} from "../adapters/codex/config.js";
import type { DoctorStatus } from "./doctor.js";
import { resolveProfiles } from "./profiles.js";

const CLAUDE_HOOK_MARKER = "--managed-by=agent-ops";

export interface HookRegistrationInput {
  readonly harness: Harness;
  readonly profiles: AgentOpsConfig["profiles"];
  readonly claudeSettings: unknown;
  readonly codexHooks: unknown;
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

function isManagedClaudeHandler(handler: unknown): boolean {
  return (
    isRecord(handler) &&
    Array.isArray(handler.args) &&
    handler.args.includes(CLAUDE_HOOK_MARKER)
  );
}

/**
 * Only the marker counts. A legacy PATH-resolved handler is deliberately not
 * satisfying, so doctor reports the install as needing an update.
 */
function isManagedCodexHandler(handler: unknown): boolean {
  return (
    isRecord(handler) &&
    typeof handler.command === "string" &&
    handler.command.includes(CODEX_MANAGED_MARKER)
  );
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
  const claudeEvents = Object.keys(
    buildClaudeHookSettings(capabilities, "probe").hooks
  );
  const codexEvents = Object.keys(
    buildCodexHookConfig(capabilities, "probe").hooks
  );
  if (claudeEvents.length === 0 && codexEvents.length === 0) {
    return true;
  }
  if (
    input.harness !== "codex" &&
    !hasManagedHandler(
      input.claudeSettings,
      claudeEvents,
      isManagedClaudeHandler
    )
  ) {
    return false;
  }
  return (
    input.harness === "claude" ||
    hasManagedHandler(input.codexHooks, codexEvents, isManagedCodexHandler)
  );
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
