import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { applyInstallPlan } from "../../runtime/src/install/apply.js";
import {
  commonHarnessAdapters
} from "../../runtime/src/install/harness.js";
import { createInstallPlan } from "../../runtime/src/install/plan.js";
import {
  applyUpdatePlan,
  createUpdatePlan
} from "../../runtime/src/install/update.js";
import type { RegistryClient } from "../../runtime/src/registry/npm.js";

async function install(root: string): Promise<void> {
  await applyInstallPlan(
    root,
    await createInstallPlan({
      root,
      scope: "project",
      harness: "codex",
      profiles: ["core"],
      adapters: commonHarnessAdapters(),
      toolkitVersion: "0.1.0"
    })
  );
}

test("migrates a manifest-owned version 0 config during update", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-update-"));
  try {
    await install(root);
    const configPath = join(root, ".agent-ops", "config.json");
    const commands = [
      {
        id: "unit",
        command: "node",
        args: ["--test"],
        cwd: ".",
        required: true,
        evidence: { kind: "test-count", minimum: 1 }
      }
    ];
    const versionZero = {
      schemaVersion: 0,
      profiles: ["core"],
      commands,
      pathMappings: [{ path: "src", verifierIds: ["unit"] }],
      securityExceptions: []
    };
    await writeFile(
      configPath,
      `${JSON.stringify(versionZero, null, 2)}\n`
    );

    const plan = await createUpdatePlan({
      root,
      adapters: commonHarnessAdapters(),
      targetVersion: "0.2.0"
    });

    assert.deepEqual(plan.migrationSteps, [
      { fromVersion: 0, toVersion: 1 }
    ]);
    const configOperation = plan.installation.operations.find(
      ({ path }) => path === ".agent-ops/config.json"
    );
    assert.equal(configOperation?.kind, "write");
    if (configOperation?.kind !== "write") {
      assert.fail("update plan must write the migrated config");
    }
    const expectedVersionOne = {
      schemaVersion: 1,
      profiles: ["core"],
      verification: { commands },
      pathMappings: [{ path: "src", verifierIds: ["unit"] }],
      securityExceptions: []
    };
    assert.deepEqual(
      JSON.parse(configOperation.content) as unknown,
      expectedVersionOne
    );

    await applyUpdatePlan(root, plan);
    assert.deepEqual(
      JSON.parse(await readFile(configPath, "utf8")) as unknown,
      expectedVersionOne
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit target update is offline and preserves verifier config", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-update-"));
  let registryCalls = 0;
  try {
    await install(root);
    const configPath = join(root, ".agent-ops", "config.json");
    const configured = {
      schemaVersion: 1,
      profiles: ["core"],
      verification: {
        commands: [
          {
            id: "unit",
            command: "node",
            args: ["--test"],
            cwd: ".",
            required: true,
            evidence: { kind: "test-count", minimum: 1 }
          }
        ]
      },
      pathMappings: [{ path: "src", verifierIds: ["unit"] }],
      securityExceptions: []
    };
    await writeFile(
      configPath,
      `${JSON.stringify(configured, null, 2)}\n`
    );
    const registry: RegistryClient = {
      async latestVersion() {
        registryCalls += 1;
        return "9.9.9";
      }
    };

    const plan = await createUpdatePlan({
      root,
      adapters: commonHarnessAdapters(),
      targetVersion: "0.2.0",
      registry
    });

    assert.equal(registryCalls, 0);
    assert.equal(plan.targetVersion, "0.2.0");
    assert.deepEqual(plan.migrationSteps, []);
    const rulesOperation = plan.installation.operations.find(
      ({ path }) => path === ".agent-ops/AGENTS.md"
    );
    assert.equal(rulesOperation?.kind, "write");
    if (rulesOperation?.kind !== "write") {
      return;
    }
    assert.match(rulesOperation.content, /Toolkit version: 0\.2\.0/);
    await applyUpdatePlan(root, plan);
    assert.deepEqual(
      JSON.parse(await readFile(configPath, "utf8")),
      configured
    );
    assert.match(
      await readFile(join(root, ".agent-ops", "AGENTS.md"), "utf8"),
      /Toolkit version: 0\.2\.0/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry lookup occurs only when update has no supplied target", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-update-"));
  const packageNames: string[] = [];
  try {
    await install(root);
    const registry: RegistryClient = {
      async latestVersion(packageName) {
        packageNames.push(packageName);
        return "0.3.0";
      }
    };

    const plan = await createUpdatePlan({
      root,
      adapters: commonHarnessAdapters(),
      registry
    });

    assert.deepEqual(packageNames, ["@kylecheng3146/agent-ops"]);
    assert.equal(plan.targetVersion, "0.3.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update without a target or registry is rejected offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-update-"));
  try {
    await install(root);
    await assert.rejects(
      createUpdatePlan({
        root,
        adapters: commonHarnessAdapters()
      }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "UPDATE_TARGET_REQUIRED"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid managed markers block update before any write", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-update-"));
  try {
    await install(root);
    const agentsPath = join(root, "AGENTS.md");
    const before = (
      await readFile(agentsPath, "utf8")
    ).replace("agent-ops:end", "agent-ops:broken");
    await writeFile(agentsPath, before);

    await assert.rejects(
      createUpdatePlan({
        root,
        adapters: commonHarnessAdapters(),
        targetVersion: "0.2.0"
      }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "UPDATE_INSTALLATION_INVALID"
    );
    assert.equal(await readFile(agentsPath, "utf8"), before);
    assert.match(
      await readFile(join(root, ".agent-ops", "AGENTS.md"), "utf8"),
      /Toolkit version: 0\.1\.0/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-apply validation failure rolls back and removes recovery backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-update-"));
  try {
    await install(root);
    const rulesPath = join(root, ".agent-ops", "AGENTS.md");
    const manifestPath = join(root, ".agent-ops", "manifest.json");
    const [originalRules, originalManifest] = await Promise.all([
      readFile(rulesPath, "utf8"),
      readFile(manifestPath, "utf8")
    ]);
    const plan = await createUpdatePlan({
      root,
      adapters: commonHarnessAdapters(),
      targetVersion: "0.2.0"
    });
    const rulesOperation = plan.installation.operations.find(
      ({ path }) => path === ".agent-ops/AGENTS.md"
    );
    assert.equal(rulesOperation?.kind, "write");
    if (rulesOperation?.kind !== "write") {
      assert.fail("update plan must write managed rules");
    }
    rulesOperation.content = `${rulesOperation.content}\ntampered\n`;

    await assert.rejects(
      applyUpdatePlan(root, plan),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TRANSACTION_FAILED"
    );
    assert.equal(await readFile(rulesPath, "utf8"), originalRules);
    assert.equal(
      await readFile(manifestPath, "utf8"),
      originalManifest
    );
    assert.equal(
      (await readdir(root)).some((name) =>
        name.startsWith(".agent-ops-backup-")
      ),
      false
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
