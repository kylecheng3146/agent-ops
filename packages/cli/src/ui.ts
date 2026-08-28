import type { Readable, Writable } from "node:stream";

// figlet "agent-ops" -f Standard, trimmed of trailing blank lines/columns.
export const BANNER = [
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

export interface SelectChoice<T> {
  readonly label: string;
  readonly value: T;
  readonly description?: string;
}

export interface SelectOptionsOptions {
  readonly startEmpty?: boolean;
  readonly selectAll?: boolean;
  readonly selectAllLabel?: string;
  readonly selectAllDescription?: string;
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

async function typedChoice<T>(
  question: string,
  choices: readonly SelectChoice<T>[],
  io: SelectIo,
  defaultIndex: number
): Promise<T> {
  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({ input: io.input, output: io.output });
  try {
    const options = choices
      .map((choice, index) => `${index + 1}: ${choice.label}`)
      .join(", ");
    const answer = (
      await readline.question(`${question} [${options}]: `)
    ).trim();
    if (answer === "") {
      return choices[defaultIndex]!.value;
    }
    const index = Number.parseInt(answer, 10) - 1;
    if (Number.isInteger(index) && choices[index] !== undefined) {
      return choices[index]!.value;
    }
    const match = choices.find(
      (choice) => choice.label.toLowerCase() === answer.toLowerCase()
    );
    return match?.value ?? choices[defaultIndex]!.value;
  } finally {
    readline.close();
  }
}

function renderChoices<T>(
  outputLike: UiOutput,
  question: string,
  choices: readonly SelectChoice<T>[],
  selected: ReadonlySet<number>,
  vertical = false,
  selectAll = false,
  selectAllLabel = "Select all",
  selectAllDescription?: string,
  focusedIndex = 0
): string {
  const renderChoice = (
    choice: SelectChoice<T>,
    active: boolean,
    focused: boolean
  ): string[] => {
    const label = `${active ? DOT_ON : DOT_OFF} ${choice.label}`;
    const cursor = focused ? "❯ " : "  ";
    const renderedLabel = active
      ? bold(outputLike, green(outputLike, label))
      : dim(outputLike, label);
    const lines = [
      vertical
        ? `${dim(outputLike, RAIL)}  ${cursor}${renderedLabel}`
        : `${cursor}${renderedLabel}`
    ];
    if (vertical && choice.description !== undefined) {
      lines.push(`${dim(outputLike, RAIL)}    ${dim(outputLike, choice.description)}`);
    }
    return lines;
  };
  const allActive = selectAll && selected.size === choices.length;
  const renderedChoices = [
    ...(selectAll
      ? renderChoice(
          {
            label: selectAllLabel,
            value: undefined as T,
            description: selectAllDescription
          },
          allActive,
          selectAll && focusedIndex === 0
        )
      : []),
    ...choices.flatMap((choice, index) => {
      const active = selected.has(index);
      const focused = (selectAll ? index + 1 : index) === focusedIndex;
      return renderChoice(choice, active, focused);
    })
  ];
  const rendered = vertical
    ? renderedChoices
    : [`${dim(outputLike, RAIL)}  ${renderedChoices.join(" / ")}`];
  return [
    `${bold(outputLike, DIAMOND)}  ${question}`,
    ...rendered
  ].join("\n");
}

function assertChoices<T>(choices: readonly SelectChoice<T>[]): void {
  if (choices.length === 0) {
    throw new Error("At least one selector choice is required.");
  }
}

/** Single-value selector for interactive wizard choices. */
export async function selectOption<T>(
  question: string,
  choices: readonly SelectChoice<T>[],
  io: SelectIo,
  defaultIndex = 0
): Promise<T> {
  assertChoices(choices);
  const initialIndex = Math.min(
    Math.max(defaultIndex, 0),
    choices.length - 1
  );
  if (
    typeof io.input.setRawMode !== "function" ||
    io.input.isTTY !== true
  ) {
    return await typedChoice(question, choices, io, initialIndex);
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

  let index = initialIndex;
  let rendered = renderChoices(
    outputLike,
    question,
    choices,
    new Set([index]),
    false,
    false,
    "Select all",
    undefined,
    index
  );
  io.output.write(`${rendered}\n`);

  return await new Promise<T>((resolve) => {
    const cleanup = () => {
      io.input.setRawMode?.(false);
      io.input.pause();
      io.input.removeListener("keypress", onKeypress);
    };
    const redraw = () => {
      eraseLines(
        (value) => io.output.write(value),
        rendered.split("\n").length
      );
      rendered = renderChoices(
        outputLike,
        question,
        choices,
        new Set([index]),
        false,
        false,
        "Select all",
        undefined,
        index
      );
      io.output.write(`${rendered}\n`);
    };
    const move = (delta: number) => {
      index = (index + delta + choices.length) % choices.length;
      redraw();
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
        key?.name === "up" ||
        key?.name === "left" ||
        key?.name === "h"
      ) {
        move(-1);
        return;
      }
      if (
        key?.name === "down" ||
        key?.name === "right" ||
        key?.name === "tab" ||
        key?.name === "l"
      ) {
        move(1);
        return;
      }
      if (key?.name === "home") {
        index = 0;
        redraw();
        return;
      }
      if (key?.name === "end") {
        index = choices.length - 1;
        redraw();
        return;
      }
      if (key?.name === "return" || key?.name === "space") {
        cleanup();
        resolve(choices[index]!.value);
      }
    };
    io.input.on("keypress", onKeypress);
  });
}

/** Multi-value selector. Space toggles a choice; Enter confirms. */
export async function selectOptions<T>(
  question: string,
  choices: readonly SelectChoice<T>[],
  io: SelectIo,
  defaultValues: readonly T[] = [],
  options: SelectOptionsOptions = {}
): Promise<T[]> {
  assertChoices(choices);
  const defaultIndexes = new Set(
    choices.flatMap((choice, index) =>
      defaultValues.includes(choice.value) ? [index] : []
    )
  );
  if (
    defaultIndexes.size === 0 &&
    options.selectAll !== true &&
    options.startEmpty !== true
  ) {
    defaultIndexes.add(0);
  }
  if (
    typeof io.input.setRawMode !== "function" ||
    io.input.isTTY !== true
  ) {
    const value = await typedChoice(question, choices, io, 0);
    return [value];
  }

  const selectAll = options.selectAll === true;
  const choiceCount = choices.length + (selectAll ? 1 : 0);
  const outputLike: UiOutput = {
    isTTY: true,
    columns: io.output.columns,
    write: (value) => io.output.write(value)
  };
  const { emitKeypressEvents } = await import("node:readline");
  emitKeypressEvents(io.input);
  io.input.setRawMode(true);
  io.input.resume();

  let index = 0;
  const selected = new Set(defaultIndexes);
  let selectionHintShown = false;
  let rendered = renderChoices(
    outputLike,
    question,
    choices,
    selected,
    true,
    selectAll,
    options.selectAllLabel,
    options.selectAllDescription,
    index
  );
  io.output.write(`${rendered}\n`);

  return await new Promise<T[]>((resolve) => {
    const cleanup = () => {
      io.input.setRawMode?.(false);
      io.input.pause();
      io.input.removeListener("keypress", onKeypress);
    };
    const redraw = () => {
      eraseLines(
        (value) => io.output.write(value),
        rendered.split("\n").length
      );
      selectionHintShown = false;
      rendered = renderChoices(
        outputLike,
        question,
        choices,
        selected,
        true,
        selectAll,
        options.selectAllLabel,
        options.selectAllDescription,
        index
      );
      io.output.write(`${rendered}\n`);
    };
    const move = (delta: number) => {
      index = (index + delta + choiceCount) % choiceCount;
      redraw();
    };
    const onKeypress = (
      _chunk: string,
      key: { name?: string; ctrl?: boolean } | undefined
    ) => {
      if (key?.ctrl === true && key.name === "c") {
        cleanup();
        process.exit(130);
      }
      if (key?.name === "up" || key?.name === "left") {
        move(-1);
        return;
      }
      if (
        key?.name === "down" ||
        key?.name === "right" ||
        key?.name === "tab"
      ) {
        move(1);
        return;
      }
      if (key?.name === "space") {
        if (selectAll && index === 0) {
          if (selected.size === choices.length) {
            selected.clear();
            selected.add(0);
          } else {
            choices.forEach((_choice, choiceIndex) => {
              selected.add(choiceIndex);
            });
          }
        } else {
          const choiceIndex = selectAll ? index - 1 : index;
          if (selected.has(choiceIndex)) {
            if (selected.size > 1) {
              selected.delete(choiceIndex);
            }
          } else {
            selected.add(choiceIndex);
          }
        }
        redraw();
        return;
      }
      if (key?.name === "return") {
        if (selected.size === 0) {
          if (!selectionHintShown) {
            rendered = `${rendered}\n${dim(
              outputLike,
              `${RAIL}  Choose at least one option with Space.`
            )}`;
            selectionHintShown = true;
            io.output.write(`${rendered}\n`);
          }
          return;
        }
        cleanup();
        resolve(
          choices
            .filter((_choice, choiceIndex) => selected.has(choiceIndex))
            .map((choice) => choice.value)
        );
      }
    };
    io.input.on("keypress", onKeypress);
  });
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
