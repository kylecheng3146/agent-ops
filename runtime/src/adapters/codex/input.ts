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
  const sessionId = typeof input.session_id === "string" && input.session_id.length > 0
    ? input.session_id
    : undefined;
  if (input.hook_event_name === "SessionStart") {
    const start = normalizeHookEvent({
      event: "session-start",
      projectRoot
    });
    return {
      event: "session-start",
      projectRoot: start.projectRoot,
      ...(sessionId === undefined ? {} : {sessionId})
    };
  }
  if (input.hook_event_name === "Stop") {
    const stop = normalizeHookEvent({
      event: "stop",
      projectRoot
    });
    return {
      event: "stop",
      projectRoot: stop.projectRoot,
      ...(sessionId === undefined ? {} : {sessionId}),
      terminationReason: typeof input.termination_reason === "string"
        ? input.termination_reason
        : "model_stop",
      fullyIdle: input.stop_hook_active !== true
    };
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
