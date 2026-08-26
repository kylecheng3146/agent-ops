import type { HookEventName } from "../../contracts.js";
import type { HookResult } from "../../hooks/events.js";

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
  event: HookEventName,
  result: HookResult
): ClaudeHookProcessOutput {
  const denialReason =
    result.remedy === undefined ? result.code : `${result.code}: ${result.remedy}`;
  if (event === "Stop" && result.evidence !== undefined) {
    if (result.status === "FAIL") {
      const failed = result.evidence.commandResults
        .filter(({ exitCode }) => exitCode !== 0)
        .map(({ commandId }) => commandId);
      return json({
        decision: "block",
        reason:
          `agent-ops: ${result.code} reported FAIL for ${failed.join(", ")}. ` +
          "Resolve every failing item — an unsatisfied independent-review " +
          "gate is cleared by running `agent-ops review` to a PASS — then " +
          "stop again.",
        evidence: result.evidence
      });
    }
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
        permissionDecisionReason: denialReason
      }
    });
  }
  return json({
    systemMessage: `agent-ops: ${result.code}`
  });
}
