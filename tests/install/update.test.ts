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

const CODEX_START = "<!-- agent-ops:start agents-routing v1 -->";
const CODEX_END = "<!-- agent-ops:end agents-routing -->";
const CODEX_DESIRED_BODY =
  "## Loop Engineering\n\nLoad `.agent-ops/AGENTS.md` as the agent-ops managed baseline.\nProject-specific instructions in this file remain authoritative.";
const CODEX_LEGACY_BODY =
  "## Loop Engineering\n\nUse `.agent-ops/AGENTS.md` as the canonical Loop Engineering specification for this project.";
const CLAUDE_START = "<!-- agent-ops:start claude-routing v1 -->";
const CLAUDE_END = "<!-- agent-ops:end claude-routing -->";
const CLAUDE_DESIRED_BODY =
  "## Loop Engineering\n\nLoad `.agent-ops/CLAUDE.md` as the agent-ops managed baseline.\nProject-specific instructions in this file remain authoritative.";
const CLAUDE_LEGACY_BODY =
  "## Loop Engineering\n\nUse `.agent-ops/CLAUDE.md` as the canonical Loop Engineering specification for this project.";

function managedBlock(
  start: string,
  body: string,
  end: string
): string {
  return `${start}\n${body}\n${end}\n`;
}

async function install(root: string): Promise<void> {
  await applyInstallPlan(
    root,
    await createInstallPlan({
      root,
      scope: "project",
      harness: ["codex"],
      profiles: ["core"],
      adapters: commonHarnessAdapters(),
      toolkitVersion: "0.1.0"
    })
  );
}

