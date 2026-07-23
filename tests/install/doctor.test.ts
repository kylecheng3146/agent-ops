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

import type { InstallManifest } from "../../runtime/src/contracts.js";
import { sha256 } from "../../runtime/src/fs/hash.js";
import { formatInstallManifest } from "../../runtime/src/fs/manifest.js";
import {
  doctorInstallation,
  type DoctorCheckId,
  type DoctorProbes,
  type DoctorReport
} from "../../runtime/src/install/doctor.js";

const START_MARKER = "<!-- agent-ops:start codex-routing v1 -->";
const END_MARKER = "<!-- agent-ops:end codex-routing -->";
const MANAGED_BODY =
  "## Loop Engineering\n\nUse `.agent-ops/AGENTS.md` as the canonical Loop Engineering specification for this project.";
const MANAGED_BLOCK =
  `${START_MARKER}\n${MANAGED_BODY}\n${END_MARKER}\n`;
const CONFIG = {
  schemaVersion: 1,
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
  pathMappings: [{ path: "src", verifierIds: ["test"] }],
  securityExceptions: []
};

const CHECK_IDS: readonly DoctorCheckId[] = [
  "node-version",
  "manifest",
  "config",
  "artifacts",
  "markers",
  "hook-registration",
  "repository-trust",
  "smoke-availability"
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
): "PASS" | "FAIL" | "UNKNOWN" {
  const check = report.checks.find(
    (candidate: { readonly id: DoctorCheckId }) => candidate.id === id
  );
  assert.ok(check, `missing doctor check: ${id}`);
  return check.status;
}

async function createInstallation(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-doctor-"));
  await mkdir(join(root, ".agent-ops"), { recursive: true });
  const configSource = `${JSON.stringify(CONFIG, null, 2)}\n`;
  const rulesSource = "# Managed rules\n";
  const agentsSource = `# User instructions\n\n${MANAGED_BLOCK}`;
  await Promise.all([
    writeFile(join(root, ".agent-ops", "config.json"), configSource),
    writeFile(join(root, ".agent-ops", "AGENTS.md"), rulesSource),
    writeFile(join(root, "AGENTS.md"), agentsSource)
  ]);
  const manifest: InstallManifest = {
    schemaVersion: 1,
    scope: "project",
    harness: "codex",
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
  const root = await createInstallation();
  try {
    const before = await snapshotDirectory(root);

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
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
        (check: { readonly status: "PASS" | "FAIL" | "UNKNOWN" }) =>
          check.status
      ),
      CHECK_IDS.map(() => "PASS")
    );
    assert.deepEqual(await snapshotDirectory(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails the artifact check when managed content is tampered", async () => {
  const root = await createInstallation();
  try {
    await writeFile(join(root, ".agent-ops", "AGENTS.md"), "tampered\n");

    const report = await doctorInstallation({
      root,
      nodeVersion: "22.14.0",
      probes: passingProbes()
    });

    assert.equal(checkStatus(report, "artifacts"), "FAIL");
    assert.equal(checkStatus(report, "markers"), "PASS");
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
