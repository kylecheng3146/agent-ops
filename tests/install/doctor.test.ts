import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  Harness,
  InstallManifest,
  Profile
} from "../../runtime/src/contracts.js";
import { sha256 } from "../../runtime/src/fs/hash.js";
import { formatInstallManifest } from "../../runtime/src/fs/manifest.js";
import { applyInstallPlan } from "../../runtime/src/install/apply.js";
import { commonHarnessAdapters } from "../../runtime/src/install/harness.js";
import {
  doctorInstallation,
  type DoctorCheckId,
  type DoctorProbes,
  type DoctorReport
} from "../../runtime/src/install/doctor.js";
import { createInstallPlan } from "../../runtime/src/install/plan.js";

const START_MARKER = "<!-- agent-ops:start codex-routing v1 -->";
const END_MARKER = "<!-- agent-ops:end codex-routing -->";
const MANAGED_BODY =
  "## Loop Engineering\n\nLoad `.agent-ops/AGENTS.md` as the agent-ops managed baseline.\nProject-specific instructions in this file remain authoritative.";
const LEGACY_MANAGED_BODY =
  "## Loop Engineering\n\nUse `.agent-ops/AGENTS.md` as the canonical Loop Engineering specification for this project.";
const MANAGED_BLOCK =
  `${START_MARKER}\n${MANAGED_BODY}\n${END_MARKER}\n`;
const LEGACY_MANAGED_BLOCK =
  `${START_MARKER}\n${LEGACY_MANAGED_BODY}\n${END_MARKER}\n`;
const TEST_TOOLKIT_VERSION = "0.1.5";
const CONFIG = {
  schemaVersion: 2,
  profiles: ["core"],
  verification: {
    commands: [
      {
        id: "test",
        command: "npm",
        args: ["test"],
        cwd: ".",
        required: true,
        evidence: { kind: "test-count", minimum: 1 }
      }
    ]
  },
  features: {
    stopVerification: { enabled: false }
  },
  pathMappings: [{ path: "src", verifierIds: ["test"] }],
  securityExceptions: []
};

const CHECK_IDS: readonly DoctorCheckId[] = [
  "node-version",
  "manifest",
  "config",
  "artifacts",
  "artifact-staleness",
  "markers",
  "surface-inventory",
  "registration-drift",
  "hook-registration",
  "lifecycle-summary",
  "repository-trust",
  "smoke-availability",
  "review-targets"
];

function passingProbes(): DoctorProbes {
  return {
    hookRegistration: () => true,
    repositoryTrust: async () => true,
    smokeAvailability: () => true
  };
}

function checkStatus(
  report: DoctorReport,
  id: DoctorCheckId
): "PASS" | "FAIL" | "UNKNOWN" | "DEGRADED" | "UNSUPPORTED" {
  const check = report.checks.find(
    (candidate: { readonly id: DoctorCheckId }) => candidate.id === id
  );
  assert.ok(check, `missing doctor check: ${id}`);
  return check.status;
}

async function createInstallation(
  managedBlock = MANAGED_BLOCK
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-doctor-"));
  await mkdir(join(root, ".agent-ops"), { recursive: true });
  const configSource = `${JSON.stringify(CONFIG, null, 2)}\n`;
  const rulesSource = "# Managed rules\n";
  const agentsSource = `# User instructions\n\n${managedBlock}`;
  await Promise.all([
    writeFile(join(root, ".agent-ops", "config.json"), configSource),
    writeFile(join(root, ".agent-ops", "AGENTS.md"), rulesSource),
    writeFile(join(root, "AGENTS.md"), agentsSource)
  ]);
  const manifest: InstallManifest = {
    schemaVersion: 2,
    scope: "project",
    harness: ["codex"],
    artifacts: [
      {
        id: "config",
        path: ".agent-ops/config.json",
        hash: sha256(configSource),
        owner: "agent-ops"
      },
      {
        id: "codex-rules",
        path: ".agent-ops/AGENTS.md",
        hash: sha256(rulesSource),
        owner: "agent-ops"
      }
    ],
    markers: [
      {
        id: "codex-routing",
        path: "AGENTS.md",
        hash: sha256(agentsSource),
        owner: "agent-ops",
        startMarker: START_MARKER,
        endMarker: END_MARKER
      }
    ]
  };
  await writeFile(
    join(root, ".agent-ops", "manifest.json"),
    formatInstallManifest(manifest)
  );
  return root;
}

interface FreshInstallationOptions {
  readonly harness?: Harness;
  readonly profiles?: Profile[];
  readonly toolkitVersion?: string;
  readonly hookRuntimePath?: string;
}

