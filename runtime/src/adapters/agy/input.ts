import type { NormalizedHookEvent } from "../../hooks/events.js";
import { normalizeHookEvent } from "../../hooks/normalize.js";
import { normalizeShellHookEvent } from "../../hooks/shell.js";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeAgyHookInput(input: unknown): NormalizedHookEvent {
  const value = record(input);
  if (value === null) return normalizeHookEvent(input);
  const workspacePaths = Array.isArray(value.workspacePaths)
    ? value.workspacePaths
    : [];
  const projectRoot = typeof workspacePaths[0] === "string"
    ? workspacePaths[0]
    : undefined;
  const toolCall = record(value.toolCall);
  const args = record(toolCall?.args);
  if (toolCall?.name === "run_command" && typeof args?.CommandLine === "string") {
    return normalizeShellHookEvent(args.CommandLine, projectRoot);
  }
  if (typeof value.terminationReason === "string") {
    return normalizeHookEvent({ event: "stop", projectRoot });
  }
  if (typeof value.invocationNum === "number") {
    return normalizeHookEvent({ event: "session-start", projectRoot });
  }
  return normalizeHookEvent({ event: "unsupported", projectRoot });
}
