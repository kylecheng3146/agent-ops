import assert from "node:assert/strict";
import test from "node:test";

import { cleanupE2eRoot, runBuiltCli } from "./helpers.js";

test("cancelled non-interactive apply leaves the project unchanged", () => {
  const { root, result } = runBuiltCli([
    "init",
    "--scope",
    "project",
    "--harness",
    "both",
    "--profile",
    "core",
    "--json"
  ]);
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /INIT_CONFIRMATION_REQUIRED/);
  } finally {
    cleanupE2eRoot(root);
  }
});
