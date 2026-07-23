import assert from "node:assert/strict";
import {
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

async function install(root: string): Promise<void> {
  const plan = await createInstallPlan({
    root,
    scope: "project",
    harness: "both",
    profiles: ["core"],
    adapters: commonHarnessAdapters()
  });
  await applyInstallPlan(root, plan);
}

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
      /agent-ops:start codex-routing/
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
        "<!-- agent-ops:end codex-routing -->",
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
      /codex-routing/
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
      /agent-ops:start codex-routing/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
