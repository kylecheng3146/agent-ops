import type { Readable, Writable } from "node:stream";

import {
  CliArgumentError,
  type ParsedArgs
} from "./args.js";
import type {
  Harness,
  HarnessId,
  InstallScope,
  Profile
} from "../../../runtime/src/contracts.js";
import {
  HARNESS_IDS,
  resolveHarnessSelection
} from "../../../runtime/src/install/harness.js";
import {
  selectOption,
  selectOptions,
  type SelectChoice,
  type SelectIo
} from "./ui.js";

const SCOPES = new Set<string>(["project", "user"]);
const PROFILES = new Set<string>(["advisory", "core", "guardrails"]);
const DEFAULT_HARNESS: readonly HarnessId[] = ["codex", "claude"];

export interface WizardIo {
  isTTY: boolean;
  input?: Readable;
  output?: Writable;
  prompt?(question: string): Promise<string>;
}

const SCOPE_CHOICES: readonly SelectChoice<InstallScope>[] = [
  { label: "project", value: "project" },
  { label: "user", value: "user" }
];
const HARNESS_CHOICES: readonly SelectChoice<HarnessId>[] = HARNESS_IDS.map(
  (id) => ({ label: id, value: id })
);
const PROFILE_CHOICES: readonly SelectChoice<Profile>[] = [
  {
    label: "core",
    value: "core",
    description: "Base rules, task tracking, verification, and review guidance."
  },
  {
    label: "advisory",
    value: "advisory",
    description: "Adds informational SessionStart summaries and local logs; never blocks."
  },
  {
    label: "guardrails",
    value: "guardrails",
    description: "Blocks high-confidence unsafe commands and enables optional Stop verification."
  }
];
const WIZARD_SUBTITLE =
  "Safe setup for Codex + Claude Code with profile-driven rules, verification, and hooks.";

interface PromptSession {
  question(prompt: string): Promise<string>;
  close(): void;
}

async function createPromptSession(io: WizardIo): Promise<PromptSession> {
  if (!io.isTTY) {
    throw new CliArgumentError(
      "CLI_INTERACTIVE_REQUIRED",
      "Missing init choices require an interactive terminal."
    );
  }
  if (io.prompt !== undefined) {
    return {
      question: io.prompt,
      close: () => undefined
    };
  }
  if (io.input === undefined || io.output === undefined) {
    throw new CliArgumentError(
      "CLI_INTERACTIVE_IO_REQUIRED",
      "Interactive input and output streams are unavailable."
    );
  }

  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({
    input: io.input,
    output: io.output
  });
  return {
    question: (prompt) => readline.question(prompt),
    close: () => readline.close()
  };
}

function selectValue<T extends string>(
  raw: string,
  fallback: T,
  allowed: ReadonlySet<string>,
  label: string
): T {
  const value = raw.trim() === "" ? fallback : raw.trim();
  if (!allowed.has(value)) {
    throw new CliArgumentError(
      "CLI_INVALID_VALUE",
      `Invalid ${label}: ${value}`
    );
  }
  return value as T;
}

function selectHarness(raw: string): Harness {
  if (raw.trim() === "") {
    return [...DEFAULT_HARNESS];
  }
  const selection = resolveHarnessSelection(raw);
  if (selection === null) {
    throw new CliArgumentError(
      "CLI_INVALID_VALUE",
      `Harness must be a unique comma-separated list of ${HARNESS_IDS.join(
        ", "
      )}.`
    );
  }
  return selection;
}

function selectProfiles(raw: string): Profile[] {
  const values = raw.trim() === ""
    ? ["core"]
    : raw.split(",").map((value) => value.trim());
  if (
    values.length === 0 ||
    values.some((value) => !PROFILES.has(value)) ||
    new Set(values).size !== values.length
  ) {
    throw new CliArgumentError(
      "CLI_INVALID_VALUE",
      "Profiles must be a unique comma-separated list of core, advisory, or guardrails."
    );
  }
  return values as Profile[];
}

export async function completeInitChoices(
  args: ParsedArgs,
  io: WizardIo
): Promise<ParsedArgs> {
  if (
    args.command !== "init" ||
    (args.scope !== undefined &&
      args.harness !== undefined &&
      args.profiles.length > 0)
  ) {
    return args;
  }
  if (!io.isTTY) {
    throw new CliArgumentError(
      "CLI_INTERACTIVE_REQUIRED",
      "Non-interactive init requires --scope, --harness, and at least one --profile."
    );
  }

  if (io.input !== undefined && io.output !== undefined) {
    const selectorIo: SelectIo = {
      input: io.input as SelectIo["input"],
      output: io.output as SelectIo["output"]
    };
    selectorIo.output.write(`${WIZARD_SUBTITLE}\n\n`);
    const scope =
      args.scope ?? await selectOption("Scope", SCOPE_CHOICES, selectorIo);
    const harness =
      args.harness ??
      await selectOptions<HarnessId>(
        "Harness (multi-select: ↑↓ move, Space toggle, Enter confirm)",
        HARNESS_CHOICES,
        selectorIo,
        [...DEFAULT_HARNESS],
        {
          selectAll: true,
          selectAllLabel: "Select all",
          selectAllDescription: "Install for every supported harness."
        }
      );
    const profiles =
      args.profiles.length > 0
        ? args.profiles
        : await selectOptions<Profile>(
            "Profiles (multi-select: ↑↓ move, Space toggle, Enter confirm)",
            PROFILE_CHOICES,
            selectorIo,
            [],
            {
              selectAll: true,
              selectAllLabel: "Select all",
              selectAllDescription:
                "Enable core, advisory, and guardrails together."
            }
          );
    return {
      ...args,
      scope,
      harness,
      profiles
    };
  }

  const session = await createPromptSession(io);
  try {
    const scope: InstallScope =
      args.scope ??
      selectValue(
        await session.question("Scope (project/user) [project]: "),
        "project",
        SCOPES,
        "scope"
      );
    const harness: Harness =
      args.harness ??
      selectHarness(
        await session.question(
          `Harness (${HARNESS_IDS.join(",")}) [${DEFAULT_HARNESS.join(",")}]: `
        )
      );
    const profiles =
      args.profiles.length > 0
        ? args.profiles
        : selectProfiles(
            await session.question(
              "Profiles (core,advisory,guardrails) [core]: "
            )
          );

    return {
      ...args,
      scope,
      harness,
      profiles
    };
  } finally {
    session.close();
  }
}
