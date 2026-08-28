import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { CLI_VERSION } from "../../packages/cli/src/version.js";
import { cleanupE2eRoot, runBuiltCli } from "./helpers.js";

const CODEX_DESIRED_BODY =
  "Load `.agent-ops/AGENTS.md` as the agent-ops managed baseline.\nProject-specific instructions in this file remain authoritative.";
const CODEX_LEGACY_BODY =
  "Use `.agent-ops/AGENTS.md` as the canonical Loop Engineering specification for this project.";
const CLAUDE_DESIRED_BODY =
  "@.agent-ops/CLAUDE.md\n\nThe file above is the agent-ops managed baseline.\nProject-specific instructions in this file remain authoritative.";
const CLAUDE_LEGACY_BODY =
  "Use `.agent-ops/CLAUDE.md` as the canonical Loop Engineering specification for this project.";

test("project lifecycle applies, trusts, routes, and uninstalls managed state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-e2e-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } })
  );
  await writeFile(join(root, "package-lock.json"), "{}\n");
  const { result } = runBuiltCli([
    "init",
    "--scope",
    "project",
    "--harness",
    "both",
    "--profile",
    "core",
    "--yes",
    "--json"
  ], root);
  try {
    assert.equal(result.status, 0);
    assert.match(result.stdout, /INIT_APPLIED/);
    assert.equal(JSON.parse(result.stdout).data.plan.trust.action, "grant");
    await access(join(root, ".agent-ops", "manifest.json"));

    const dryRun = runBuiltCli([
      "init", "--dry-run", "--scope", "project", "--harness", "both",
      "--profile", "core", "--json"
    ], root).result;
    assert.equal(dryRun.status, 0);
    assert.match(dryRun.stdout, /INIT_PLAN_READY/);

    const explained = runBuiltCli(["config", "explain", "--json"], root).result;
    assert.equal(explained.status, 0);
    assert.match(explained.stdout, /"source":"project"/);
    const explainedPayload = JSON.parse(explained.stdout) as {
      data?: {
        profiles?: readonly {
          source?: string;
          sourcePath?: string;
        }[];
      };
    };
    const projectSourcePath = explainedPayload.data?.profiles?.find(
      (profile) => profile.source === "project"
    )?.sourcePath ?? "";
    assert.match(projectSourcePath, /[\\/]\.agent-ops[\\/]config\.json$/u);
    const configPath = join(root, ".agent-ops", "config.json");
    const validConfig = await readFile(configPath, "utf8");
    await writeFile(configPath, "{broken\n");
    const invalidConfig = runBuiltCli(["config", "explain", "--json"], root).result;
    assert.notEqual(invalidConfig.status, 0);
    await writeFile(configPath, validConfig);

    const trusted = runBuiltCli(["trust", "status", "--json"], root).result;
    assert.equal(trusted.status, 0);
    assert.match(trusted.stdout, /TRUSTED/);
    const revoked = runBuiltCli(["trust", "revoke", "--json"], root).result;
    assert.equal(revoked.status, 0);
    assert.match(revoked.stdout, /TRUST_REVOKED/);

    const updatePlan = runBuiltCli([
      "update", "--target-version", "0.0.1", "--dry-run", "--json"
    ], root).result;
    assert.equal(updatePlan.status, 0);
    assert.match(updatePlan.stdout, /UPDATE_PLAN_READY/);
    const updated = runBuiltCli([
      "update", "--target-version", "0.0.1", "--yes", "--json"
    ], root).result;
    assert.equal(updated.status, 0);
    assert.match(updated.stdout, /UPDATE_APPLIED/);
    assert.equal(
      JSON.parse(updated.stdout).data.plan.installation.trust.action,
      "grant"
    );
    assert.match(
      runBuiltCli(["trust", "status", "--json"], root).result.stdout,
      /TRUSTED/
    );
    assert.ok(
      (await readFile(join(root, ".agent-ops", "AGENTS.md"), "utf8")).includes(
        `Toolkit version: ${CLI_VERSION}`
      )
    );
    const doctorAfterUpdate = runBuiltCli(["doctor", "--json"], root).result;
    const doctorPayload = JSON.parse(doctorAfterUpdate.stdout) as {
      data?: {
        report?: {
          checks?: readonly {
            id?: string;
            status?: string;
          }[];
        };
      };
    };
    assert.equal(
      doctorPayload.data?.report?.checks?.find(
        ({ id }) => id === "artifact-staleness"
      )?.status,
      "PASS"
    );

    await writeFile(join(root, "unmanaged.txt"), "keep me\n");

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
    assert.deepEqual(
      JSON.parse(
        await readFile(join(root, ".agent-ops", "state", "trust.json"), "utf8")
      ).records,
      []
    );
    await assert.rejects(access(join(root, ".agent-ops", "manifest.json")));
    assert.equal(await readFile(join(root, "unmanaged.txt"), "utf8"), "keep me\n");
  } finally {
    cleanupE2eRoot(root);
  }
});

