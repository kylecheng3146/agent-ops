import { AgentOpsError } from "../fs/paths.js";
import type { NormalizedHookEvent } from "./events.js";

const MAX_TEXT_LENGTH = 4096;
const MAX_ARGS = 256;

function invalidInput(): never {
  throw new AgentOpsError(
    "HOOK_INPUT_INVALID",
    "Hook input is invalid."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TEXT_LENGTH ||
    value.includes("\0")
  ) {
    return invalidInput();
  }
  return value;
}

function stringArgs(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARGS ||
    !value.every(
      (item) =>
        typeof item === "string" &&
        item.length <= MAX_TEXT_LENGTH &&
        !item.includes("\0")
    )
  ) {
    return invalidInput();
  }
  return [...value] as string[];
}

export function normalizeHookEvent(input: unknown): NormalizedHookEvent {
  if (!isRecord(input)) {
    return invalidInput();
  }
  const event = boundedString(input.event);
  const projectRoot = boundedString(input.projectRoot);

  if (event === "session-start" || event === "stop") {
    return { event, projectRoot };
  }
  if (event === "command") {
    return {
      event,
      projectRoot,
      command: boundedString(input.command),
      args: stringArgs(input.args),
      scope: boundedString(input.scope)
    };
  }
  if (event === "content") {
    return {
      event,
      projectRoot,
      content: boundedString(input.content),
      scope: boundedString(input.scope)
    };
  }
  return {
    event: "unsupported",
    projectRoot
  };
}
