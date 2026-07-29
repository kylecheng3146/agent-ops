import type { Readable, Writable } from "node:stream";

// figlet "agent-ops" -f Standard, trimmed of trailing blank lines/columns.
const BANNER = [
  "                         _",
  "   __ _  __ _  ___ _ __ | |_       ___  _ __  ___ ",
  "  / _\` |/ _\` |/ _ \\ '_ \\| __|____ / _ \\| '_ \\/ __|",
  " | (_| | (_| |  __/ | | | ||_____| (_) | |_) \\__ \\",
  "  \\__,_|\\__, |\\___|_| |_|\\__|     \\___/| .__/|___/",
  "        |___/                          |_|"
].join("\n");

const TAGLINE = "loop engineering toolkit";
const MIN_BANNER_COLUMNS = 54;
const RAIL = "\u2502";
const DIAMOND = "\u25c6";
const DOT_ON = "\u25cf";
const DOT_OFF = "\u25cb";

export interface UiOutput {
  readonly isTTY: boolean;
  readonly columns?: number;
  write(value: string): void;
}

function envColorPreference(): "on" | "off" | undefined {
  if (process.env.NO_COLOR !== undefined) {
    return "off";
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return "on";
  }
  return undefined;
}

function useColor(output: UiOutput): boolean {
  const preference = envColorPreference();
  return preference === undefined ? output.isTTY : preference === "on";
}

function paint(output: UiOutput, code: string, text: string): string {
  return useColor(output) ? `\u001b[${code}m${text}\u001b[0m` : text;
}

const dim = (output: UiOutput, text: string) => paint(output, "2", text);
const bold = (output: UiOutput, text: string) => paint(output, "1", text);
const green = (output: UiOutput, text: string) => paint(output, "32", text);
const cyan = (output: UiOutput, text: string) => paint(output, "36", text);

/**
 * Decorative only: skipped for --json output, non-interactive runs, and
 * terminals too narrow to render the wordmark without wrapping.
 */
export function writeBanner(output: UiOutput): void {
  if (!output.isTTY || (output.columns ?? 0) < MIN_BANNER_COLUMNS) {
    return;
  }
  output.write(`${cyan(output, BANNER)}\n${dim(output, TAGLINE)}\n\n`);
}

export interface RawInput extends Readable {
  isTTY?: boolean;
  setRawMode?(mode: boolean): void;
}

export interface SelectIo {
  readonly input: RawInput;
  readonly output: Writable & { columns?: number };
}

function eraseLines(write: (value: string) => void, count: number): void {
  for (let index = 0; index < count; index += 1) {
    write("\u001b[1A\u001b[2K");
  }
}

function renderChoice(
  outputLike: UiOutput,
  question: string,
  value: boolean
): string {
  const yes = value
    ? bold(outputLike, green(outputLike, `${DOT_ON} Yes`))
    : dim(outputLike, `${DOT_OFF} Yes`);
  const no = !value
    ? bold(outputLike, green(outputLike, `${DOT_ON} No`))
    : dim(outputLike, `${DOT_OFF} No`);
  return [
    `${bold(outputLike, DIAMOND)}  ${question}`,
    `${dim(outputLike, RAIL)}  ${yes} / ${no}`
  ].join("\n");
}

async function typedFallback(
  question: string,
  io: SelectIo,
  defaultValue: boolean
): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({ input: io.input, output: io.output });
  try {
    const suffix = defaultValue ? "Y/n" : "y/N";
    const answer = (
      await readline.question(`${question} [${suffix}]: `)
    ).trim().toLowerCase();
    if (answer === "") {
      return defaultValue;
    }
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

/**
 * Arrow-key Yes/No selector. Falls back to a typed y/N prompt when stdin
 * cannot enter raw mode (piped input, or a stub stream in tests), so the
 * same call works under both a real terminal and test harnesses.
 */
export async function selectYesNo(
  question: string,
  io: SelectIo,
  defaultValue = false
): Promise<boolean> {
  if (
    typeof io.input.setRawMode !== "function" ||
    io.input.isTTY !== true
  ) {
    return await typedFallback(question, io, defaultValue);
  }

  const outputLike: UiOutput = {
    isTTY: true,
    columns: io.output.columns,
    write: (value) => io.output.write(value)
  };
  const { emitKeypressEvents } = await import("node:readline");
  emitKeypressEvents(io.input);
  io.input.setRawMode(true);
  io.input.resume();

  let value = defaultValue;
  let rendered = renderChoice(outputLike, question, value);
  io.output.write(`${rendered}\n`);

  return await new Promise<boolean>((resolve) => {
    const cleanup = () => {
      io.input.setRawMode?.(false);
      io.input.pause();
      io.input.removeListener("keypress", onKeypress);
    };
    const redraw = () => {
      eraseLines(
        (value_) => io.output.write(value_),
        rendered.split("\n").length
      );
      rendered = renderChoice(outputLike, question, value);
      io.output.write(`${rendered}\n`);
    };
    const onKeypress = (
      _chunk: string,
      key: { name?: string; ctrl?: boolean } | undefined
    ) => {
      if (key?.ctrl === true && key.name === "c") {
        cleanup();
        process.exit(130);
      }
      if (
        key?.name === "left" ||
        key?.name === "right" ||
        key?.name === "tab" ||
        key?.name === "h" ||
        key?.name === "l"
      ) {
        value = !value;
        redraw();
        return;
      }
      if (key?.name === "return" || key?.name === "space") {
        cleanup();
        resolve(value);
      }
    };
    io.input.on("keypress", onKeypress);
  });
}