async function createFreshInstallation(
  options: FreshInstallationOptions = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-doctor-fresh-"));
  const harness: Harness = options.harness ?? ["codex"];
  const profiles: Profile[] = options.profiles ?? ["core"];
  await applyInstallPlan(
    root,
    await createInstallPlan({
      root,
      scope: "project",
      harness,
      profiles,
      adapters: commonHarnessAdapters(),
      toolkitVersion: options.toolkitVersion ?? TEST_TOOLKIT_VERSION,
      ...(options.hookRuntimePath === undefined
        ? {}
        : { hookRuntimePath: options.hookRuntimePath })
    })
  );
  return root;
}

async function readManifest(root: string): Promise<InstallManifest> {
  return JSON.parse(
    await readFile(join(root, ".agent-ops", "manifest.json"), "utf8")
  ) as InstallManifest;
}

async function snapshotDirectory(
  root: string
): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath =
        prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot[relativePath] = "directory";
        await visit(absolutePath, relativePath);
      } else if (entry.isSymbolicLink()) {
        snapshot[relativePath] = `symlink:${await readlink(absolutePath)}`;
      } else {
        snapshot[relativePath] = `file:${(
          await readFile(absolutePath)
        ).toString("base64")}`;
      }
    }
  }

  await visit(root, "");
  return snapshot;
}

