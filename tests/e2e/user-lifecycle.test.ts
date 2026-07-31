import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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

test("user-scope opencode uses the global plugin directory", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agent-ops-user-project-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "agent-ops-user-home-"));
  const { root, result } = runBuiltCli([
    "init",
    "--scope",
    "user",
    "--harness",
    "opencode",
    "--profile",
    "advisory",
    "--yes",
    "--json"
  ], projectRoot, homeRoot);
  try {
    assert.equal(result.status, 0);
    assert.match(result.stdout, /INIT_APPLIED/);
    const pluginPath = join(
      homeRoot,
      ".config/opencode/plugins/agent-ops.js"
    );
    assert.match(await readFile(pluginPath, "utf8"), /Managed by agent-ops/u);

    const doctor = runBuiltCli(
      ["doctor", "--scope", "user", "--json"],
      projectRoot,
      homeRoot
    ).result;
    assert.match(doctor.stdout, /"id":"hook-registration"/u);
    assert.match(doctor.stdout, /"status":"PASS"/u);

    const uninstall = runBuiltCli(
      ["uninstall", "--scope", "user", "--yes", "--json"],
      projectRoot,
      homeRoot
    ).result;
    assert.equal(uninstall.status, 0);
    assert.match(uninstall.stdout, /UNINSTALL_APPLIED/);
  } finally {
    cleanupE2eRoot(projectRoot);
    cleanupE2eRoot(homeRoot);
  }
});

test("user-scope opencode doctor follows the manifest plugin path", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "agent-ops-user-project-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "agent-ops-user-home-"));
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = join(homeRoot, "custom-xdg");
    const initialized = runBuiltCli([
      "init",
      "--scope",
      "user",
      "--harness",
      "opencode",
      "--profile",
      "advisory",
      "--yes",
      "--json"
    ], projectRoot, homeRoot).result;
    assert.equal(initialized.status, 0);
    assert.match(
      await readFile(
        join(homeRoot, "custom-xdg/opencode/plugins/agent-ops.js"),
        "utf8"
      ),
      /Managed by agent-ops/u
    );

    delete process.env.XDG_CONFIG_HOME;
    const doctor = runBuiltCli(
      ["doctor", "--scope", "user", "--json"],
      projectRoot,
      homeRoot
    ).result;
    assert.match(
      doctor.stdout,
      /"id":"hook-registration".*"status":"PASS"/u
    );
  } finally {
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
    cleanupE2eRoot(projectRoot);
    cleanupE2eRoot(homeRoot);
  }
});
