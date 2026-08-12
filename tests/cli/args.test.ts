import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  COMMAND_NAMES,
  CliArgumentError,
  parseArgs
} from "../../packages/cli/src/args.js";
import { completeInitChoices } from "../../packages/cli/src/wizard.js";

test("parses init choices and deterministic defaults", () => {
  assert.deepEqual(
    parseArgs([
      "init",
      "--scope",
      "project",
      "--harness",
      "both",
      "--profile",
      "core"
    ]),
    {
      command: "init",
      scope: "project",
      harness: ["codex", "claude"],
      profiles: ["core"],
      dryRun: false,
      json: false,
      yes: false
    }
  );
});

test("recognizes every top-level command", () => {
  assert.deepEqual(COMMAND_NAMES, [
    "init",
    "config",
    "trust",
    "doctor",
    "update",
    "uninstall",
    "task",
    "verify",
    "review"
  ]);

  for (const command of COMMAND_NAMES) {
    const argv =
      command === "trust" || command === "task"
        ? [command, "status"]
        : [command];
    assert.equal(parseArgs(argv).command, command);
  }
});

test("parses structured task lifecycle arguments", () => {
  assert.deepEqual(
    parseArgs([
      "task",
      "create",
      "--title",
      "Ship task state",
      "--criterion",
      "{\"id\":\"criterion-one\",\"description\":\"One\",\"verifierIds\":[\"unit\"]}",
      "--criterion",
      "{\"id\":\"criterion-two\",\"description\":\"Two\",\"verifierIds\":[\"unit\"]}",
      "--json"
    ]),
    {
      command: "task",
      action: "create",
      profiles: [],
      title: "Ship task state",
      criteria: [
        "{\"id\":\"criterion-one\",\"description\":\"One\",\"verifierIds\":[\"unit\"]}",
        "{\"id\":\"criterion-two\",\"description\":\"Two\",\"verifierIds\":[\"unit\"]}"
      ],
      dryRun: false,
      json: true,
      yes: false
    }
  );
  assert.deepEqual(
    parseArgs([
      "task",
      "complete",
      "--task",
      "task-one",
      "--evidence",
      "criterion-one=evidence/one.json",
      "--evidence",
      "criterion-two=evidence/two.json"
    ]).evidence,
    [
      "criterion-one=evidence/one.json",
      "criterion-two=evidence/two.json"
    ]
  );
});

test("parses verify task or session targets without task mutation options", () => {
  assert.deepEqual(
    parseArgs([
      "verify",
      "--task",
      "task-one",
      "--scope",
      "project",
      "--json"
    ]),
    {
      command: "verify",
      scope: "project",
      profiles: [],
      taskId: "task-one",
      dryRun: false,
      json: true,
      yes: false
    }
  );
  assert.equal(
    parseArgs(["verify", "--session", "session-one"]).sessionId,
    "session-one"
  );
});

test("rejects ignored or conflicting verify options", () => {
  for (const argv of [
    ["verify", "--task", "task-one", "--session", "session-one"],
    ["verify", "--title", "ignored"],
    ["verify", "--criterion", "{}"],
    ["verify", "--evidence", "criterion=reference"],
    ["verify", "--harness", "both"],
    ["verify", "--profile", "core"],
    ["verify", "--dry-run"],
    ["verify", "--yes"]
  ]) {
    assert.throws(
      () => parseArgs(argv),
      (error: unknown) =>
        error instanceof CliArgumentError &&
        error.code === "CLI_OPTION_NOT_ALLOWED",
      argv.join(" ")
    );
  }
});

test("rejects task options that an action would ignore", () => {
  for (const argv of [
    ["task", "create", "--session", "session-one"],
    ["task", "status", "--evidence", "criterion=reference"],
    ["task", "archive", "--title", "ignored"],
    ["task", "export", "--dry-run"]
  ]) {
    assert.throws(
      () => parseArgs(argv),
      (error: unknown) =>
        error instanceof CliArgumentError &&
        error.code === "CLI_OPTION_NOT_ALLOWED",
      argv.join(" ")
    );
  }
});

