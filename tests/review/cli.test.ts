import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";

test("review accepts independent-review options", () => {
  assert.deepEqual(parseArgs([
    "review",
    "--harness",
    "codex",
    "--criterion",
    "tests",
    "--evidence",
    "tests=report.json",
    "--json"
  ]), {
    command: "review",
    harness: "codex",
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
