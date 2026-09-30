import assert from "node:assert/strict";
import test from "node:test";

import { CliArgumentError, COMMAND_NAMES, parseArgs } from "../../packages/cli/src/args.js";
import { COMMAND_HELP_TEXT, HELP_TEXT } from "../../packages/cli/src/cli.js";

function rejected(argv: string[]): string | undefined {
  try {
    parseArgs(argv);
  } catch (error) {
    return error instanceof CliArgumentError ? error.code + ": " + error.message : String(error);
  }
  return undefined;
}

test("batch-args: batch is a command and its options parse", () => {
  assert.ok(COMMAND_NAMES.includes("batch"));
  const minimal = parseArgs(["batch", "--parent", "task-p", "--yes"]);
  assert.equal(minimal.command, "batch");
  assert.equal(minimal.parentTaskId, "task-p");
  assert.equal(minimal.width, undefined);
  const full = parseArgs([
    "batch", "--parent", "task-p", "--yes", "--base", "abc", "--parent-base", "def",
    "--width", "3", "--json", "--output", "batch.json"
  ]);
  assert.equal(full.base, "abc");
  assert.equal(full.parentBase, "def");
  assert.equal(full.width, 3);
  assert.equal(full.output, "batch.json");
  assert.equal(full.json, true);
});

test("batch-args: a missing --parent or --yes, a bad width and repeats are rejected", () => {
  assert.match(rejected(["batch", "--yes"]) ?? "", /--parent/u);
  assert.match(rejected(["batch", "--parent", "task-p"]) ?? "", /--yes/u);
  for (const width of ["0", "-1", "1.5", "two", "1000", ""]) {
    const argv = ["batch", "--parent", "task-p", "--yes", "--width", width];
    assert.ok(rejected(argv) !== undefined, `width ${JSON.stringify(width)}`);
  }
  for (const repeated of [["--width", "2"], ["--base", "a"], ["--parent-base", "a"], ["--parent", "q"]]) {
    const argv = ["batch", "--parent", "task-p", "--yes", ...repeated, ...repeated];
    assert.match(rejected(argv) ?? "", /CLI_DUPLICATE_OPTION/u, repeated.join(" "));
  }
});

test("batch-args: options that belong to other commands are refused", () => {
  const base = ["batch", "--parent", "task-p", "--yes"];
  for (const extra of [
    ["--task", "t"], ["--session", "s"], ["--title", "x"], ["--criterion", "{}"], ["--evidence", "a=b"],
    ["--harness", "claude"], ["--profile", "core"], ["--dry-run"], ["--rerun"]
  ]) {
    assert.ok(rejected([...base, ...extra]) !== undefined, extra.join(" "));
  }
  for (const command of [
    ["review", "--task", "t", "--yes"], ["verify"], ["task", "status"], ["doctor"], ["init"]
  ]) {
    for (const option of [["--width", "2"], ["--parent-base", "abc"]]) {
      assert.match(
        rejected([...command, ...option]) ?? "",
        /only with batch/u,
        `${command[0]} ${option[0]}`
      );
    }
  }
  assert.match(rejected(["review", "--task", "t", "--yes", "--parent", "p"]) ?? "", /--parent/u);
});

test("batch-args: batch --help documents the command", () => {
  const help = parseArgs(["batch", "--help"]);
  assert.equal(help.command, "help");
  assert.equal(help.helpTopic, "batch");
  for (const flag of ["--parent", "--base", "--parent-base", "--width", "--output", "--yes"]) {
    assert.ok(COMMAND_HELP_TEXT.batch.includes(flag), flag);
  }
  assert.match(HELP_TEXT, /batch\s+Verify and review a parent task's subtasks together/u);
  assert.match(HELP_TEXT, /--width <n>/u);
});