test("parses repeated profiles and boolean flags", () => {
  assert.deepEqual(
    parseArgs([
      "init",
      "--scope",
      "user",
      "--harness",
      "claude",
      "--profile",
      "core",
      "--profile",
      "guardrails",
      "--dry-run",
      "--json",
      "--yes"
    ]),
    {
      command: "init",
      scope: "user",
      harness: ["claude"],
      profiles: ["core", "guardrails"],
      dryRun: true,
      json: true,
      yes: true
    }
  );
});

test("parses the explicit generic loop profile", () => {
  assert.deepEqual(
    parseArgs([
      "init",
      "--scope",
      "project",
      "--harness",
      "codex,claude",
      "--profile",
      "loop"
    ]),
    {
      command: "init",
      scope: "project",
      harness: ["codex", "claude"],
      profiles: ["loop"],
      dryRun: false,
      json: false,
      yes: false
    }
  );
});

test("parses repeatable explicit hook targets", () => {
  assert.deepEqual(
    parseArgs([
      "init",
      "--scope",
      "project",
      "--harness",
      "claude,codex",
      "--hook-target",
      "claude=project-local",
      "--hook-target",
      "codex=codex-hooks",
      "--profile",
      "guardrails"
    ]).hookTargets,
    [
      { harness: "claude", surfaceId: "project-local" },
      { harness: "codex", surfaceId: "codex-hooks" }
    ]
  );
  for (const argv of [
    ["init", "--hook-target", "claude"],
    ["init", "--hook-target", "claude="],
    [
      "init",
      "--hook-target",
      "claude=project-local",
      "--hook-target",
      "claude=claude-settings"
    ],
    ["doctor", "--hook-target", "claude=project-local"]
  ]) {
    assert.throws(
      () => parseArgs(argv),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error.code === "CLI_INVALID_VALUE" ||
          error.code === "CLI_DUPLICATE_OPTION" ||
          error.code === "CLI_OPTION_NOT_ALLOWED"),
      argv.join(" ")
    );
  }
});

test("parses an explicit offline update target", () => {
  assert.deepEqual(parseArgs(["update", "--target-version", "0.0.1"]), {
    command: "update",
    profiles: [],
    targetVersion: "0.0.1",
    dryRun: false,
    json: false,
    yes: false
  });
  assert.throws(
    () => parseArgs(["doctor", "--target-version", "0.0.1"]),
    (error: unknown) =>
      error instanceof CliArgumentError &&
      error.code === "CLI_OPTION_NOT_ALLOWED"
  );
});

test("parses global help and version actions", () => {
  assert.deepEqual(parseArgs(["--help"]), {
    command: "help",
    profiles: [],
    dryRun: false,
    json: false,
    yes: false
  });
  assert.deepEqual(parseArgs(["--json", "--version"]), {
    command: "version",
    profiles: [],
    dryRun: false,
    json: true,
    yes: false
  });
});

test("rejects unknown flags and commands with stable codes", () => {
  assert.throws(
    () => parseArgs(["init", "--unknown"]),
    (error: unknown) =>
      error instanceof CliArgumentError &&
      error.code === "CLI_UNKNOWN_OPTION"
  );
  assert.throws(
    () => parseArgs(["destroy"]),
    (error: unknown) =>
      error instanceof CliArgumentError &&
      error.code === "CLI_UNKNOWN_COMMAND"
  );
});

test("rejects missing and invalid option values", () => {
  for (const option of ["--scope", "--harness", "--profile"]) {
    assert.throws(
      () => parseArgs(["init", option]),
      (error: unknown) =>
        error instanceof CliArgumentError &&
        error.code === "CLI_MISSING_VALUE",
      option
    );
  }

  for (const argv of [
    ["init", "--scope", "global"],
    ["init", "--harness", "cursor"],
    ["init", "--profile", "unsafe"]
  ]) {
    assert.throws(
      () => parseArgs(argv),
      (error: unknown) =>
        error instanceof CliArgumentError &&
        error.code === "CLI_INVALID_VALUE",
      argv.join(" ")
    );
  }
});

test("rejects duplicate singleton options and profiles", () => {
  for (const argv of [
    ["init", "--scope", "project", "--scope", "user"],
    ["init", "--harness", "both", "--harness", "codex"],
    ["init", "--profile", "core", "--profile", "core"],
    ["init", "--json", "--json"]
  ]) {
    assert.throws(
      () => parseArgs(argv),
      (error: unknown) =>
        error instanceof CliArgumentError &&
        error.code === "CLI_DUPLICATE_OPTION",
      argv.join(" ")
    );
  }
});

