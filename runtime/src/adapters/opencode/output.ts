import type { HookResult } from "../../hooks/events.js";
import type { OpencodeSupportedEvent } from "./events.js";

export interface OpencodeHookProcessOutput {
  readonly exitCode: 0;
  readonly stdout: string;
  readonly stderr: string;
}

export interface OpencodeDecision {
  readonly decision: "allow" | "deny";
  readonly reason?: string;
}

/**
 * The consumer is the managed plugin, so the wire format is ours to define: one
 * JSON decision on stdout. Only `tool.execute.before` can act on a denial, so
 * the other events always report `allow` and carry the code for logging.
 */
export function opencodeHookOutput(
  event: OpencodeSupportedEvent,
  result: HookResult
): OpencodeHookProcessOutput {
  const decision: OpencodeDecision =
    event === "PreToolUse" && result.action === "block"
      ? { decision: "deny", reason: result.code }
      : { decision: "allow", ...(result.status === "PASS" ? {} : { reason: result.code }) };
  return {
    exitCode: 0,
    stdout: JSON.stringify(decision),
    stderr: ""
  };
}
