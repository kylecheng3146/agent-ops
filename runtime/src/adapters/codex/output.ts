import type { HookEventName } from "../../contracts.js";
import type { HookResult } from "../../hooks/events.js";

export const CODEX_NON_ZERO_EXIT_BEHAVIOR = "UNKNOWN" as const;
export const CODEX_PRE_TOOL_BLOCKING = "UNKNOWN" as const;

export interface CodexHookProcessOutput {
  readonly exitCode: 0;
  readonly stdout: string;
}

export function codexHookOutput(
  event: HookEventName,
  result: HookResult
): CodexHookProcessOutput {
  if (event === "Stop" && result.evidence !== undefined) {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        continue: true,
        systemMessage: `agent-ops: ${result.code}`,
        evidence: result.evidence
      })
    };
  }
  if (result.action === "continue" && result.status === "PASS") {
    return { exitCode: 0, stdout: "" };
  }
  if (event === "PreToolUse") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        systemMessage: `agent-ops: ${result.code}`
      })
    };
  }
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      continue: result.action !== "block",
      ...(result.action === "block"
        ? { stopReason: result.code }
        : { systemMessage: `agent-ops: ${result.code}` })
    })
  };
}