test("non-TTY init never infers missing choices, including with --yes", async () => {
  let promptCalls = 0;

  await assert.rejects(
    completeInitChoices(parseArgs(["init", "--yes"]), {
      isTTY: false,
      prompt: async () => {
        promptCalls += 1;
        return "";
      }
    }),
    (error: unknown) =>
      error instanceof CliArgumentError &&
      error.code === "CLI_INTERACTIVE_REQUIRED"
  );
  assert.equal(promptCalls, 0);
});

test("TTY wizard fills only missing choices through injected prompts", async () => {
  // The fourth answer declines external review, which is also the default.
  const answers = ["user", "codex", "core,advisory", ""];
  const questions: string[] = [];
  const parsed = parseArgs(["init", "--dry-run"]);

  const completed = await completeInitChoices(parsed, {
    isTTY: true,
    prompt: async (question) => {
      questions.push(question);
      return answers.shift() ?? "";
    }
  });

  assert.deepEqual(completed, {
    command: "init",
    scope: "user",
    harness: ["codex"],
    profiles: ["core", "advisory"],
    dryRun: true,
    json: false,
    yes: false
  });
  assert.equal(questions.length, 4);
  assert.match(questions[3] ?? "", /external review/i);
});

test("TTY wizard accepts loop as the selected profile", async () => {
  const answers = ["project", "claude", "loop"];
  const completed = await completeInitChoices(parseArgs(["init"]), {
    isTTY: true,
    prompt: async () => answers.shift() ?? ""
  });

  assert.deepEqual(completed, {
    command: "init",
    scope: "project",
    harness: ["claude"],
    profiles: ["loop"],
    dryRun: false,
    json: false,
    yes: false
  });
});

test("TTY wizard requires an explicit harness when no default is selected", async () => {
  const answers = ["project", "", "core"];

  await assert.rejects(
    completeInitChoices(parseArgs(["init"]), {
      isTTY: true,
      prompt: async () => answers.shift() ?? ""
    }),
    (error: unknown) =>
      error instanceof CliArgumentError &&
      error.code === "CLI_INVALID_VALUE" &&
      error.message === "Choose at least one harness."
  );
});

test("TTY-like input does not infer a harness when raw mode is unavailable", async () => {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true });
  const output = new PassThrough();
  const completion = completeInitChoices(parseArgs(["init"]), {
    isTTY: true,
    input,
    output
  });
  setTimeout(() => input.write("project\n"), 10);
  setTimeout(() => input.write("\n"), 30);
  setTimeout(() => input.end("core\n"), 50);

  await assert.rejects(
    completion,
    (error: unknown) =>
      error instanceof CliArgumentError &&
      error.code === "CLI_INVALID_VALUE" &&
      error.message === "Choose at least one harness."
  );
});

test("accepts harness lists, aliases, and rejects unusable selections", () => {
  assert.deepEqual(
    parseArgs(["init", "--harness", "codex,claude", "--profile", "core"])
      .harness,
    ["codex", "claude"]
  );
  assert.deepEqual(
    parseArgs(["init", "--harness", "all", "--profile", "core"]).harness,
    ["codex", "claude", "opencode"]
  );
  assert.deepEqual(
    parseArgs(["init", "--harness", "both", "--profile", "core"]).harness,
    ["codex", "claude"]
  );
  assert.deepEqual(
    parseArgs(["init", "--harness", "opencode", "--profile", "core"]).harness,
    ["opencode"]
  );

  for (const value of ["codex,codex", "codex,cursor", ""]) {
    assert.throws(
      () => parseArgs(["init", "--harness", value, "--profile", "core"]),
      (error: unknown) =>
        error instanceof CliArgumentError &&
        error.code === "CLI_INVALID_VALUE",
      value
    );
  }
});

test("review requires exactly one harness", () => {
  assert.deepEqual(
    parseArgs(["review", "--harness", "claude"]).harness,
    ["claude"]
  );
  for (const value of ["all", "both", "codex,claude"]) {
    assert.throws(
      () => parseArgs(["review", "--harness", value]),
      (error: unknown) =>
        error instanceof CliArgumentError &&
        error.code === "CLI_INVALID_VALUE",
      value
    );
  }
});
