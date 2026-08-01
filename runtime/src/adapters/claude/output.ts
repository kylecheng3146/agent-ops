import type { HookResult } from "../../hooks/events.js";
import type { ClaudeSupportedEvent } from "./events.js";

export interface ClaudeHookProcessOutput {
  readonly exitCode: 0;
  readonly stdout: string;
  readonly stderr: string;
}

function json(value: unknown): ClaudeHookProcessOutput {
  return {
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: ""
  };
}

export function claudeHookOutput(
  event: ClaudeSupportedEvent,
  result: HookResult
): ClaudeHookProcessOutput {
  if (event === "Stop" && result.evidence !== undefined) {
    return json({
      systemMessage: `agent-ops: ${result.code}`,
      evidence: result.evidence
    });
  }
  if (result.action === "continue" && result.status === "PASS") {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  if (event === "PreToolUse" && result.action === "block") {
    return json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: result.code
      }
    });
  }
  return json({
    systemMessage: `agent-ops: ${result.code}`
  });
}
