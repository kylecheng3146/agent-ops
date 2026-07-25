import assert from "node:assert/strict";
import test from "node:test";

import { cleanupE2eRoot, runBuiltCli } from "./helpers.js";

test("user-scope lifecycle is isolated under the injected home", async () => {
  const { root, result } = runBuiltCli([
    "init",
    "--scope",
    "user",
    "--harness",
    "both",
    "--profile",
    "core",
    "--yes",
    "--json"
  ]);
  try {
    assert.equal(result.status, 0);
    assert.match(result.stdout, /INIT_APPLIED/);
    const uninstall = runBuiltCli(["uninstall", "--yes", "--json"], root).result;
    assert.equal(uninstall.status, 0);
    assert.match(uninstall.stdout, /UNINSTALL_APPLIED|UNINSTALL_NOT_INSTALLED/);
  } finally {
    cleanupE2eRoot(root);
  }
});
