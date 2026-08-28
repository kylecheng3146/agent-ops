import type { AgentOpsConfig } from "../../../../runtime/src/contracts.js";
import { runLifecycleAdvisory } from "../../../../runtime/src/hooks/advisory.js";
import { dispatchHookEvent } from "../../../../runtime/src/hooks/dispatch.js";
import type {
  HookDispatchOptions,
  NormalizedHookEvent,
  StopVerificationOptions
} from "../../../../runtime/src/hooks/events.js";
import { resolveCapabilities } from "../../../../runtime/src/install/profiles.js";
import {
  harnessDescriptor,
  type HarnessId
} from "../../../../runtime/src/install/harness.js";

export const HOOK_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "Stop"
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookCommandOptions {
  readonly harness: HarnessId;
  readonly event: HookEvent;
  readonly stdin: string;
  readonly config: AgentOpsConfig;
  readonly trusted: boolean;
  readonly advisory?: HookDispatchOptions["advisory"];
  readonly stopVerification?: StopVerificationOptions;
  readonly completionGate?: HookDispatchOptions["completionGate"];
}

export interface HookCommandOutput {
  readonly exitCode: 0;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Keep adapter normalization at the command boundary so exceptional hook
 * paths use the same native-event interpretation as normal dispatch.
 */
export function normalizeHookInput(
  harness: HarnessId,
  input: unknown
): NormalizedHookEvent | null {
  try {
    return harnessDescriptor(harness).runtime.normalizeInput(input);
  } catch {
    return null;
  }
}

/**
 * Hooks are advisory infrastructure: every failure path stays fail-open with
 * exit code 0 so a broken toolkit can never wedge the harness.
 */
export async function runHookCommand(
  options: HookCommandOptions
): Promise<HookCommandOutput> {
  try {
    const { capabilities } =
      options.config.profiles.length === 0
        ? { capabilities: [] as const }
        : resolveCapabilities(options.config);
    let input: unknown;
    try {
      input = JSON.parse(options.stdin) as unknown;
    } catch {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const descriptor = harnessDescriptor(options.harness);
    const normalized = normalizeHookInput(options.harness, input);
    if (normalized === null) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const stopRegistration = descriptor.control.registrations.find(
      ({ capability }) => capability === "optional-stop-verify"
    );
    const stopVerification =
      options.stopVerification !== undefined &&
      stopRegistration?.support !== "unsupported"
        ? options.stopVerification
        : undefined;
    const result = await dispatchHookEvent(normalized, {
      capabilities,
      trusted: options.trusted,
      advisory: options.advisory ?? runLifecycleAdvisory,
      ...(stopVerification === undefined ? {} : { stopVerification }),
      ...(options.completionGate === undefined
        ? {}
        : { completionGate: options.completionGate })
    });
    return descriptor.runtime.formatOutput(options.event, result);
  } catch {
    if (options.harness === "agy" && options.completionGate !== undefined) {
      return harnessDescriptor("agy").runtime.formatOutput(options.event, {
        action: "block",
        status: "UNKNOWN",
        code: "COMPLETION_GATE_UNAVAILABLE",
        remedy: "Run agent-ops doctor; a user-approved one-time permit may be used after diagnosing the failure."
      });
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}
