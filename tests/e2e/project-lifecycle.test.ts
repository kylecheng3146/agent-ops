import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { cleanupE2eRoot, runBuiltCli } from "./helpers.js";

test("project lifecycle applies, trusts, routes, and uninstalls managed state", async () => {
  const { root, result } = runBuiltCli([
    "init",
    "--scope",
    "project",
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
    await access(join(root, ".agent-ops", "manifest.json"));

    const dryRun = runBuiltCli([
      "init", "--dry-run", "--scope", "project", "--harness", "both",
      "--profile", "core", "--json"
    ], root).result;
    assert.equal(dryRun.status, 0);
    assert.match(dryRun.stdout, /INIT_PLAN_READY/);

    const granted = runBuiltCli(["trust", "grant", "--yes", "--json"], root).result;
    assert.equal(granted.status, 0);
    assert.match(granted.stdout, /TRUST_GRANTED/);
    const trusted = runBuiltCli(["trust", "status", "--json"], root).result;
    assert.equal(trusted.status, 0);
    assert.match(trusted.stdout, /TRUSTED/);
    const revoked = runBuiltCli(["trust", "revoke", "--json"], root).result;
    assert.equal(revoked.status, 0);
    assert.match(revoked.stdout, /TRUST_REVOKED/);

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

    const uninstallPlan = runBuiltCli(["uninstall", "--dry-run", "--json"], root).result;
    assert.equal(uninstallPlan.status, 0);
    assert.match(uninstallPlan.stdout, /UNINSTALL_PLAN_READY/);
    const uninstall = runBuiltCli(["uninstall", "--yes", "--json"], root).result;
    assert.equal(uninstall.status, 0);
    assert.match(uninstall.stdout, /UNINSTALL_APPLIED/);
    await assert.rejects(access(join(root, ".agent-ops", "manifest.json")));
  } finally {
    cleanupE2eRoot(root);
  }
});