test("reports stable passing checks without changing the installation", async () => {
  const root = await createFreshInstallation();
  try {
    const before = await snapshotDirectory(root);

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      toolkitVersion: TEST_TOOLKIT_VERSION,
      probes: passingProbes()
    });

    assert.deepEqual(
      report.checks.map(
        (check: { readonly id: DoctorCheckId }) => check.id
      ),
      CHECK_IDS
    );
    assert.deepEqual(
      report.checks.map(
        (check: {
          readonly status:
            | "PASS"
            | "FAIL"
            | "UNKNOWN"
            | "DEGRADED"
            | "UNSUPPORTED"
        }) =>
          check.status
      ),
      CHECK_IDS.map(() => "PASS")
    );
    assert.deepEqual(await snapshotDirectory(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports managed artifacts from an older toolkit as update-required", async () => {
  const root = await createFreshInstallation({
    harness: ["claude"],
    toolkitVersion: "0.1.4"
  });
  try {
    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      toolkitVersion: TEST_TOOLKIT_VERSION,
      probes: passingProbes()
    });

    assert.equal(checkStatus(report, "artifacts"), "PASS");
    assert.equal(checkStatus(report, "artifact-staleness"), "DEGRADED");
    assert.equal(
      report.checks.find(({ id }) => id === "artifact-staleness")?.code,
      "UPDATE_REQUIRED"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports managed artifacts as update-required after profile changes", async () => {
  const root = await createFreshInstallation();
  try {
    const configSource = `${JSON.stringify({
      schemaVersion: 2,
      profiles: ["advisory"],
      verification: { commands: [] },
      features: {
        stopVerification: { enabled: false }
      },
      pathMappings: [],
      securityExceptions: []
    }, null, 2)}\n`;
    const manifest = await readManifest(root);
    await writeFile(join(root, ".agent-ops", "config.json"), configSource);
    await writeFile(
      join(root, ".agent-ops", "manifest.json"),
      formatInstallManifest({
        ...manifest,
        artifacts: manifest.artifacts.map((artifact) =>
          artifact.path === ".agent-ops/config.json"
            ? { ...artifact, hash: sha256(configSource) }
            : artifact
        )
      })
    );

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      toolkitVersion: TEST_TOOLKIT_VERSION,
      probes: passingProbes()
    });

    assert.equal(checkStatus(report, "artifacts"), "PASS");
    assert.equal(checkStatus(report, "artifact-staleness"), "DEGRADED");
    assert.equal(
      report.checks.find(({ id }) => id === "artifact-staleness")?.code,
      "UPDATE_REQUIRED"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses UNKNOWN for artifact staleness without a running toolkit version", async () => {
  const root = await createFreshInstallation();
  try {
    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: passingProbes()
    });

    assert.equal(checkStatus(report, "artifact-staleness"), "UNKNOWN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports desired capability drift as UPDATE_REQUIRED", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-doctor-drift-"));
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
    const configSource = `${JSON.stringify({
      schemaVersion: 2,
      profiles: ["guardrails"],
      verification: {
        commands: [
          {
            id: "test",
            command: "node",
            args: [],
            cwd: ".",
            required: true,
            evidence: { kind: "exit-code" }
          }
        ]
      },
      features: {
        stopVerification: { enabled: true }
      },
      pathMappings: [],
      securityExceptions: []
    }, null, 2)}\n`;
    const manifest = await readManifest(root);
    await writeFile(join(root, ".agent-ops", "config.json"), configSource);
    await writeFile(
      join(root, ".agent-ops", "manifest.json"),
      formatInstallManifest({
        ...manifest,
        artifacts: manifest.artifacts.map((artifact) =>
          artifact.path === ".agent-ops/config.json"
            ? { ...artifact, hash: sha256(configSource) }
            : artifact
        )
      })
    );

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: passingProbes()
    });

    assert.equal(checkStatus(report, "registration-drift"), "FAIL");
    const drift = report.checks.find(
      (candidate) => candidate.id === "registration-drift"
    );
    assert.equal(drift?.code, "UPDATE_REQUIRED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails the artifact check when managed content is tampered", async () => {
  const root = await createFreshInstallation();
  try {
    await writeFile(join(root, ".agent-ops", "AGENTS.md"), "tampered\n");

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      toolkitVersion: TEST_TOOLKIT_VERSION,
      probes: passingProbes()
    });

    assert.equal(checkStatus(report, "artifacts"), "FAIL");
    assert.equal(checkStatus(report, "artifact-staleness"), "UNKNOWN");
    assert.equal(checkStatus(report, "markers"), "PASS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not mask a missing managed artifact as staleness", async () => {
  const root = await createFreshInstallation();
  try {
    await rm(join(root, ".agent-ops", "AGENTS.md"));

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      toolkitVersion: TEST_TOOLKIT_VERSION,
      probes: passingProbes()
    });

    assert.equal(checkStatus(report, "artifacts"), "FAIL");
    assert.equal(checkStatus(report, "artifact-staleness"), "UNKNOWN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("excludes the OpenCode plugin artifact from staleness checks", async () => {
  const root = await createFreshInstallation({
    harness: ["opencode"],
    profiles: ["guardrails"],
    hookRuntimePath: "/opt/agent-ops/hook-entry.js"
  });
  try {
    const manifest = await readManifest(root);
    const plugin = manifest.artifacts.find(
      ({ id }) => id === "opencode-plugin"
    );
    assert.ok(plugin, "expected an OpenCode plugin artifact");
    const source = await readFile(join(root, plugin.path), "utf8");
    const movedRuntimeSource = source.replace(
      "/opt/agent-ops/hook-entry.js",
      "/opt/agent-ops/relocated-hook-entry.js"
    );
    assert.notEqual(movedRuntimeSource, source);
    await writeFile(join(root, plugin.path), movedRuntimeSource);
    await writeFile(
      join(root, ".agent-ops", "manifest.json"),
      formatInstallManifest({
        ...manifest,
        artifacts: manifest.artifacts.map((artifact) =>
          artifact.path === plugin.path
            ? { ...artifact, hash: sha256(movedRuntimeSource) }
            : artifact
        )
      })
    );

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      toolkitVersion: TEST_TOOLKIT_VERSION,
      probes: passingProbes()
    });

    assert.equal(checkStatus(report, "artifacts"), "PASS");
    assert.equal(checkStatus(report, "artifact-staleness"), "PASS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails markers when managed block content changes", async () => {
  const root = await createInstallation();
  try {
    await writeFile(
      join(root, "AGENTS.md"),
      `# User instructions\n\n${START_MARKER}\ntampered body\n${END_MARKER}\n`
    );

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: passingProbes()
    });

    assert.equal(checkStatus(report, "markers"), "FAIL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recognizes an exact legacy routing block as managed but needing migration", async () => {
  const root = await createInstallation(LEGACY_MANAGED_BLOCK);
  try {
    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: passingProbes()
    });

    assert.equal(checkStatus(report, "markers"), "DEGRADED");
    const markerCheck = report.checks.find(
      (candidate) => candidate.id === "markers"
    );
    assert.match(markerCheck?.message ?? "", /legacy|migrat/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a changed legacy routing block instead of treating it as managed", async () => {
  const changedLegacy = LEGACY_MANAGED_BLOCK.replace(
    "canonical Loop Engineering specification",
    "changed Loop Engineering specification"
  );
  const root = await createInstallation(changedLegacy);
  try {
    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: passingProbes()
    });

    assert.equal(checkStatus(report, "markers"), "FAIL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ignores unmanaged text changes outside an intact managed block", async () => {
  const root = await createInstallation();
  try {
    await writeFile(
      join(root, "AGENTS.md"),
      `# Changed user instructions\n\n${MANAGED_BLOCK}Unmanaged footer\n`
    );

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: passingProbes()
    });

    assert.equal(checkStatus(report, "markers"), "PASS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails markers that are duplicated, missing, or reversed", async () => {
  const root = await createInstallation();
  try {
    const invalidSources = [
      `${START_MARKER}\n${START_MARKER}\nbody\n${END_MARKER}\n`,
      `${START_MARKER}\nbody\n`,
      `${END_MARKER}\nbody\n${START_MARKER}\n`
    ];

    for (const source of invalidSources) {
      await writeFile(join(root, "AGENTS.md"), source);
      const report = await doctorInstallation({
        root,
        nodeVersion: "22.14.0",
        probes: passingProbes()
      });
      assert.equal(checkStatus(report, "markers"), "FAIL", source);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aggregates invalid Node and config JSON or references", async () => {
  const root = await createInstallation();
  try {
    await writeFile(join(root, ".agent-ops", "config.json"), "{broken");
    const malformed = await doctorInstallation({
      root,
      nodeVersion: "22.13.9",
      probes: passingProbes()
    });
    assert.equal(checkStatus(malformed, "node-version"), "FAIL");
    assert.equal(checkStatus(malformed, "config"), "FAIL");
    assert.equal(checkStatus(malformed, "markers"), "PASS");
    assert.equal(checkStatus(malformed, "hook-registration"), "PASS");

    await writeFile(
      join(root, ".agent-ops", "config.json"),
      `${JSON.stringify({
        ...CONFIG,
        pathMappings: [{ path: "src", verifierIds: ["missing"] }]
      })}\n`
    );
    const unknownReference = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: passingProbes()
    });
    assert.equal(checkStatus(unknownReference, "config"), "FAIL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses UNKNOWN for absent probes and PASS for successful probes", async () => {
  const root = await createInstallation();
  try {
    const unknown = await doctorInstallation({
      root,
      nodeVersion: "22.14.0"
    });
    assert.deepEqual(
      [
        checkStatus(unknown, "hook-registration"),
        checkStatus(unknown, "repository-trust"),
        checkStatus(unknown, "smoke-availability")
      ],
      ["UNKNOWN", "UNKNOWN", "UNKNOWN"]
    );

    const passing = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: passingProbes()
    });
    assert.deepEqual(
      [
        checkStatus(passing, "hook-registration"),
        checkStatus(passing, "repository-trust"),
        checkStatus(passing, "smoke-availability")
      ],
      ["PASS", "PASS", "PASS"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("probes may report a status directly", async () => {
  const root = await createInstallation();
  try {
    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: {
        hookRegistration: () => "PASS",
        repositoryTrust: () => "UNKNOWN",
        smokeAvailability: () => "FAIL"
      }
    });
    assert.deepEqual(
      [
        checkStatus(report, "hook-registration"),
        checkStatus(report, "repository-trust"),
        checkStatus(report, "smoke-availability")
      ],
      ["PASS", "UNKNOWN", "FAIL"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when an artifact path escapes through a symlink", async () => {
  const root = await createInstallation();
  const outside = await mkdtemp(join(tmpdir(), "agent-ops-outside-"));
  try {
    const outsideSource = "outside\n";
    await writeFile(join(outside, "secret.txt"), outsideSource);
    await symlink(
      outside,
      join(root, ".agent-ops", "escaped"),
      "junction"
    );
    const manifest = await readManifest(root);
    manifest.artifacts.push({
      id: "escaped",
      path: ".agent-ops/escaped/secret.txt",
      hash: sha256(outsideSource),
      owner: "agent-ops"
    });
    await writeFile(
      join(root, ".agent-ops", "manifest.json"),
      formatInstallManifest(manifest)
    );

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: passingProbes()
    });

    assert.equal(checkStatus(report, "manifest"), "FAIL");
    assert.equal(checkStatus(report, "artifacts"), "FAIL");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("reports OpenCode lifecycle summaries as degraded behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-doctor-opencode-"));
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["opencode"],
        profiles: ["advisory"],
        adapters: commonHarnessAdapters(),
        hookRuntimePath: "/opt/agent-ops/hook-entry.js"
      })
    );
    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: passingProbes()
    });
    const lifecycle = report.checks.find(
      (candidate: { readonly id: string }) => candidate.id === "lifecycle-summary"
    );
    assert.equal(lifecycle?.status, "DEGRADED");
    assert.match(lifecycle?.message ?? "", /degraded/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("omits remediation on PASS and carries it on every non-PASS check", async () => {
  const root = await createFreshInstallation();
  try {
    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      toolkitVersion: TEST_TOOLKIT_VERSION,
      probes: passingProbes()
    });
    for (const item of report.checks) {
      if (item.status === "PASS") {
        assert.equal(item.remediation, undefined, `${item.id} PASS should omit remediation`);
      } else {
        assert.ok(
          item.remediation !== undefined && item.remediation.length > 0,
          `${item.id} ${item.status} should carry remediation`
        );
      }
    }

    await writeFile(join(root, ".agent-ops", "config.json"), "{broken");
    const broken = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      toolkitVersion: TEST_TOOLKIT_VERSION,
      probes: passingProbes()
    });
    const configCheck = broken.checks.find(({ id }) => id === "config");
    assert.equal(configCheck?.status, "FAIL");
    assert.doesNotMatch(
      configCheck?.remediation ?? "",
      /^Run `agent-ops init`/
    );
    assert.match(configCheck?.remediation ?? "", /not run/i);

    const artifactsCheck = broken.checks.find(({ id }) => id === "artifacts");
    if (artifactsCheck?.status === "FAIL") {
      assert.match(artifactsCheck.remediation ?? "", /overwrit/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marks descriptor-declared degradation as needing no action", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-doctor-opencode-remediation-"));
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["opencode"],
        profiles: ["advisory"],
        adapters: commonHarnessAdapters(),
        hookRuntimePath: "/opt/agent-ops/hook-entry.js"
      })
    );
    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: passingProbes()
    });
    const lifecycle = report.checks.find(({ id }) => id === "lifecycle-summary");
    assert.equal(lifecycle?.status, "DEGRADED");
    assert.match(lifecycle?.remediation ?? "", /no action/i);
    assert.equal(lifecycle?.code, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("smoke-availability UNKNOWN needs no action", async () => {
  const root = await createInstallation();
  try {
    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: {
        hookRegistration: () => true,
        repositoryTrust: async () => true,
        smokeAvailability: () => "UNKNOWN"
      }
    });
    const smoke = report.checks.find(({ id }) => id === "smoke-availability");
    assert.equal(smoke?.status, "UNKNOWN");
    assert.match(smoke?.remediation ?? "", /no action/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review-targets failures carry remediation but no code", async () => {
  const root = await createInstallation();
  try {
    const configSource = `${JSON.stringify({
      ...CONFIG,
      reviewRoles: [{ role: "independent-review", targets: ["codex"] }]
    })}\n`;
    await writeFile(join(root, ".agent-ops", "config.json"), configSource);

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: {
        ...passingProbes(),
        reviewTarget: () => "missing-executable"
      }
    });
    const reviewTargets = report.checks.find(({ id }) => id === "review-targets");
    assert.equal(reviewTargets?.status, "FAIL");
    assert.equal(reviewTargets?.code, undefined);
    assert.ok(
      reviewTargets?.remediation !== undefined &&
        reviewTargets.remediation.length > 0
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("treats an empty profile list as no lifecycle capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-doctor-empty-profile-"));
  try {
    await applyInstallPlan(
      root,
      await createInstallPlan({
        root,
        scope: "project",
        harness: ["opencode"],
        profiles: ["core"],
        adapters: commonHarnessAdapters(),
        toolkitVersion: TEST_TOOLKIT_VERSION
      })
    );
    const configSource = `${JSON.stringify({
      schemaVersion: 2,
      profiles: [],
      verification: { commands: [] },
      features: {
        stopVerification: { enabled: false }
      },
      pathMappings: [],
      securityExceptions: []
    }, null, 2)}\n`;
    const manifest = await readManifest(root);
    const updatedManifest: InstallManifest = {
      ...manifest,
      artifacts: manifest.artifacts.map((artifact) =>
        artifact.path === ".agent-ops/config.json"
          ? { ...artifact, hash: sha256(configSource) }
          : artifact
      )
    };
    await writeFile(
      join(root, ".agent-ops", "config.json"),
      configSource
    );
    await writeFile(
      join(root, ".agent-ops", "manifest.json"),
      formatInstallManifest(updatedManifest)
    );

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      toolkitVersion: TEST_TOOLKIT_VERSION,
      probes: passingProbes()
    });
    assert.equal(checkStatus(report, "config"), "PASS");
    assert.equal(checkStatus(report, "artifacts"), "PASS");
    assert.equal(checkStatus(report, "artifact-staleness"), "DEGRADED");
    assert.equal(
      report.checks.find(({ id }) => id === "artifact-staleness")?.code,
      "UPDATE_REQUIRED"
    );
    assert.equal(checkStatus(report, "lifecycle-summary"), "PASS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
