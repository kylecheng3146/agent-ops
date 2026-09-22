import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";

test("review accepts the complete task-bound invocation", () => {
  assert.deepEqual(parseArgs([
    "review",
    "--task",
    "task-one",
    "--yes",
    "--json"
  ]), {
    command: "review",
    taskId: "task-one",
    profiles: [],
    dryRun: false,
    json: true,
    yes: true,
    rerun: false
  });
});

test("review requires --yes as explicit reviewer authorization", () => {
  assert.throws(() => parseArgs(["review", "--task", "task-one"]));
});

test("review accepts one --base and rejects it elsewhere", () => {
  assert.equal(parseArgs(["review", "--task", "task-one", "--yes", "--base", "origin/main"]).base, "origin/main");
  assert.throws(() => parseArgs(["review", "--task", "task-one", "--yes", "--base", "a", "--base", "b"]));
  assert.throws(() => parseArgs(["task", "status", "--base", "origin/main"]));
});

test("review rejects harness selection so configuration owns the pair", () => {
  assert.throws(
    () => parseArgs(["review", "--task", "task-one", "--yes", "--harness", "claude"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CLI_OPTION_NOT_ALLOWED"
  );
});
