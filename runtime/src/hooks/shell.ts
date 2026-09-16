import type {
  CommandHookEvent,
  NormalizedHookEvent
} from "./events.js";
import { normalizeHookEvent } from "./normalize.js";

const MAX_COMMAND_LENGTH = 16 * 1024;
const MAX_COMMANDS = 64;
const MAX_WORDS = 256;
/** Substitutions nest; a deeper stack is pathological input, not a script. */
const MAX_SUBSTITUTION_DEPTH = 8;

/** Stands in for a substitution's value in the word that contained it. */
const SUBSTITUTION_PLACEHOLDER = "_";

interface HeredocMarker {
  readonly delimiter: string;
  /** An unquoted delimiter expands its body, so the body can run commands. */
  readonly expands: boolean;
}

/**
 * Walks from the opening parenthesis of a `$(...)` to the one that closes it,
 * honouring quotes on the way. A quoted `)` is text, not structure: counting it
 * as structure loses the whole command, and a lost command is one the policy
 * never sees.
 */
function scanParenthesis(input: string, open: number): number | null {
  let depth = 0;
  let index = open;
  while (index < input.length) {
    const character = input[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "'") {
      const end = input.indexOf("'", index + 1);
      if (end < 0) return null;
      index = end + 1;
      continue;
    }
    if (character === "\"") {
      const end = scanDoubleQuote(input, index + 1);
      if (end === null) return null;
      index = end + 1;
      continue;
    }
    if (character === "`") {
      const end = scanBacktick(input, index + 1);
      if (end === null) return null;
      index = end + 1;
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return null;
}

/** Index of the `"` that closes the one already consumed. */
function scanDoubleQuote(input: string, start: number): number | null {
  let index = start;
  while (index < input.length) {
    const character = input[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "`") {
      const end = scanBacktick(input, index + 1);
      if (end === null) return null;
      index = end + 1;
      continue;
    }
    if (character === "$" && input[index + 1] === "(") {
      const end = scanParenthesis(input, index + 1);
      if (end === null) return null;
      index = end + 1;
      continue;
    }
    if (character === "\"") return index;
    index += 1;
  }
  return null;
}

function scanBacktick(input: string, start: number): number | null {
  let index = start;
  while (index < input.length) {
    if (input[index] === "\\") {
      index += 2;
      continue;
    }
    if (input[index] === "`") return index;
    index += 1;
  }
  return null;
}

/**
 * The substitutions in text the shell expands but does not tokenize as a
 * command line — the body of an unquoted heredoc. Quotes there are literal
 * characters; only `$(...)` and backticks run anything.
 */
function collectExpansions(input: string): string[] | null {
  const found: string[] = [];
  let index = 0;
  while (index < input.length) {
    const character = input[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "$" && input[index + 1] === "(") {
      const end = scanParenthesis(input, index + 1);
      if (end === null) return null;
      found.push(input.slice(index + 2, end));
      index = end + 1;
      continue;
    }
    if (character === "`") {
      const end = scanBacktick(input, index + 1);
      if (end === null) return null;
      found.push(input.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    index += 1;
  }
  return found;
}

interface HeredocHeader {
  readonly marker: HeredocMarker;
  readonly end: number;
}

/** Reads the `<<WORD`, `<<-WORD`, `<<'WORD'` that follows a `<<`. */
function readHeredocHeader(input: string, start: number): HeredocHeader | null {
  let index = start;
  if (input[index] === "-") index += 1;
  while (input[index] === " " || input[index] === "\t") index += 1;
  const quote = input[index];
  if (quote === "'" || quote === "\"") {
    const end = input.indexOf(quote, index + 1);
    if (end < 0) return null;
    const delimiter = input.slice(index + 1, end);
    return delimiter.length === 0
      ? null
      : { marker: { delimiter, expands: false }, end: end + 1 };
  }
  let delimiter = "";
  while (index < input.length && /[A-Za-z0-9_.-]/u.test(input[index] ?? "")) {
    delimiter += input[index];
    index += 1;
  }
  return delimiter.length === 0
    ? null
    : { marker: { delimiter, expands: true }, end: index };
}

interface ParsedShell {
  readonly commands: string[][];
  readonly substitutions: readonly string[];
}

/**
 * One quote-aware pass over a command line. Everything that decides whether a
 * character is structure or text — quotes, escapes, heredocs, substitutions —
 * is decided here, once, so no later pass can disagree with this one about
 * where a quote begins.
 */
function parseLine(input: string): ParsedShell | null {
  const commands: string[][] = [];
  const substitutions: string[] = [];
  const pending: HeredocMarker[] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let index = 0;

  const finishWord = () => {
    if (started) {
      words.push(word);
      word = "";
      started = false;
    }
  };
  const finishCommand = () => {
    finishWord();
    if (words.length > 0) {
      commands.push(words);
      words = [];
    }
  };
  const addText = (text: string) => {
    word += text;
    started = true;
  };

  while (index < input.length) {
    const character = input[index];
    if (character === undefined || character === "\0") {
      return null;
    }
    if (word.length > MAX_COMMAND_LENGTH) {
      return null;
    }
    if (character === "\\") {
      const next = input[index + 1];
      if (next === undefined) return null;
      if (next !== "\n") addText(next);
      index += 2;
      continue;
    }
    if (character === "'") {
      const end = input.indexOf("'", index + 1);
      if (end < 0) return null;
      addText(input.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (character === "\"") {
      const end = scanDoubleQuote(input, index + 1);
      if (end === null) return null;
      const quoted = input.slice(index + 1, end);
      const expansions = collectExpansions(quoted);
      if (expansions === null) return null;
      substitutions.push(...expansions);
      addText(quoted);
      index = end + 1;
      continue;
    }
    if (character === "$" && input[index + 1] === "(") {
      const end = scanParenthesis(input, index + 1);
      if (end === null) return null;
      substitutions.push(input.slice(index + 2, end));
      addText(SUBSTITUTION_PLACEHOLDER);
      index = end + 1;
      continue;
    }
    if (character === "`") {
      const end = scanBacktick(input, index + 1);
      if (end === null) return null;
      substitutions.push(input.slice(index + 1, end));
      addText(SUBSTITUTION_PLACEHOLDER);
      index = end + 1;
      continue;
    }
    if (character === "<" && input[index + 1] === "<") {
      const header = readHeredocHeader(input, index + 2);
      if (header === null) {
        // `<<` with no delimiter is a here-string or an unfinished line; either
        // way there is no body to skip.
        addText("<<");
        index += 2;
        continue;
      }
      pending.push(header.marker);
      addText(input.slice(index, header.end));
      index = header.end;
      continue;
    }
    if (character === "\n") {
      finishCommand();
      index += 1;
      while (pending.length > 0) {
        const marker = pending.shift();
        if (marker === undefined) break;
        const body: string[] = [];
        let closed = false;
        while (index <= input.length) {
          const lineEnd = input.indexOf("\n", index);
          const line = lineEnd < 0 ? input.slice(index) : input.slice(index, lineEnd);
          index = lineEnd < 0 ? input.length : lineEnd + 1;
          if (line.trim() === marker.delimiter) {
            closed = true;
            break;
          }
          body.push(line);
          if (lineEnd < 0) break;
        }
        // An unterminated heredoc means the command is still being written.
        if (!closed) return null;
        if (marker.expands) {
          const expansions = collectExpansions(body.join("\n"));
          if (expansions === null) return null;
          substitutions.push(...expansions);
        }
      }
      continue;
    }
    if (/\s/u.test(character)) {
      finishWord();
      index += 1;
      continue;
    }
    if (character === ";" || character === "|" || character === "&") {
      finishCommand();
      index += input[index + 1] === character ? 2 : 1;
      continue;
    }
    // Grouping and subshells separate commands; their contents are commands.
    if (character === "(" || character === ")") {
      finishCommand();
      index += 1;
      continue;
    }
    addText(character);
    index += 1;
  }
  finishCommand();
  return pending.length > 0 ? null : { commands, substitutions };
}

function parseShellWords(input: string, depth = 0): string[][] | null {
  if (
    input.length === 0 ||
    input.length > MAX_COMMAND_LENGTH ||
    depth > MAX_SUBSTITUTION_DEPTH
  ) {
    return null;
  }
  const parsed = parseLine(input);
  if (parsed === null) {
    return null;
  }
  const commands = [...parsed.commands];
  for (const substitution of parsed.substitutions) {
    if (substitution.trim().length === 0) continue;
    const nested = parseShellWords(substitution, depth + 1);
    if (nested === null) return null;
    commands.push(...nested);
  }
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