test("project lifecycle migrates both legacy routing bodies without changing user text", async () => {
  const { root, result } = runBuiltCli([
    "init",
    "--scope",
    "project",
    "--harness",
    "all",
    "--profile",
    "core",
    "--yes",
    "--json"
  ]);
  try {
    assert.equal(result.status, 0);
    for (const [path, desired, legacy] of [
      ["AGENTS.md", CODEX_DESIRED_BODY, CODEX_LEGACY_BODY],
      ["CLAUDE.md", CLAUDE_DESIRED_BODY, CLAUDE_LEGACY_BODY]
    ] as const) {
      const source = await readFile(join(root, path), "utf8");
      await writeFile(
        join(root, path),
        `user text before\n${source.replace(desired, legacy)}user text after\n`
      );
    }

    const updated = runBuiltCli([
      "update",
      "--target-version",
      "0.2.0",
      "--yes",
      "--json"
    ], root).result;
    assert.equal(updated.status, 0);
    assert.match(updated.stdout, /UPDATE_APPLIED/);
    assert.match(
      await readFile(join(root, "AGENTS.md"), "utf8"),
      /user text before[\s\S]*Load `\.agent-ops\/AGENTS\.md`[\s\S]*user text after/u
    );
    assert.match(
      await readFile(join(root, "CLAUDE.md"), "utf8"),
      /user text before[\s\S]*@\.agent-ops\/CLAUDE\.md[\s\S]*user text after/u
    );
  } finally {
    cleanupE2eRoot(root);
  }
});

test("agy lifecycle runs through init, doctor, update, and selective uninstall", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-e2e-agy-"));
  const fakeBin = join(root, "bin");
  await mkdir(fakeBin);
  const fakeAgyPath = join(fakeBin, process.platform === "win32" ? "agy.cmd" : "agy");
  const fakeAgySource = process.platform === "win32"
    ? [
        "@echo off",
        'if "%1"=="--version" (echo agy 1.1.12&exit /b 0)',
        "echo {\"command\":{\"data\":{\"hooks\":[{\"name\":\"agent-ops\",\"enabled\":true,\"actions\":[{\"event\":\"PreInvocation\",\"command\":\"node hook-entry.js agy SessionStart --managed-by=agent-ops\"}]}]}}}"
      ].join("\r\n") + "\r\n"
    : [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "agy 1.1.12"; exit 0; fi',
        "printf '%s\\n' '{\"command\":{\"data\":{\"hooks\":[{\"name\":\"agent-ops\",\"enabled\":true,\"actions\":[{\"event\":\"PreInvocation\",\"command\":\"node hook-entry.js agy SessionStart --managed-by=agent-ops\"}]}]}}}'"
      ].join("\n") + "\n";
  await writeFile(
    fakeAgyPath,
    fakeAgySource
  );
  await chmod(fakeAgyPath, 0o755);
  const environment = {
    PATH: `${fakeBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`
  };
  try {
    const initialized = runBuiltCli([
      "init", "--scope", "project", "--harness", "agy,codex",
      "--profile", "advisory", "--yes", "--json"
    ], root, root, environment).result;
    assert.equal(initialized.status, 0);
    assert.match(initialized.stdout, /INIT_APPLIED/u);

    const doctor = runBuiltCli(["doctor", "--json"], root, root, environment).result;
    assert.equal(doctor.status, 0);
    const doctorPayload = JSON.parse(doctor.stdout) as {
      data?: { report?: { checks?: readonly { id?: string; status?: string }[] } };
    };
    assert.equal(
      doctorPayload.data?.report?.checks?.find(({ id }) => id === "agy-runtime")?.status,
      "PASS"
    );

    const updated = runBuiltCli([
      "update", "--target-version", "0.2.0", "--yes", "--json"
    ], root, root, environment).result;
    assert.equal(updated.status, 0);
    assert.match(updated.stdout, /UPDATE_APPLIED/u);

    const removed = runBuiltCli([
      "uninstall", "--harness", "agy", "--yes", "--json"
    ], root, root, environment).result;
    assert.equal(removed.status, 0);
    assert.match(removed.stdout, /UNINSTALL_APPLIED/u);
    const remaining = JSON.parse(
      await readFile(join(root, ".agent-ops", "manifest.json"), "utf8")
    ) as { harness: string[] };
    assert.deepEqual(remaining.harness, ["codex"]);
    await assert.rejects(access(join(root, ".agents", "hooks.json")));
    await access(join(root, ".codex", "hooks.json"));
  } finally {
    cleanupE2eRoot(root);
  }
});
