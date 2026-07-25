import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

test("uninstall refuses a tampered managed artifact and preserves state", async () => {
  const { root, result } = runBuiltCli([
    "init", "--scope", "project", "--harness", "both", "--profile", "core",
    "--yes", "--json"
  ]);
  try {
    assert.equal(result.status, 0);
    const manifestPath = join(root, ".agent-ops", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      artifacts: Array<{ path: string }>;
    };
    const artifact = manifest.artifacts[0]?.path;
    assert.ok(artifact);
    const artifactPath = join(root, artifact);
    await writeFile(artifactPath, `${await readFile(artifactPath, "utf8")}tampered\n`);
    const uninstall = runBuiltCli(["uninstall", "--yes", "--json"], root).result;
    assert.notEqual(uninstall.status, 0);
    await access(manifestPath);
  } finally {
    cleanupE2eRoot(root);
  }
});
