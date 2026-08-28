import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyInstallPlan } from "../../runtime/src/install/apply.js";
import {
  commonHarnessAdapters
} from "../../runtime/src/install/harness.js";
import { createInstallPlan } from "../../runtime/src/install/plan.js";
import {
  applyUninstallPlan,
  createUninstallPlan
} from "../../runtime/src/install/uninstall.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { sha256 } from "../../runtime/src/fs/hash.js";

const CODEX_START = "<!-- agent-ops:start agents-routing v1 -->";
const CODEX_END = "<!-- agent-ops:end agents-routing -->";
const CODEX_LEGACY_BODY =
  "## Loop Engineering\n\nUse `.agent-ops/AGENTS.md` as the canonical Loop Engineering specification for this project.";
const CLAUDE_START = "<!-- agent-ops:start claude-routing v1 -->";
const CLAUDE_END = "<!-- agent-ops:end claude-routing -->";
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
  const plan = await createInstallPlan({
    root,
    scope: "project",
    harness: ["codex", "claude"],
    profiles: ["core"],
    adapters: commonHarnessAdapters()
  });
  await applyInstallPlan(root, plan);
}

test("selective uninstall removes agy while preserving shared and Claude content", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-selective-"));
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["agy", "codex", "claude"],
        profiles: ["core"],
        adapters: commonHarnessAdapters(),
        reviewTargets: ["agy", "codex", "claude"]
      })
    );
    const plan = await createUninstallPlan(root, ["agy"]);
    assert.equal(plan.resultingManifest?.harness.join(","), "codex,claude");
    assert.ok(
      plan.operations.some(
        ({ kind, path }) => kind === "write" && path === ".agent-ops/manifest.json"
      )
    );
    assert.ok(
      !plan.operations.some(
        ({ path }) => path === ".agent-ops/AGENTS.md" || path === "AGENTS.md"
      )
    );
    await applyUninstallPlan(root, plan);
    const manifest = JSON.parse(
      await readFile(join(root, ".agent-ops", "manifest.json"), "utf8")
    ) as { harness: string[] };
    assert.deepEqual(manifest.harness, ["codex", "claude"]);
    assert.match(await readFile(join(root, "AGENTS.md"), "utf8"), /agents-routing/u);
    assert.ok(await readFile(join(root, ".agent-ops", "AGENTS.md"), "utf8"));
    assert.ok(await readFile(join(root, ".agent-ops", "CLAUDE.md"), "utf8"));
    assert.deepEqual(
      (JSON.parse(await readFile(join(root, ".agent-ops", "config.json"), "utf8")) as {
        reviewRoles: { targets: string[] }[];
      }).reviewRoles[0]?.targets,
      ["codex", "claude"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selective uninstall removes only agy hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-selective-"));
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["agy", "codex"],
        profiles: ["advisory"],
        adapters: commonHarnessAdapters(),
        hookRuntimePath: "/opt/agent-ops/hook-entry.js"
      })
    );
    await applyUninstallPlan(root, await createUninstallPlan(root, ["agy"]));
    await assert.rejects(readFile(join(root, ".agents", "hooks.json")));
    assert.match(
      await readFile(join(root, ".codex", "hooks.json"), "utf8"),
      /agent-ops/u
    );
    const manifest = JSON.parse(
      await readFile(join(root, ".agent-ops", "manifest.json"), "utf8")
    ) as { harness: string[]; hooks?: { harness: string }[] };
    assert.deepEqual(manifest.harness, ["codex"]);
    assert.deepEqual(manifest.hooks?.map(({ harness }) => harness), ["codex"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall removes only managed files and blocks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "# User content\n");
    await install(root);
    await writeFile(
      join(root, "AGENTS.md"),
      `${
        await readFile(join(root, "AGENTS.md"), "utf8")
      }\nUser footer\n`
    );

    const plan = await createUninstallPlan(root);
    assert.equal(plan.installed, true);
    await applyUninstallPlan(root, plan);

    assert.equal(
      await readFile(join(root, "AGENTS.md"), "utf8"),
      "# User content\n\nUser footer\n"
    );
    await assert.rejects(readFile(join(root, "CLAUDE.md")));
    for (const path of [
      ".agent-ops/config.json",
      ".agent-ops/AGENTS.md",
      ".agent-ops/CLAUDE.md",
      ".agent-ops/manifest.json"
    ]) {
      await assert.rejects(readFile(join(root, path)));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall removes exact legacy routing blocks and preserves surrounding bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-"));
  try {
    await install(root);
    const agentsPath = join(root, "AGENTS.md");
    const claudePath = join(root, "CLAUDE.md");
    await writeFile(
      agentsPath,
      `before-agents\n\n${managedBlock(CODEX_START, CODEX_LEGACY_BODY, CODEX_END)}\nafter-agents\n`
    );
    await writeFile(
      claudePath,
      `before-claude\n\n${managedBlock(CLAUDE_START, CLAUDE_LEGACY_BODY, CLAUDE_END)}\nafter-claude\n`
    );

    const plan = await createUninstallPlan(root);
    await applyUninstallPlan(root, plan);

    assert.equal(await readFile(agentsPath, "utf8"), "before-agents\n\nafter-agents\n");
    assert.equal(await readFile(claudePath, "utf8"), "before-claude\n\nafter-claude\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second uninstall is an explicit idempotent no-op", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-"));
  try {
    const plan = await createUninstallPlan(root);
    assert.equal(plan.installed, false);
    assert.deepEqual(plan.operations, []);
    await applyUninstallPlan(root, plan);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user opencode ownership follows the manifest plugin path", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-opencode-"));
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = join(root, "custom-xdg");
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "user",
        harness: ["opencode"],
        profiles: ["guardrails"],
        adapters: commonHarnessAdapters(),
        hookRuntimePath: "/opt/agent-ops/hook-entry.js"
      })
    );

    const pluginPath = "custom-xdg/opencode/plugins/agent-ops.js";
    assert.ok(await readFile(join(root, pluginPath), "utf8"));
    delete process.env.XDG_CONFIG_HOME;

    const plan = await createUninstallPlan(root);
    assert.ok(
      plan.operations.some(
        ({ kind, path }) => kind === "remove" && path === pluginPath
      )
    );
  } finally {
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("changed whole-file artifacts fail closed before removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-"));
  try {
    await install(root);
    const rulesPath = join(root, ".agent-ops", "AGENTS.md");
    await writeFile(rulesPath, "# User changed managed rules\n");

    await assert.rejects(
      createUninstallPlan(root),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "MANAGED_ARTIFACT_CHANGED"
    );
    assert.equal(
      await readFile(rulesPath, "utf8"),
      "# User changed managed rules\n"
    );
    assert.match(
      await readFile(join(root, "AGENTS.md"), "utf8"),
      /agent-ops:start agents-routing/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed or missing managed marker boundaries fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-"));
  try {
    await install(root);
    const agentsPath = join(root, "AGENTS.md");
    const source = await readFile(agentsPath, "utf8");
    await writeFile(
      agentsPath,
      source.replace(
        "<!-- agent-ops:end agents-routing -->",
        "<!-- marker removed -->"
      )
    );

    await assert.rejects(
      createUninstallPlan(root),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "MANAGED_BLOCK_CHANGED"
    );
    assert.match(
      await readFile(
        join(root, ".agent-ops", "manifest.json"),
        "utf8"
      ),
      /agents-routing/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply rejects a tampered uninstall plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "# Preserve\n");
    await install(root);
    const plan = await createUninstallPlan(root);
    const index = plan.operations.findIndex(
      ({ path }) => path === "AGENTS.md"
    );
    assert.notEqual(index, -1);
    const operation = plan.operations[index];
    assert.notEqual(operation, undefined);
    if (operation === undefined) {
      return;
    }
    plan.operations[index] = {
      kind: "write",
      path: "AGENTS.md",
      content: "# Replaced\n",
      expectedHash: operation.expectedHash
    };

    await assert.rejects(
      applyUninstallPlan(root, plan),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "INVALID_UNINSTALL_PLAN"
    );
    assert.match(
      await readFile(join(root, "AGENTS.md"), "utf8"),
      /agent-ops:start agents-routing/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a schema-valid forged manifest cannot claim an unmanaged file", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-"));
  try {
    await install(root);
    const victimPath = join(root, "victim.txt");
    const victimContent = "user-owned\n";
    await writeFile(victimPath, victimContent);
    const manifestPath = join(root, ".agent-ops", "manifest.json");
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8")
    ) as {
      artifacts: {
        id: string;
        path: string;
        hash: string;
        owner: "agent-ops";
      }[];
    };
    manifest.artifacts.push({
      id: "forged-victim",
      path: "victim.txt",
      hash: sha256(victimContent),
      owner: "agent-ops"
    });
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`
    );

    await assert.rejects(
      createUninstallPlan(root),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "MANIFEST_OWNERSHIP_INVALID"
    );
    assert.equal(await readFile(victimPath, "utf8"), victimContent);
    assert.equal((await lstat(victimPath)).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a forged opencode plugin path cannot claim an unmanaged file", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-opencode-"));
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["opencode"],
        profiles: ["guardrails"],
        adapters: commonHarnessAdapters(),
        hookRuntimePath: "/opt/agent-ops/hook-entry.js"
      })
    );
    const victimPath = join(root, "victim.txt");
    const victimContent = "user-owned\n";
    await writeFile(victimPath, victimContent);
    const manifestPath = join(root, ".agent-ops", "manifest.json");
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8")
    ) as {
      artifacts: {
        id: string;
        path: string;
        hash: string;
        owner: "agent-ops";
      }[];
    };
    const plugin = manifest.artifacts.find(
      ({ id }) => id === "opencode-plugin"
    );
    assert.ok(plugin);
    plugin.path = "victim.txt";
    plugin.hash = sha256(victimContent);
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`
    );

    await assert.rejects(
      createUninstallPlan(root),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "MANIFEST_OWNERSHIP_INVALID"
    );
    assert.equal(await readFile(victimPath, "utf8"), victimContent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opencode ownership keeps artifact path casing exact", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-opencode-"));
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["opencode"],
        profiles: ["guardrails"],
        adapters: commonHarnessAdapters(),
        hookRuntimePath: "/opt/agent-ops/hook-entry.js"
      })
    );
    const manifestPath = join(root, ".agent-ops", "manifest.json");
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8")
    ) as {
      artifacts: { id: string; path: string }[];
    };
    const rules = manifest.artifacts.find(({ id }) => id === "agents-rules");
    assert.ok(rules);
    rules.path = ".agent-ops/agents.md";
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`
    );

    await assert.rejects(
      createUninstallPlan(root),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "MANIFEST_OWNERSHIP_INVALID"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom user opencode paths still require the managed plugin marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-opencode-"));
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = join(root, "custom-xdg");
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "user",
        harness: ["opencode"],
        profiles: ["guardrails"],
        adapters: commonHarnessAdapters(),
        hookRuntimePath: "/opt/agent-ops/hook-entry.js"
      })
    );
    const victimPath = "victim/plugins/agent-ops.js";
    await mkdir(join(root, "victim/plugins"), { recursive: true });
    const victimContent = "user-owned plugin\n";
    await writeFile(join(root, victimPath), victimContent);
    const manifestPath = join(root, ".agent-ops", "manifest.json");
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8")
    ) as {
      artifacts: {
        id: string;
        path: string;
        hash: string;
        owner: "agent-ops";
      }[];
    };
    const plugin = manifest.artifacts.find(
      ({ id }) => id === "opencode-plugin"
    );
    assert.ok(plugin);
    plugin.path = victimPath;
    plugin.hash = sha256(victimContent);
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    delete process.env.XDG_CONFIG_HOME;

    await assert.rejects(
      createUninstallPlan(root),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "MANIFEST_OWNERSHIP_INVALID"
    );
    assert.equal(await readFile(join(root, victimPath), "utf8"), victimContent);
  } finally {
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("changed managed block content fails closed before removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-uninstall-"));
  try {
    await install(root);
    const agentsPath = join(root, "AGENTS.md");
    const changed = (
      await readFile(agentsPath, "utf8")
    ).replace(
      "Load `.agent-ops/AGENTS.md` as the agent-ops managed baseline.",
      "User content moved inside a managed block."
    );
    await writeFile(agentsPath, changed);

    await assert.rejects(
      createUninstallPlan(root),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "MANAGED_BLOCK_CHANGED"
    );
    assert.equal(await readFile(agentsPath, "utf8"), changed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
