import type {
  CommandHookEvent,
  NormalizedHookEvent
} from "./events.js";
import { normalizeHookEvent } from "./normalize.js";

const MAX_COMMAND_LENGTH = 16 * 1024;
const MAX_COMMANDS = 64;
const MAX_WORDS = 256;

function parseShellWords(input: string): string[][] | null {
  if (input.length === 0 || input.length > MAX_COMMAND_LENGTH) {
    return null;
  }
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  const finishWord = () => {
    if (word.length > 0) {
      words.push(word);
      word = "";
    }
  };
  const finishCommand = () => {
    finishWord();
    if (words.length > 0) {
      commands.push(words);
      words = [];
    }
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) {
      return null;
    }
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        word += character;
      }
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      finishWord();
      if (character === "\n") {
        finishCommand();
      }
      continue;
    }
    if (character === ";" || character === "|" || character === "&") {
      finishCommand();
      const next = input[index + 1];
      if (next === character) {
        index += 1;
      }
      continue;
    }
    if (
      character === "`" ||
      character === "(" ||
      character === ")" ||
      character === "\0"
    ) {
      return null;
    }
    word += character;
    if (word.length > MAX_COMMAND_LENGTH) {
      return null;
    }
  }
  if (escaped || quote !== null) {
    return null;
  }
  finishCommand();
  if (
    commands.length === 0 ||
    commands.length > MAX_COMMANDS ||
    commands.some((command) => command.length > MAX_WORDS)
  ) {
    return null;
  }
  return commands;
}

export function normalizeShellHookEvent(
  input: string,
  projectRoot: unknown
): NormalizedHookEvent {
  const commands = parseShellWords(input);
  if (commands === null) {
    return normalizeHookEvent({
      event: "unsupported",
      projectRoot
    });
  }
  const normalized = commands.map((words): CommandHookEvent => {
    const command = words[0];
    if (command === undefined) {
      throw new Error("Shell parser returned an empty command.");
    }
    const event = normalizeHookEvent({
      event: "command",
      projectRoot,
      command,
      args: words.slice(1),
      scope: projectRoot
    });
    if (event.event !== "command") {
      throw new Error("Shell command normalization failed.");
    }
    return event;
  });
  if (normalized.length === 1 && normalized[0] !== undefined) {
    return normalized[0];
  }
  const first = normalized[0];
  if (first === undefined) {
    return normalizeHookEvent({
      event: "unsupported",
      projectRoot
    });
  }
  return {
    event: "command-batch",
    projectRoot: first.projectRoot,
    commands: normalized.map(({ command, args }) => ({
      command,
      args
    })),
    scope: first.scope
  };
}
