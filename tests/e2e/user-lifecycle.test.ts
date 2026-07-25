import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanupE2eRoot, runBuiltCli } from "./helpers.js";

test("user-scope lifecycle is isolated under the injected home", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agent-ops-user-project-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "agent-ops-user-home-"));
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
  ], projectRoot, homeRoot);
  try {
    assert.equal(result.status, 0);
    assert.match(result.stdout, /INIT_APPLIED/);
    const explained = runBuiltCli(
      ["config", "explain", "--scope", "user", "--json"],
      projectRoot,
      homeRoot
    ).result;
    assert.equal(explained.status, 0);
    assert.match(explained.stdout, /"source":"user"/);
    const uninstall = runBuiltCli(
      ["uninstall", "--scope", "user", "--yes", "--json"],
      projectRoot,
      homeRoot
    ).result;
    assert.equal(uninstall.status, 0);
    assert.match(uninstall.stdout, /UNINSTALL_APPLIED|UNINSTALL_NOT_INSTALLED/);
  } finally {
    cleanupE2eRoot(projectRoot);
    cleanupE2eRoot(homeRoot);
  }
});
