import assert from "node:assert/strict";
import {
  mkdir,
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
import { doctorInstallation } from "../../runtime/src/install/doctor.js";
import { commonHarnessAdapters } from "../../runtime/src/install/harness.js";
import { buildPowerShellLoopLauncher } from "../../runtime/src/install/codex-loop.js";
import { createInstallPlan } from "../../runtime/src/install/plan.js";
import {
  applyUninstallPlan,
  createUninstallPlan
} from "../../runtime/src/install/uninstall.js";
import {
  applyUpdatePlan,
  createUpdatePlan
} from "../../runtime/src/install/update.js";

const INITIAL_RUNTIME = "/opt/agent-ops/hook-entry.js";
const UPDATED_RUNTIME = "/opt/agent-ops-next/hook-entry.js";

async function installLoop(
  root: string,
  harness: readonly ("claude" | "codex")[] = ["codex", "claude"]
): Promise<void> {
  await applyInstallPlan(
    root,
    await createInstallPlan({
      root,
      scope: "project",
      harness: [...harness],
      profiles: ["loop"],
      adapters: commonHarnessAdapters(),
      toolkitVersion: "0.1.5",
      hookRuntimePath: INITIAL_RUNTIME
    })
  );
}

function status(
  report: Awaited<ReturnType<typeof doctorInstallation>>,
  id: "artifacts" | "registration-drift"
): string {
  const check = report.checks.find((candidate) => candidate.id === id);
  assert.ok(check, `missing ${id}`);
  return check.status;
}

test("an explicit Codex hooks=false configuration blocks loop planning before writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-loop-hooks-disabled-"));
  try {
    await mkdir(join(root, ".codex"), { recursive: true });
    const config = "[features]\nhooks = false\n# user-owned setting\n";
    await writeFile(join(root, ".codex", "config.toml"), config);
    const before = await readdir(root);

    await assert.rejects(
      createInstallPlan({
        root,
        scope: "project",
        harness: ["codex"],
        profiles: ["loop"],
        adapters: commonHarnessAdapters(),
        hookRuntimePath: INITIAL_RUNTIME
      }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "CODEX_LOOP_HOOKS_DISABLED"
    );
    assert.deepEqual(await readdir(root), before);
    assert.equal(
      await readFile(join(root, ".codex", "config.toml"), "utf8"),
      config
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plans a native Windows Claude loop with a PowerShell handler", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-loop-windows-"));
  try {
    const plan = await createInstallPlan({
      root,
      scope: "project",
      harness: ["claude"],
      profiles: ["loop"],
      adapters: commonHarnessAdapters(),
      hookRuntimePath: "C:\\Program Files\\agent-ops\\hook-entry.js",
      platform: "win32"
    });
    const settingsOperation = plan.operations.find(
      ({ path }) => path === ".claude/settings.json"
    );
    assert.equal(settingsOperation?.kind, "write");
    if (settingsOperation?.kind !== "write") {
      throw new Error("Expected Windows Claude settings write");
    }
    const settings = JSON.parse(settingsOperation.content) as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    };
    const sessionStart = settings.hooks.SessionStart?.[0]?.hooks[0];
    assert.deepEqual(sessionStart, {
      type: "command",
      shell: "powershell",
      command:
        '& "${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-ops-loop.ps1" ' +
        '"SessionStart" "--managed-by=agent-ops"',
      timeout: 30
    });
    assert.equal(
      plan.operations.some(
        ({ kind, path }) =>
          kind === "write" && path === ".claude/hooks/agent-ops-loop.ps1"
      ),
      true
    );

    await applyInstallPlan(root, plan);
    assert.match(
      await readFile(join(root, ".claude", "hooks", "agent-ops-loop.ps1"), "utf8"),
      /& node \$runtimePath claude @args/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enabling loop on an existing installation seeds its missing local files once", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-loop-enable-"));
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["codex"],
        profiles: ["core"],
        adapters: commonHarnessAdapters(),
        hookRuntimePath: INITIAL_RUNTIME
      })
    );

    const plan = await createInstallPlan({
      root,
      scope: "project",
      harness: ["codex"],
      profiles: ["loop"],
      adapters: commonHarnessAdapters(),
      hookRuntimePath: INITIAL_RUNTIME
    });
    const plannedPaths = new Set(plan.operations.map(({ path }) => path));
    for (const path of [
      ".codex/config.toml",
      ".codex/loop-goal.md",
      ".codex/loop-state.md",
      ".codex/loop-telemetry.jsonl"
    ]) {
      assert.ok(plannedPaths.has(path), `missing seed operation: ${path}`);
    }

    await applyInstallPlan(root, plan);
    assert.match(
      await readFile(join(root, ".codex", "config.toml"), "utf8"),
      /hooks\s*=\s*true/u
    );
    await assert.match(
      await readFile(join(root, ".codex", "loop-goal.md"), "utf8"),
      /Current goal/u
    );

    await rm(join(root, ".codex", "loop-goal.md"));
    const repeatPlan = await createInstallPlan({
      root,
      scope: "project",
      harness: ["codex"],
      profiles: ["loop"],
      adapters: commonHarnessAdapters(),
      hookRuntimePath: INITIAL_RUNTIME
    });
    assert.equal(
      repeatPlan.operations.some(({ path }) => path === ".codex/loop-goal.md"),
      false
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update replaces only loop-owned launchers and leaves local state untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-loop-update-"));
  try {
    await installLoop(root);
    const codexGoal = "# Current goal\n\nPreserve this goal.\n";
    const claudeState = "# Loop state\n\nPreserve this state.\n";
    const telemetry = "{\"user\":\"local data\"}\n";
    await Promise.all([
      writeFile(join(root, ".codex", "loop-goal.md"), codexGoal),
      writeFile(join(root, ".claude", "loop-state.md"), claudeState),
      writeFile(join(root, ".claude", "loop-telemetry.jsonl"), telemetry)
    ]);

    const plan = await createUpdatePlan({
      root,
      adapters: commonHarnessAdapters(),
      targetVersion: "0.2.0",
      toolkitVersion: "0.2.0",
      hookRuntimePath: UPDATED_RUNTIME
    });
    assert.equal(
      plan.installation.operations.some(({ path }) => path.includes("loop-goal") || path.includes("loop-state") || path.includes("loop-telemetry")),
      false
    );
    await applyUpdatePlan(root, plan);

    assert.match(
      await readFile(join(root, ".codex", "hooks", "agent-ops-loop.sh"), "utf8"),
      /\/opt\/agent-ops-next\/loop-entry\.js/u
    );
    assert.match(
      await readFile(join(root, ".claude", "hooks", "agent-ops-loop.ps1"), "utf8"),
      /\/opt\/agent-ops-next\/loop-entry\.js/u
    );
    assert.equal(
      await readFile(join(root, ".codex", "loop-goal.md"), "utf8"),
      codexGoal
    );
    assert.equal(
      await readFile(join(root, ".claude", "loop-state.md"), "utf8"),
      claudeState
    );
    assert.equal(
      await readFile(join(root, ".claude", "loop-telemetry.jsonl"), "utf8"),
      telemetry
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall removes loop wrappers, registrations, and ignore marker but retains local files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-loop-uninstall-"));
  try {
    await installLoop(root);
    const codexState = "# Loop state\n\nRuntime data remains.\n";
    const claudeGoal = "# Current goal\n\nUser goal remains.\n";
    await Promise.all([
      writeFile(join(root, ".codex", "loop-state.md"), codexState),
      writeFile(join(root, ".claude", "loop-goal.md"), claudeGoal)
    ]);

    await applyUninstallPlan(root, await createUninstallPlan(root));

    for (const path of [
      ".codex/hooks/agent-ops-loop.sh",
      ".claude/hooks/agent-ops-loop.sh",
      ".claude/hooks/agent-ops-loop.ps1",
      ".codex/hooks.json",
      ".claude/settings.json"
    ]) {
      await assert.rejects(readFile(join(root, path)));
    }
    await assert.rejects(readFile(join(root, ".gitignore")));
    assert.equal(
      await readFile(join(root, ".codex", "loop-state.md"), "utf8"),
      codexState
    );
    assert.equal(
      await readFile(join(root, ".claude", "loop-goal.md"), "utf8"),
      claudeGoal
    );
    assert.match(
      await readFile(join(root, ".codex", "config.toml"), "utf8"),
      /hooks\s*=\s*true/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quotes PowerShell launcher runtime paths", () => {
  const launcher = buildPowerShellLoopLauncher(
    "claude",
    "C:\\Agent's Tools\\hook-entry.js"
  );
  assert.match(
    launcher,
    /\$runtimePath = 'C:\\Agent''s Tools\\loop-entry\.js'/u
  );
  assert.match(launcher, /& node \$runtimePath claude @args/u);
});

test("a changed loop launcher fails closed during uninstall planning", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-loop-tamper-"));
  try {
    await installLoop(root, ["codex"]);
    const launcher = join(root, ".codex", "hooks", "agent-ops-loop.sh");
    await writeFile(launcher, "#!/usr/bin/env bash\necho changed\n");

    await assert.rejects(
      createUninstallPlan(root),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "MANAGED_ARTIFACT_CHANGED"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor reports loop registration drift when a lifecycle handler is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-loop-doctor-"));
  try {
    await installLoop(root, ["codex"]);
    const hooksPath = join(root, ".codex", "hooks.json");
    const hooks = JSON.parse(await readFile(hooksPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    delete hooks.hooks.PreCompact;
    await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0"
    });
    assert.equal(status(report, "artifacts"), "PASS");
    assert.equal(status(report, "registration-drift"), "FAIL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