async function installHarnesses(
  root: string,
  scope: "project" | "user",
  harness: readonly ("codex" | "claude" | "opencode")[]
): Promise<void> {
  await applyInstallPlan(
    root,
    await createInstallPlan({
      root,
      scope,
      harness: [...harness],
      profiles: ["guardrails"],
      adapters: commonHarnessAdapters(),
      toolkitVersion: "0.1.0",
      hookRuntimePath: "/opt/agent-ops/hook-entry.js"
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

test("updates an exact legacy Codex routing block and preserves surrounding bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-update-"));
  try {
    await install(root);
    const agentsPath = join(root, "AGENTS.md");
    const source = [
      "# User instructions before",
      "",
      managedBlock(CODEX_START, CODEX_LEGACY_BODY, CODEX_END).trimEnd(),
      "",
      "User instructions after",
      ""
    ].join("\n");
    await writeFile(agentsPath, source);

    const plan = await createUpdatePlan({
      root,
      adapters: commonHarnessAdapters(),
      targetVersion: "0.2.0"
    });

    const operation = plan.installation.operations.find(
      ({ path }) => path === "AGENTS.md"
    );
    assert.equal(operation?.kind, "write");
    if (operation?.kind !== "write") {
      assert.fail("legacy routing update must rewrite AGENTS.md");
    }
    assert.equal(
      operation.content,
      [
        "# User instructions before",
        "",
        managedBlock(CODEX_START, CODEX_DESIRED_BODY, CODEX_END).trimEnd(),
        "",
        "User instructions after",
        ""
      ].join("\n")
    );

    await applyUpdatePlan(root, plan);
    assert.equal(await readFile(agentsPath, "utf8"), operation.content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrates Codex and Claude legacy routing blocks in one update", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-update-"));
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["codex", "claude"],
        profiles: ["core"],
        adapters: commonHarnessAdapters(),
        toolkitVersion: "0.1.0"
      })
    );
    const agentsPath = join(root, "AGENTS.md");
    const claudePath = join(root, "CLAUDE.md");
    await writeFile(
      agentsPath,
      `before-agents\n${managedBlock(CODEX_START, CODEX_LEGACY_BODY, CODEX_END)}after-agents\n`
    );
    await writeFile(
      claudePath,
      `before-claude\n${managedBlock(CLAUDE_START, CLAUDE_LEGACY_BODY, CLAUDE_END)}after-claude\n`
    );

    const plan = await createUpdatePlan({
      root,
      adapters: commonHarnessAdapters(),
      targetVersion: "0.2.0"
    });
    const routingWrites = plan.installation.operations.filter(
      ({ kind, path }) =>
        kind === "write" && (path === "AGENTS.md" || path === "CLAUDE.md")
    );
    assert.equal(routingWrites.length, 2);

    await applyUpdatePlan(root, plan);
    assert.equal(
      await readFile(agentsPath, "utf8"),
      `before-agents\n${managedBlock(CODEX_START, CODEX_DESIRED_BODY, CODEX_END)}after-agents\n`
    );
    assert.equal(
      await readFile(claudePath, "utf8"),
      `before-claude\n${managedBlock(CLAUDE_START, CLAUDE_DESIRED_BODY, CLAUDE_END)}after-claude\n`
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed legacy routing content fails closed during update", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-update-"));
  try {
    await install(root);
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(
      agentsPath,
      managedBlock(
        CODEX_START,
        CODEX_LEGACY_BODY.replace("canonical", "user-edited"),
        CODEX_END
      )
    );

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

test("update without a runtime path preserves existing selected hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-update-"));
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["codex"],
        profiles: ["guardrails"],
        adapters: commonHarnessAdapters(),
        hookRuntimePath: "/opt/agent-ops/hook-entry.js"
      })
    );
    const hooksPath = join(root, ".codex", "hooks.json");
    const hooksBefore = await readFile(hooksPath, "utf8");

    const plan = await createUpdatePlan({
      root,
      adapters: commonHarnessAdapters(),
      targetVersion: "0.2.0"
    });

    assert.equal(
      plan.installation.operations.some(
        ({ kind, path }) => kind === "remove" && path === ".codex/hooks.json"
      ),
      false
    );
    assert.equal(plan.installation.manifest.hooks?.length, 1);

    await applyUpdatePlan(root, plan);
    assert.equal(await readFile(hooksPath, "utf8"), hooksBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reinitializing an opencode install removes stale capability artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-update-"));
  try {
    await installHarnesses(root, "project", ["opencode"]);
    const pluginPath = join(root, ".opencode", "plugins", "agent-ops.js");
    assert.ok(await readFile(pluginPath, "utf8"));

    const plan = await createInstallPlan({
      root,
      scope: "project",
      harness: ["opencode"],
      profiles: ["core"],
      adapters: commonHarnessAdapters()
    });
    assert.ok(
      plan.operations.some(
        ({ kind, path }) =>
          kind === "remove" && path === ".opencode/plugins/agent-ops.js"
      )
    );

    await applyInstallPlan(root, plan);
    await assert.rejects(readFile(pluginPath));
    assert.equal(
      plan.manifest.artifacts.some(({ id }) => id === "opencode-plugin"),
      false
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

test("update narrows project harnesses without removing shared AGENTS paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-update-"));
  try {
    await installHarnesses(root, "project", ["codex", "opencode"]);
    const sharedInstruction = await readFile(
      join(root, "AGENTS.md"),
      "utf8"
    );
    assert.ok(
      await readFile(
        join(root, ".opencode", "plugins", "agent-ops.js"),
        "utf8"
      )
    );

    const plan = await createUpdatePlan({
      root,
      adapters: commonHarnessAdapters(),
      harness: ["codex"],
      targetVersion: "0.2.0",
      hookRuntimePath: "/opt/agent-ops/hook-entry.js"
    });
    assert.ok(
      plan.installation.operations.some(
        ({ kind, path }) =>
          kind === "remove" &&
          path === ".opencode/plugins/agent-ops.js"
      )
    );
    assert.equal(
      plan.installation.operations.some(
        ({ kind, path }) =>
          kind === "remove" &&
          (path === "AGENTS.md" || path === ".agent-ops/AGENTS.md")
      ),
      false
    );

    await applyUpdatePlan(root, plan);
    const manifest = JSON.parse(
      await readFile(join(root, ".agent-ops", "manifest.json"), "utf8")
    ) as { harness: string[] };
    assert.deepEqual(manifest.harness, ["codex"]);
    assert.equal(
      await readFile(join(root, "AGENTS.md"), "utf8"),
      sharedInstruction
    );
    await assert.rejects(
      readFile(join(root, ".opencode", "plugins", "agent-ops.js"))
    );
    assert.ok(await readFile(join(root, ".codex", "hooks.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update narrows user harnesses and removes only opencode-owned paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-update-"));
  try {
    await installHarnesses(root, "user", ["codex", "opencode"]);
    const sharedRulesBefore = await readFile(
      join(root, ".agent-ops", "AGENTS.md"),
      "utf8"
    );
    assert.match(sharedRulesBefore, /Toolkit version: 0\.1\.0/);

    const plan = await createUpdatePlan({
      root,
      adapters: commonHarnessAdapters(),
      harness: ["codex"],
      targetVersion: "0.2.0",
      hookRuntimePath: "/opt/agent-ops/hook-entry.js"
    });
    assert.ok(
      plan.installation.operations.some(
        ({ kind, path }) =>
          kind === "remove" &&
          path === ".config/opencode/plugins/agent-ops.js"
      )
    );
    assert.ok(
      plan.installation.operations.some(
        ({ kind, path }) =>
          kind === "remove" && path === ".opencode/AGENTS.md"
      )
    );
    assert.equal(
      plan.installation.operations.some(
        ({ kind, path }) =>
          kind === "remove" && path === ".agent-ops/AGENTS.md"
      ),
      false
    );

    await applyUpdatePlan(root, plan);
    assert.match(
      await readFile(join(root, ".agent-ops", "AGENTS.md"), "utf8"),
      /Toolkit version: 0\.2\.0/
    );
    assert.ok(await readFile(join(root, ".codex", "AGENTS.md"), "utf8"));
    await assert.rejects(readFile(join(root, ".opencode", "AGENTS.md")));
    await assert.rejects(
      readFile(join(root, ".config", "opencode", "plugins", "agent-ops.js"))
    );
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
