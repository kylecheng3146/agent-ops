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
  const sessionId = typeof value.conversationId === "string"
    ? value.conversationId
    : undefined;
  const toolCall = record(value.toolCall);
  const args = record(toolCall?.args);
  if (toolCall?.name === "run_command" && typeof args?.CommandLine === "string") {
    return {
      ...normalizeShellHookEvent(args.CommandLine, projectRoot),
      ...(sessionId === undefined ? {} : { sessionId })
    };
  }
  if (typeof value.terminationReason === "string") {
    return {
      event: "stop",
      projectRoot: projectRoot ?? process.cwd(),
      ...(sessionId === undefined ? {} : { sessionId }),
      terminationReason: value.terminationReason,
      ...(typeof value.fullyIdle === "boolean"
        ? { fullyIdle: value.fullyIdle }
        : {})
    };
  }
  if (typeof value.invocationNum === "number") {
    return {
      event: "session-start",
      projectRoot: projectRoot ?? process.cwd(),
      ...(sessionId === undefined ? {} : { sessionId })
    };
  }
  return normalizeHookEvent({ event: "unsupported", projectRoot });
}
