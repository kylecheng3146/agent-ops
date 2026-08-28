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
import type {
  TrustBinding,
  TrustStore
} from "../../runtime/src/security/trust.js";

const BINDING: TrustBinding = {
  canonicalPath: "/project",
  remoteIdentity: "example.com/owner/repository",
  configHash: "a".repeat(64),
  runtimeHash: "b".repeat(64)
};

function fakeTrustStore(
  events: string[],
  status: "STALE" | "TRUSTED" | "UNTRUSTED"
): TrustStore {
  return {
    status: async () => ({ status, mismatchedFields: [] }),
    grant: async () => { events.push("grant"); },
    revoke: async () => {
      events.push("revoke");
      return true;
    }
  };
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
  const trustEvents: string[] = [];
  const store = fakeTrustStore(trustEvents, "STALE");
  try {
    await install(root);
    const dryRun = await runUpdateCommand({
      args: parseArgs(["update", "--dry-run"]),
      root,
      adapters: commonHarnessAdapters(),
      targetVersion: "0.2.0",
      isTTY: false,
      trustStore: store,
      calculateTrustBinding: async () => BINDING,
      confirm: async () => {
        throw new Error("dry-run must not confirm");
      }
    });
    assert.equal(dryRun.code, "UPDATE_PLAN_READY");
    assert.equal(dryRun.data?.plan.installation.trust?.action, "grant");
    assert.match(dryRun.data?.text ?? "", /Trust: grant/u);
    assert.deepEqual(trustEvents, []);
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
      trustStore: store,
      calculateTrustBinding: async () => BINDING,
      confirm: async () => {
        throw new Error("--yes must not confirm");
      }
    });
    assert.equal(applied.code, "UPDATE_APPLIED");
    assert.deepEqual(trustEvents, ["grant"]);
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
  const trustEvents: string[] = [];
  const store = fakeTrustStore(trustEvents, "TRUSTED");
  try {
    await install(root);
    const dryRun = await runUninstallCommand({
      args: parseArgs(["uninstall", "--dry-run"]),
      root,
      isTTY: false,
      trustStore: store,
      calculateTrustBinding: async () => BINDING,
      confirm: async () => {
        throw new Error("dry-run must not confirm");
      }
    });
    assert.equal(dryRun.code, "UNINSTALL_PLAN_READY");
    assert.match(dryRun.data?.text ?? "", /Uninstall plan/);
    assert.equal(dryRun.data?.plan.trust?.action, "revoke");
    assert.deepEqual(trustEvents, []);
    assert.match(
      await readFile(join(root, "AGENTS.md"), "utf8"),
      /agent-ops:start agents-routing/
    );

    const applied = await runUninstallCommand({
      args: parseArgs(["uninstall", "--yes"]),
      root,
      isTTY: false,
      trustStore: store,
      calculateTrustBinding: async () => BINDING,
      confirm: async () => {
        throw new Error("--yes must not confirm");
      }
    });
    assert.equal(applied.code, "UNINSTALL_APPLIED");
    assert.deepEqual(trustEvents, ["revoke"]);
    await assert.rejects(readFile(join(root, "AGENTS.md")));
    await assert.rejects(
      readFile(join(root, ".agent-ops", "manifest.json"))
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selective uninstall preserves repository trust for remaining harnesses", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-lifecycle-cli-"));
  const trustEvents: string[] = [];
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["agy", "codex"],
        profiles: ["core"],
        adapters: commonHarnessAdapters(),
        toolkitVersion: "0.1.0"
      })
    );
    const result = await runUninstallCommand({
      args: parseArgs(["uninstall", "--harness", "agy", "--yes"]),
      root,
      isTTY: false,
      trustStore: fakeTrustStore(trustEvents, "TRUSTED"),
      calculateTrustBinding: async () => BINDING,
      confirm: async () => false
    });
    assert.equal(result.code, "UNINSTALL_APPLIED");
    assert.equal(result.data?.plan.trust?.action, "unchanged");
    assert.deepEqual(trustEvents, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trust failures report the already-applied lifecycle change", async () => {
  const updateRoot = await mkdtemp(join(tmpdir(), "agent-ops-lifecycle-cli-"));
  const uninstallRoot = await mkdtemp(join(tmpdir(), "agent-ops-lifecycle-cli-"));
  const failingStore: TrustStore = {
    status: async () => ({ status: "UNTRUSTED", mismatchedFields: [] }),
    grant: async () => { throw new Error("denied"); },
    revoke: async () => { throw new Error("denied"); }
  };
  try {
    await install(updateRoot);
    const updated = await runUpdateCommand({
      args: parseArgs(["update", "--yes"]),
      root: updateRoot,
      adapters: commonHarnessAdapters(),
      targetVersion: "0.2.0",
      isTTY: false,
      trustStore: failingStore,
      calculateTrustBinding: async () => BINDING,
      confirm: async () => false
    });
    assert.equal(updated.code, "UPDATE_TRUST_FAILED");
    assert.equal(updated.data?.applied, true);
    assert.match(
      await readFile(join(updateRoot, ".agent-ops", "AGENTS.md"), "utf8"),
      /Toolkit version: 0\.2\.0/u
    );

    await install(uninstallRoot);
    const revokeStore: TrustStore = {
      ...failingStore,
      status: async () => ({ status: "TRUSTED", mismatchedFields: [] })
    };
    const uninstalled = await runUninstallCommand({
      args: parseArgs(["uninstall", "--yes"]),
      root: uninstallRoot,
      isTTY: false,
      trustStore: revokeStore,
      calculateTrustBinding: async () => BINDING,
      confirm: async () => false
    });
    assert.equal(uninstalled.code, "UNINSTALL_TRUST_FAILED");
    assert.equal(uninstalled.data?.applied, true);
    await assert.rejects(
      readFile(join(uninstallRoot, ".agent-ops", "manifest.json"))
    );
  } finally {
    await rm(updateRoot, { recursive: true, force: true });
    await rm(uninstallRoot, { recursive: true, force: true });
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
