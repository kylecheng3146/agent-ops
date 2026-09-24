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
  // The completion gate carries no verification evidence of its own — it reads
  // evidence rather than producing it — so it never reaches the branch below
  // and needs its own refusal.
  if (
    event === "Stop" &&
    result.action === "block" &&
    result.code.startsWith("COMPLETION_GATE_")
  ) {
    return json({
      decision: "block",
      reason: `agent-ops: ${denialReason}`
    });
  }
  if (
    event === "PreToolUse" &&
    (result.code === "COMPLETION_GATE_PERMIT_CONFIRMATION" ||
      result.code === "WORKTREE_REMOVE_CONFIRMATION")
  ) {
    // Asked, never allowed: a one-time Stop permit is the user's to grant, and
    // an agent that could answer this for itself would hold the key to its own
    // gate.
    return json({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: denialReason
      }
    });
  }
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
          "gate is cleared by running `agent-ops review --task <task-id> --yes` " +
          "to a PASS — then " +
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
  // An advisory PreToolUse result carries nothing the user can act on: the
  // command runs either way. Saying so on every unparsed command — a heredoc,
  // a substitution — trains the reader to ignore the hook that also refuses
  // stops. A result with a remedy still speaks.
  if (
    event === "PreToolUse" &&
    result.action === "continue" &&
    result.remedy === undefined
  ) {
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
