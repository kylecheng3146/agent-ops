import assert from "node:assert/strict";
import test from "node:test";

import { cleanupE2eRoot, runBuiltCli } from "./helpers.js";

test("packed project lifecycle routes version, init, doctor, task, verify, and review", () => {
  const { root, result } = runBuiltCli([
    "init",
    "--dry-run",
    "--scope",
    "project",
    "--harness",
    "both",
    "--profile",
    "core",
    "--json"
  ]);
  try {
    assert.equal(result.status, 0);
    assert.match(result.stdout, /INIT_PLAN_READY/);

    for (const args of [
      ["--version"],
      ["doctor", "--json"],
      ["task", "status", "--json"],
      ["verify", "--task", "missing", "--json"],
      ["review", "--json"]
    ]) {
      const outcome = runBuiltCli(args, root).result;
      assert.notEqual(outcome.status, 2, `${args.join(" ")} was not routed`);
      if (args[0] !== "--version") {
        assert.doesNotMatch(
          outcome.stdout,
          /CLI_COMMAND_UNAVAILABLE/,
          `${args.join(" ")} is still a placeholder`
        );
      }
    }
  } finally {
    cleanupE2eRoot(root);
  }
});
