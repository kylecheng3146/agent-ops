import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { discoverProject } from "../../runtime/src/discovery/index.js";
import { discoverNodeProject } from "../../runtime/src/discovery/node.js";
import type {
  DiscoveryResult,
  ProposalDiscoveryResult,
  UserDecisionDiscoveryResult,
} from "../../runtime/src/discovery/types.js";

function fixturePath(name: string): string {
  return path.resolve("tests", "fixtures", "discovery", "node", name);
}

function assertProposalResult(
  result: DiscoveryResult,
): asserts result is ProposalDiscoveryResult {
  assert.equal(result.kind, "proposals");
}

function assertUserDecision(
  result: DiscoveryResult,
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
          (evidence) => evidence.path === scenario.lockfile,
        ),
      );
      assert.ok(
        proposal.sourceEvidence.some(
          (evidence) => evidence.path === "package.json#scripts.test",
        ),
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
