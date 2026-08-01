import type { NormalizedHookEvent } from "../../hooks/events.js";
import { normalizeHookEvent } from "../../hooks/normalize.js";
import { normalizeShellHookEvent } from "../../hooks/shell.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The managed plugin forwards opencode's own hook payload untouched under
 * `input`, so every field this adapter reads is documented plugin input rather
 * than a shape the plugin invented.
 */
export function normalizeOpencodeHookInput(
  input: unknown
): NormalizedHookEvent {
  if (!isRecord(input)) {
    return normalizeHookEvent(input);
  }
  const projectRoot = input.projectRoot;
  if (input.event === "SessionStart") {
    return normalizeHookEvent({ event: "session-start", projectRoot });
  }
  if (input.event === "Stop") {
    return normalizeHookEvent({ event: "stop", projectRoot });
  }
  if (
    input.event === "PreToolUse" &&
    isRecord(input.input) &&
    input.input.tool === "bash" &&
    isRecord(input.output) &&
    isRecord(input.output.args) &&
    typeof input.output.args.command === "string" &&
    typeof projectRoot === "string"
  ) {
    return normalizeShellHookEvent(input.output.args.command, projectRoot);
  }
  return normalizeHookEvent({ event: "unsupported", projectRoot });
}
