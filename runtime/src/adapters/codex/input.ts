import type { NormalizedHookEvent } from "../../hooks/events.js";
import { normalizeHookEvent } from "../../hooks/normalize.js";
import { normalizeShellHookEvent } from "../../hooks/shell.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellCommand(input: Record<string, unknown>): string | null {
  if (!isRecord(input.tool_input)) {
    return null;
  }
  const candidate = input.tool_input.command ?? input.tool_input.cmd;
  return typeof candidate === "string" ? candidate : null;
}

export function normalizeCodexHookInput(
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
    input.tool_name === "Bash"
  ) {
    const rawCommand = shellCommand(input);
    if (rawCommand !== null) {
      return normalizeShellHookEvent(rawCommand, projectRoot);
    }
  }
  return normalizeHookEvent({
    event: "unsupported",
    projectRoot
  });
}
