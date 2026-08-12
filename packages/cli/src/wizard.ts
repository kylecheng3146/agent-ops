import type { Readable, Writable } from "node:stream";

import {
  CliArgumentError,
  type ParsedArgs
} from "./args.js";
import type {
  Harness,
  HarnessId,
  InstallScope,
  Profile,
  ReviewTargetId
} from "../../../runtime/src/contracts.js";
import { DEFAULT_REVIEW_TARGETS } from "../../../runtime/src/review/roles.js";
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
const PROFILES = new Set<string>(["advisory", "core", "guardrails", "loop"]);
const DEFAULT_HARNESS: readonly HarnessId[] = [];
const REVIEW_TARGET_SET = new Set<string>(DEFAULT_REVIEW_TARGETS);

/**
 * External review spawns another paid CLI, so every entry point defaults to
 * off: an absent config field, an absent flag, and this question's default all
 * mean disabled.
 */
export interface ReviewTargetSetup {
  /** Returns false when the target is installed but not authenticated. */
  probeReviewTarget?(target: ReviewTargetId): Promise<boolean>;
  warn?(message: string): void;
}

const REVIEW_TARGET_CHOICES: readonly SelectChoice<ReviewTargetId>[] =
  DEFAULT_REVIEW_TARGETS.map((id) => ({
    label: id,
    value: id,
    description:
      id === "codex"
        ? "Runs with -s read-only; stdout is the bare final message."
        : id === "agy"
          ? "Antigravity CLI; runs with --sandbox --mode plan."
          : "Runs with --permission-mode plan; tried last when it is the host."
  }));

function selectReviewTargets(raw: string): ReviewTargetId[] {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  for (const value of values) {
    if (!REVIEW_TARGET_SET.has(value)) {
      throw new CliArgumentError(
        "CLI_INVALID_VALUE",
        `Invalid review target: ${value}`,
        "--review-target"
      );
    }
  }
  // Declared order wins: the chain order is the option list, not click order.
  return DEFAULT_REVIEW_TARGETS.filter((target) =>
    values.includes(target)
  ) as ReviewTargetId[];
}

function affirmative(raw: string): boolean {
  return /^(y|yes)$/i.test(raw.trim());
}

async function probeReviewTargets(
  targets: readonly ReviewTargetId[],
  setup: ReviewTargetSetup
): Promise<void> {
  const probe = setup.probeReviewTarget;
  if (probe === undefined) {
    return;
  }
  for (const target of targets) {
    if (!(await probe(target))) {
      setup.warn?.(
        `${target} is not usable yet (missing or unauthenticated). ` +
          `Install it or run: ${target} login, ` +
          "then: agent-ops doctor --check-auth"
      );
    }
  }
}

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
    description: "Blocks high-confidence unsafe commands; Stop verification is a separate opt-in feature."
  },
  {
    label: "loop",
    value: "loop",
    description: "Installs the shared Codex and Claude Code local loop with secret and destructive-command interception."
  }
];
const WIZARD_SUBTITLE =
  "Safe setup for Codex, Claude Code, and opencode with profile-driven rules, verification, and hooks.";

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
    throw new CliArgumentError(
      "CLI_INVALID_VALUE",
      "Choose at least one harness."
    );
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
      "Profiles must be a unique comma-separated list of core, advisory, guardrails, or loop."
    );
  }
  return values as Profile[];
}

export async function completeInitChoices(
  args: ParsedArgs,
  io: WizardIo,
  setup: ReviewTargetSetup = {}
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

  const canUseRawSelectors =
    io.input !== undefined &&
    io.output !== undefined &&
    typeof (io.input as SelectIo["input"]).setRawMode === "function" &&
    (io.input as SelectIo["input"]).isTTY === true;
  if (canUseRawSelectors) {
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
              "Enable core, advisory, guardrails, and loop together."
            }
          );
    const enabled =
      args.reviewTargets !== undefined ||
      (await selectOption(
        "External review: call another agent CLI to review your work?",
        [
          { label: "no", value: false, description: "Default. Nothing is spawned." },
          {
            label: "yes",
            value: true,
            description: "Pick target CLIs; each is probed for authentication."
          }
        ],
        selectorIo
      ));
    const reviewTargets = args.reviewTargets ?? (enabled
      ? await selectOptions<ReviewTargetId>(
          "Review targets (multi-select: tried in listed order)",
          REVIEW_TARGET_CHOICES,
          selectorIo,
          []
        )
      : []);
    await probeReviewTargets(reviewTargets, setup);
    return {
      ...args,
      scope,
      harness,
      profiles,
      ...(reviewTargets.length === 0 ? {} : { reviewTargets })
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
          `Harness (${HARNESS_IDS.join(",")}): `
        )
      );
    const profiles =
      args.profiles.length > 0
        ? args.profiles
        : selectProfiles(
            await session.question(
              "Profiles (core,advisory,guardrails,loop) [core]: "
            )
          );

    const reviewTargets = args.reviewTargets ?? (
      affirmative(
        await session.question(
          "Enable external review by another agent CLI? [y/N]: "
        )
      )
        ? selectReviewTargets(
            await session.question(
              `Review targets (${DEFAULT_REVIEW_TARGETS.join(",")}): `
            )
          )
        : []
    );
    await probeReviewTargets(reviewTargets, setup);

    return {
      ...args,
      scope,
      harness,
      profiles,
      ...(reviewTargets.length === 0 ? {} : { reviewTargets })
    };
  } finally {
    session.close();
  }
}
