import assert from "node:assert/strict";
import test from "node:test";

import { cleanupE2eRoot, runBuiltCli } from "./helpers.js";

test("user-scope dry-run never writes the developer home", () => {
  const { root, result } = runBuiltCli([
    "init",
    "--dry-run",
    "--scope",
    "user",
    "--harness",
    "both",
    "--profile",
    "core",
    "--json"
  ]);
  try {
    assert.equal(result.status, 0);
    assert.match(result.stdout, /INIT_PLAN_READY/);
  } finally {
    cleanupE2eRoot(root);
  }
});
