import assert from "node:assert/strict";
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
      harness: "both",
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
      harness: "claude",
      profiles: ["core", "guardrails"],
      dryRun: true,
      json: true,
      yes: true
    }
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
  const answers = ["user", "codex", "core,advisory"];
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
    harness: "codex",
    profiles: ["core", "advisory"],
    dryRun: true,
    json: false,
    yes: false
  });
  assert.equal(questions.length, 3);
});
