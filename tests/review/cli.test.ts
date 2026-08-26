import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";

test("review accepts independent-review options", () => {
  assert.deepEqual(parseArgs([
    "review",
    "--harness",
    "codex",
    "--task",
    "task-one",
    "--criterion",
    "tests",
    "--evidence",
    "tests=report.json",
    "--json"
  ]), {
    command: "review",
    harness: ["codex"],
    taskId: "task-one",
    criteria: ["tests"],
    evidence: ["tests=report.json"],
    profiles: [],
    dryRun: false,
    json: true,
    yes: false
  });
});

test("review accepts --yes as explicit reviewer authorization", () => {
  assert.equal(parseArgs(["review", "--yes"]).yes, true);
});

test("review accepts one --base and rejects it elsewhere", () => {
  assert.equal(parseArgs(["review", "--base", "origin/main"]).base, "origin/main");
  assert.throws(() => parseArgs(["review", "--base", "a", "--base", "b"]));
  assert.throws(() => parseArgs(["task", "status", "--base", "origin/main"]));
});

test("review rejects the multi-harness selection", () => {
  assert.throws(
    () => parseArgs(["review", "--harness", "both"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CLI_INVALID_VALUE"
  );
});
