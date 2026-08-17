import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import {
  runDoctorCommand
} from "../../packages/cli/src/commands/doctor.js";
import {
  runUninstallCommand
} from "../../packages/cli/src/commands/uninstall.js";
import {
  runUpdateCommand
} from "../../packages/cli/src/commands/update.js";
import { applyInstallPlan } from "../../runtime/src/install/apply.js";
import {
  commonHarnessAdapters
} from "../../runtime/src/install/harness.js";
import { createInstallPlan } from "../../runtime/src/install/plan.js";

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

async function installClaudeWithSensitiveSettings(root: string): Promise<void> {
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(
    join(root, ".claude", "settings.json"),
    JSON.stringify({
      permissions: {
        allow: ["FAKE_SECRET_SENTINEL", "FAKE_FOREIGN_COMMAND"]
      },
      hooks: {}
    })
  );
  await applyInstallPlan(
    root,
    await createInstallPlan({
      root,
      scope: "project",
      harness: ["claude"],
      profiles: ["guardrails"],
      adapters: commonHarnessAdapters(),
      toolkitVersion: "0.1.0",
      hookRuntimePath: "/opt/agent-ops/hook-entry.js"
    })
  );
}

test("doctor command reports PASS only when every probe passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-lifecycle-cli-"));
  try {
    await install(root);
    const unknown = await runDoctorCommand({ root });
    assert.equal(unknown.code, "DOCTOR_UNKNOWN");
    // Wiring nothing (no probes) is itself benign — every unresolved check is
    // an UNKNOWN with no actionable `code`, so the envelope stays "ok".
    assert.equal(unknown.status, "ok");
    assert.match(unknown.data?.text ?? "", /UNKNOWN repository-trust/);

    const passing = await runDoctorCommand({
      root,
      toolkitVersion: "0.1.0",
      probes: {
        hookRegistration: () => true,
        repositoryTrust: () => true,
        smokeAvailability: () => true
      }
    });
    assert.equal(passing.code, "DOCTOR_OK");
    assert.equal(passing.status, "ok");
    assert.ok(
      passing.data?.report.checks.every(
        ({ status }) => status === "PASS"
      )
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update command supports offline dry-run and explicit apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-lifecycle-cli-"));
  try {
    await install(root);
    const dryRun = await runUpdateCommand({
      args: parseArgs(["update", "--dry-run"]),
      root,
      adapters: commonHarnessAdapters(),
      targetVersion: "0.2.0",
      isTTY: false,
      confirm: async () => {
        throw new Error("dry-run must not confirm");
      }
    });
    assert.equal(dryRun.code, "UPDATE_PLAN_READY");
    assert.match(dryRun.data?.text ?? "", /Target version: 0\.2\.0/);
    assert.match(
      await readFile(join(root, ".agent-ops", "AGENTS.md"), "utf8"),
      /Toolkit version: 0\.1\.0/
    );

    const applied = await runUpdateCommand({
      args: parseArgs(["update", "--yes"]),
      root,
      adapters: commonHarnessAdapters(),
      targetVersion: "0.2.0",
      isTTY: false,
      confirm: async () => {
        throw new Error("--yes must not confirm");
      }
    });
    assert.equal(applied.code, "UPDATE_APPLIED");
    assert.match(
      await readFile(join(root, ".agent-ops", "AGENTS.md"), "utf8"),
      /Toolkit version: 0\.2\.0/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstall command dry-runs then removes only managed content", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-lifecycle-cli-"));
  try {
    await install(root);
    const dryRun = await runUninstallCommand({
      args: parseArgs(["uninstall", "--dry-run"]),
      root,
      isTTY: false,
      confirm: async () => {
        throw new Error("dry-run must not confirm");
      }
    });
    assert.equal(dryRun.code, "UNINSTALL_PLAN_READY");
    assert.match(dryRun.data?.text ?? "", /Uninstall plan/);
    assert.match(
      await readFile(join(root, "AGENTS.md"), "utf8"),
      /agent-ops:start agents-routing/
    );

    const applied = await runUninstallCommand({
      args: parseArgs(["uninstall", "--yes"]),
      root,
      isTTY: false,
      confirm: async () => {
        throw new Error("--yes must not confirm");
      }
    });
    assert.equal(applied.code, "UNINSTALL_APPLIED");
    await assert.rejects(readFile(join(root, "AGENTS.md")));
    await assert.rejects(
      readFile(join(root, ".agent-ops", "manifest.json"))
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public update and uninstall envelopes hide foreign Claude settings values", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-lifecycle-cli-"));
  try {
    await installClaudeWithSensitiveSettings(root);
    const update = await runUpdateCommand({
      args: parseArgs(["update", "--dry-run", "--json"]),
      root,
      adapters: commonHarnessAdapters(),
      targetVersion: "0.2.0",
      isTTY: false,
      confirm: async () => false
    });
    const uninstall = await runUninstallCommand({
      args: parseArgs(["uninstall", "--dry-run", "--json"]),
      root,
      isTTY: false,
      confirm: async () => false
    });

    for (const envelope of [update, uninstall]) {
      const serialized = JSON.stringify(envelope);
      assert.doesNotMatch(
        serialized,
        /FAKE_SECRET_SENTINEL|FAKE_FOREIGN_COMMAND/u
      );
      assert.doesNotMatch(
        envelope.data?.text ?? "",
        /FAKE_SECRET_SENTINEL|FAKE_FOREIGN_COMMAND/u
      );
    }
    assert.match(
      await readFile(join(root, ".claude", "settings.json"), "utf8"),
      /FAKE_SECRET_SENTINEL/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
