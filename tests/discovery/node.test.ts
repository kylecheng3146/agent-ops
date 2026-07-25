import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverProject } from "../../runtime/src/discovery/index.js";
import {
  discoverNodeProject,
  type NodeProposalDiscoveryResult
} from "../../runtime/src/discovery/node.js";
import type {
  DiscoveryResult,
  UserDecisionDiscoveryResult,
} from "../../runtime/src/discovery/types.js";

function fixturePath(name: string): string {
  return path.resolve("tests", "fixtures", "discovery", "node", name);
}

function assertProposalResult(
  result: DiscoveryResult
): asserts result is NodeProposalDiscoveryResult {
  assert.equal(result.kind, "proposals");
}

function assertUserDecision(
  result: DiscoveryResult
): asserts result is UserDecisionDiscoveryResult {
  assert.equal(result.kind, "user-decision");
}

test("selects a stable package manager from one lockfile", async (t) => {
  const scenarios = [
    {
      fixture: "npm",
      lockfile: "package-lock.json",
      manager: "npm",
      command: "npm",
      args: ["test"],
    },
    {
      fixture: "pnpm",
      lockfile: "pnpm-lock.yaml",
      manager: "pnpm",
      command: "pnpm",
      args: ["test"],
    },
    {
      fixture: "yarn",
      lockfile: "yarn.lock",
      manager: "yarn",
      command: "yarn",
      args: ["test"],
    },
    {
      fixture: "bun",
      lockfile: "bun.lock",
      manager: "bun",
      command: "bun",
      args: ["run", "test"]
    }
  ] as const;

  for (const scenario of scenarios) {
    await t.test(scenario.manager, async () => {
      const result = await discoverNodeProject(fixturePath(scenario.fixture));
      assertProposalResult(result);
      assert.equal(result.packageManager, scenario.manager);
      assert.equal(result.proposals.length, 1);

      const proposal = result.proposals[0];
      assert.ok(proposal);
      assert.equal(proposal.command, scenario.command);
      assert.deepEqual(proposal.args, scenario.args);
      assert.equal(proposal.confirmed, false);
      assert.equal(proposal.confidence, "high");
      assert.ok(
        proposal.sourceEvidence.some(
          (evidence) => evidence.path === scenario.lockfile
        )
      );
      assert.ok(
        proposal.sourceEvidence.some(
          (evidence) => evidence.path === "package.json#scripts.test"
        )
      );
    });
  }
});

test("multiple package-manager lockfiles require a user decision", async () => {
  const result = await discoverNodeProject(fixturePath("multiple-lockfiles"));

  assertUserDecision(result);
  assert.equal(result.reason, "multiple-package-managers");
  assert.equal(result.manualConfigAllowed, true);
  assert.deepEqual(
    result.evidence.map((evidence) => evidence.path),
    ["package-lock.json", "pnpm-lock.yaml"],
  );
  assert.equal("proposals" in result, false);
});

test("unknown and absent verification scripts require a user decision", async (t) => {
  for (const fixture of ["unknown-script", "no-scripts"]) {
    await t.test(fixture, async () => {
      const result = await discoverNodeProject(fixturePath(fixture));

      assertUserDecision(result);
      assert.equal(result.reason, "no-known-scripts");
      assert.equal(result.manualConfigAllowed, true);
    });
  }
});

test("a package without a lockfile does not guess a package manager", async () => {
  const result = await discoverNodeProject(fixturePath("missing-lockfile"));

  assertUserDecision(result);
  assert.equal(result.reason, "missing-lockfile");
  assert.equal(result.manualConfigAllowed, true);
  assert.equal("proposals" in result, false);
});

test("malformed package metadata returns an explicit recoverable decision", async () => {
  const result = await discoverNodeProject(fixturePath("malformed"));

  assertUserDecision(result);
  assert.equal(result.reason, "invalid-package-json");
  assert.equal(result.manualConfigAllowed, true);
  assert.match(result.message, /package\.json/);
});

test("unsupported projects allow manual configuration", async () => {
  const result = await discoverProject(fixturePath("unsupported"));

  assert.equal(result.kind, "no-match");
  assert.equal(result.reason, "unsupported-stack");
  assert.equal(result.manualConfigAllowed, true);
});

test(
  "does not follow a package manifest symlink",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-ops-node-discovery-")
    );
    try {
      const project = path.join(root, "project");
      const outsideManifest = path.join(root, "outside.json");
      await mkdir(project);
      await writeFile(
        outsideManifest,
        JSON.stringify({ scripts: { test: "must not inspect" } })
      );
      await symlink(outsideManifest, path.join(project, "package.json"));
      await writeFile(path.join(project, "package-lock.json"), "{}");

      const result = await discoverNodeProject(project);

      assert.equal(result.kind, "no-match");
      assert.equal(result.reason, "not-node-project");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test("bounds package manifest reads", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "agent-ops-node-discovery-")
  );
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ padding: "x".repeat(1024 * 1024) })
    );
    await writeFile(path.join(root, "package-lock.json"), "{}");

    const result = await discoverNodeProject(root);

    assertUserDecision(result);
    assert.equal(result.reason, "invalid-package-json");
    assert.equal(result.manualConfigAllowed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
