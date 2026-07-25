import type { HookResult } from "../../hooks/events.js";
import type { CodexSupportedEvent } from "./events.js";

export const CODEX_NON_ZERO_EXIT_BEHAVIOR = "UNKNOWN" as const;

export interface CodexHookProcessOutput {
  readonly exitCode: 0;
  readonly stdout: string;
}

export function codexHookOutput(
  event: CodexSupportedEvent,
  result: HookResult
): CodexHookProcessOutput {
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
