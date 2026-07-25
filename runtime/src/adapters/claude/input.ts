import type { NormalizedHookEvent } from "../../hooks/events.js";
import { normalizeHookEvent } from "../../hooks/normalize.js";
import { normalizeShellHookEvent } from "../../hooks/shell.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function claudeStopRecursionMarker(input: unknown): boolean {
  return (
    isRecord(input) &&
    input.hook_event_name === "Stop" &&
    input.stop_hook_active === true
  );
}

export function normalizeClaudeHookInput(
  input: unknown
): NormalizedHookEvent {
  if (!isRecord(input)) {
    return normalizeHookEvent(input);
  }
  const projectRoot = input.cwd;
  if (input.hook_event_name === "SessionStart") {
    return normalizeHookEvent({
      event: "session-start",
      projectRoot
    });
  }
  if (input.hook_event_name === "Stop") {
    return normalizeHookEvent({
      event: "stop",
      projectRoot
    });
  }
  if (
    input.hook_event_name === "PreToolUse" &&
    input.tool_name === "Bash" &&
    isRecord(input.tool_input) &&
    typeof input.tool_input.command === "string"
  ) {
    return normalizeShellHookEvent(
      input.tool_input.command,
      projectRoot
    );
  }
  return normalizeHookEvent({
    event: "unsupported",
    projectRoot
  });
}
