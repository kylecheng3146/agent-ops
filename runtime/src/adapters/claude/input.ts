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
  // The completion gate keys its per-session baseline on this. Without it every
  // Stop is refused for the wrong reason and no SessionStart ever records a
  // baseline to refuse against.
  const sessionId = typeof input.session_id === "string"
    ? input.session_id
    : undefined;
  if (input.hook_event_name === "SessionStart") {
    return {
      ...normalizeHookEvent({ event: "session-start", projectRoot }),
      ...(sessionId === undefined ? {} : { sessionId })
    };
  }
  if (input.hook_event_name === "Stop") {
    // Claude publishes no termination reason: its Stop hook fires when the
    // assistant has finished, which is agy's `model_stop`. The one distinction
    // it does publish is recursion — a Stop the hook itself caused — and that
    // is exactly the not-yet-idle case the gate lets through.
    const stop = normalizeHookEvent({ event: "stop", projectRoot });
    return {
      event: "stop",
      projectRoot: stop.projectRoot,
      ...(sessionId === undefined ? {} : { sessionId }),
      terminationReason: "model_stop",
      fullyIdle: input.stop_hook_active !== true
    };
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
