import type { NormalizedHookEvent } from "../../hooks/events.js";
import { normalizeHookEvent } from "../../hooks/normalize.js";

const SAFE_SHELL_WORD = /^[A-Za-z0-9_./:=+@%,-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeArgv(command: string): string[] | null {
  const words = command.trim().split(/\s+/);
  return (
    words.length > 0 && words.every((word) => SAFE_SHELL_WORD.test(word))
      ? words
      : null
  );
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
    const argv = rawCommand === null ? null : safeArgv(rawCommand);
    if (argv !== null && argv[0] !== undefined) {
      return normalizeHookEvent({
        event: "command",
        projectRoot,
        command: argv[0],
        args: argv.slice(1),
        scope: projectRoot
      });
    }
  }
  return normalizeHookEvent({
    event: "unsupported",
    projectRoot
  });
}
