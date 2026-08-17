import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runDoctorCommand } from "../../packages/cli/src/commands/doctor.js";
import { applyInstallPlan } from "../../runtime/src/install/apply.js";
import { commonHarnessAdapters } from "../../runtime/src/install/harness.js";
import { createInstallPlan } from "../../runtime/src/install/plan.js";

function passingProbes() {
  return {
    hookRegistration: () => true,
    repositoryTrust: async () => true,
    smokeAvailability: () => true
  };
}

test("a codeless DEGRADED check (opencode lifecycle-summary) stays exit-ok", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-doctor-cmd-"));
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["opencode"],
        profiles: ["advisory"],
        adapters: commonHarnessAdapters(),
        hookRuntimePath: "/opt/agent-ops/hook-entry.js",
        toolkitVersion: "0.1.0"
      })
    );

    const envelope = await runDoctorCommand({
      root,
      toolkitVersion: "0.1.0",
      probes: passingProbes()
    });

    const lifecycle = envelope.data?.report.checks.find(
      ({ id }) => id === "lifecycle-summary"
    );
    assert.equal(lifecycle?.status, "DEGRADED");
    assert.equal(lifecycle?.code, undefined);
    assert.equal(envelope.code, "DOCTOR_DEGRADED");
    assert.equal(envelope.status, "ok");
    assert.deepEqual(envelope.errors, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a DEGRADED check carrying UPDATE_REQUIRED is exit-error", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-doctor-cmd-"));
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["claude"],
        profiles: ["core"],
        adapters: commonHarnessAdapters(),
        toolkitVersion: "0.1.4"
      })
    );

    const envelope = await runDoctorCommand({
      root,
      toolkitVersion: "0.1.5",
      probes: passingProbes()
    });

    const staleness = envelope.data?.report.checks.find(
      ({ id }) => id === "artifact-staleness"
    );
    assert.equal(staleness?.status, "DEGRADED");
    assert.equal(staleness?.code, "UPDATE_REQUIRED");
    assert.equal(envelope.status, "error");
    assert.notEqual(envelope.errors.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a FAIL with no code (invalid config) is exit-error with DOCTOR_FAILED", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-doctor-cmd-"));
  try {
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
    await writeFile(join(root, ".agent-ops", "config.json"), "{broken");

    const envelope = await runDoctorCommand({
      root,
      toolkitVersion: "0.1.0",
      probes: passingProbes()
    });

    const config = envelope.data?.report.checks.find(({ id }) => id === "config");
    assert.equal(config?.status, "FAIL");
    assert.equal(config?.code, undefined);
    assert.equal(envelope.code, "DOCTOR_FAILED");
    assert.equal(envelope.status, "error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("text output places remediation under its check and preserves check order", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-doctor-cmd-"));
  try {
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

    const envelope = await runDoctorCommand({ root, toolkitVersion: "0.1.0" });
    const text = envelope.data?.text ?? "";
    const checksSection = text.split("\nSurfaces:")[0] ?? text;
    const lines = checksSection.split("\n");

    const checkIds = envelope.data?.report.checks.map(({ id }) => id) ?? [];
    const orderedIds = lines
      .filter((line) => /^- \S+ /.test(line))
      .map((line) => /^- \S+ ([\w-]+)/.exec(line)?.[1]);
    assert.deepEqual(orderedIds, checkIds);

    const trustIndex = lines.findIndex((line) =>
      line.startsWith("- UNKNOWN repository-trust")
    );
    assert.ok(trustIndex >= 0);
    assert.match(lines[trustIndex + 1] ?? "", /^ {2}→ /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("surface rows render their reason inline", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-doctor-cmd-"));
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["claude"],
        profiles: ["core"],
        adapters: commonHarnessAdapters(),
        toolkitVersion: "0.1.0"
      })
    );

    const envelope = await runDoctorCommand({
      root,
      toolkitVersion: "0.1.0",
      probes: passingProbes()
    });
    assert.match(
      envelope.data?.text ?? "",
      /unknown claude\/user-settings:.*\(outside the installation root/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
