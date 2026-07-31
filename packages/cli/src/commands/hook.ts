import type { AgentOpsConfig } from "../../../../runtime/src/contracts.js";
import { dispatchHookEvent } from "../../../../runtime/src/hooks/dispatch.js";
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
}

export interface HookCommandOutput {
  readonly exitCode: 0;
  readonly stdout: string;
  readonly stderr: string;
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
    const result = await dispatchHookEvent(
      descriptor.runtime.normalizeInput(input),
      {
        capabilities,
        trusted: options.trusted
      }
    );
    return descriptor.runtime.formatOutput(options.event, result);
  } catch {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}
