import type { HookEventName } from "../../contracts.js";
import type { HookResult } from "../../hooks/events.js";
import type { HookProcessOutput } from "../../install/harness.js";

export function agyHookOutput(
  event: HookEventName,
  result: HookResult
): HookProcessOutput {
  if (result.action === "continue" && result.status === "PASS") {
    return {
      exitCode: 0,
      stdout: event === "PreToolUse" || event === "Stop"
        ? JSON.stringify({ decision: "allow" })
        : "{}",
      stderr: ""
    };
  }
  const reason = result.remedy === undefined
    ? `agent-ops: ${result.code}`
    : `agent-ops: ${result.code}: ${result.remedy}`;
  const value = event === "PreToolUse"
    ? result.action === "block"
      ? { decision: "deny", reason }
      : { decision: "allow" as const }
    : event === "SessionStart"
      ? { injectSteps: [{ ephemeralMessage: reason }] }
      : event === "Stop"
        ? { decision: "allow", reason }
        : {};
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}
