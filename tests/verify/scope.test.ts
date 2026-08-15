import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentOpsConfig,
  VerificationCommand
} from "../../runtime/src/contracts.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import {
  selectVerificationScope,
  type ScopeSelectionReason
} from "../../runtime/src/verify/scope.js";

function command(id: string, required = true): VerificationCommand {
  return {
    id,
    command: "node",
    args: [],
    cwd: ".",
    required,
    evidence: { kind: "exit-code" }
  };
}

function config(
  pathMappings: AgentOpsConfig["pathMappings"],
  commands: VerificationCommand[] = [
    command("test"),
    command("lint"),
    command("docs", false)
  ]
): AgentOpsConfig {
  return {
    schemaVersion: 2,
    profiles: ["core"],
    verification: { commands },
    features: {
      stopVerification: { enabled: false }
    },
    pathMappings,
    securityExceptions: []
  };
}

test("selects mapped verifier IDs for one unambiguous shared scope", () => {
  const selected = selectVerificationScope(
    ["tests/ui/button.test.ts", "src/ui/button.ts", "src/ui/button.ts"],
    config([
      { path: "src/ui", verifierIds: ["test", "lint", "test"] },
      { path: "tests/ui", verifierIds: ["lint", "test"] },
      { path: "docs", verifierIds: ["docs"] }
    ])
  );

  assert.equal(selected.fallback, false);
  assert.equal(selected.reason, "mapped");
  assert.deepEqual(selected.verifierIds, ["lint", "test"]);
  assert.deepEqual(selected.evidence.changedPaths, [
    "src/ui/button.ts",
    "tests/ui/button.test.ts"
  ]);
  assert.deepEqual(selected.evidence.requiredVerifierIds, ["lint", "test"]);
  assert.deepEqual(selected.evidence.mappings, [
    {
      changedPath: "src/ui/button.ts",
      mappingPaths: ["src/ui"],
      verifierIds: ["lint", "test"]
    },
    {
      changedPath: "tests/ui/button.test.ts",
      mappingPaths: ["tests/ui"],
      verifierIds: ["lint", "test"]
    }
  ]);
});

test("falls back to every required verifier when scope is unsafe", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly paths: readonly string[];
    readonly mappings: AgentOpsConfig["pathMappings"];
    readonly reason: Exclude<ScopeSelectionReason, "mapped">;
  }[] = [
    {
      name: "unknown path",
      paths: ["README.md"],
      mappings: [{ path: "src", verifierIds: ["lint"] }],
      reason: "unknown-path"
    },
    {
      name: "multiple matching mappings",
      paths: ["src/ui/button.ts"],
      mappings: [
        { path: "src", verifierIds: ["lint"] },
        { path: "src/ui", verifierIds: ["test"] }
      ],
      reason: "ambiguous-path"
    },
    {
      name: "conflicting mapped scopes",
      paths: ["src/ui/button.ts", "docs/guide.md"],
      mappings: [
        { path: "src/ui", verifierIds: ["lint", "test"] },
        { path: "docs", verifierIds: ["docs"] }
      ],
      reason: "conflicting-scope"
    },
    {
      name: "no changed paths",
      paths: [],
      mappings: [{ path: "src", verifierIds: ["lint"] }],
      reason: "no-changes"
    },
    {
      name: "mapping has no verifier IDs",
      paths: ["src/ui/button.ts"],
      mappings: [{ path: "src/ui", verifierIds: [] }],
      reason: "empty-mapping"
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const selected = selectVerificationScope(
        scenario.paths,
        config(scenario.mappings)
      );

      assert.equal(selected.fallback, true);
      assert.equal(selected.reason, scenario.reason);
      assert.deepEqual(selected.verifierIds, ["lint", "test"]);
      assert.deepEqual(
        selected.evidence.changedPaths,
        [...new Set(scenario.paths)].sort()
      );
      assert.deepEqual(selected.evidence.requiredVerifierIds, ["lint", "test"]);
    });
  }
});

test("allows a fallback with no required commands", () => {
  const selected = selectVerificationScope(
    ["unknown/file.ts"],
    config([], [command("optional", false)])
  );
  assert.deepEqual(selected.verifierIds, []);
});
