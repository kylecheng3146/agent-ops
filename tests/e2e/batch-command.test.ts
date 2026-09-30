import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { COMMAND_NAMES } from "../../packages/cli/src/args.js";
import { cleanupE2eRoot, runBuiltCli } from "./helpers.js";

test("every parsed command reaches its handler through the real binary", () => {
  const { root, result: initialized } = runBuiltCli([
    "init", "--scope", "project", "--harness", "codex",
    "--profile", "core", "--yes", "--json"
  ]);
  try {
    assert.equal(initialized.status, 0);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });

    // batch is parsed and handled: an unknown parent is the handler's own
    // answer, never the registry's CLI_COMMAND_UNAVAILABLE.
    const batch = runBuiltCli(["batch", "--parent", "task-missing", "--yes", "--json"], root).result;
    assert.equal(batch.status, 1);
    assert.equal((JSON.parse(batch.stdout) as { code: string }).code, "BATCH_PARENT_NOT_FOUND");
    assert.ok(COMMAND_NAMES.includes("batch"));
  } finally {
    cleanupE2eRoot(root);
  }
});
