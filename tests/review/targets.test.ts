import assert from "node:assert/strict";
import test from "node:test";

import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { validateConfig } from "../../runtime/src/schema/validate.js";
import {
  detectHostTarget,
  orderChain,
  resolveReviewRole,
  reviewTargets
} from "../../runtime/src/review/roles.js";

function baseConfig(): Record<string, unknown> {
  return {
    schemaVersion: 3,
    profiles: ["core"],
    verification: { commands: [] },
    features: {
      completionGate: { enabled: false },
      stopVerification: { enabled: false }
    },
    pathMappings: [],
    securityExceptions: []
  };
}

function assertErrorPath(
  result: ReturnType<typeof validateConfig>,
  path: string
): void {
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.errors[0]?.path, path);
}

test("a config without reviewRoles validates and yields no targets", () => {
  const result = validateConfig(baseConfig());
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.reviewRoles, undefined);
  assert.equal(result.value.schemaVersion, 3);
  assert.deepEqual(reviewTargets(result.value, "independent-review"), []);
});

test("a config with reviewRoles round-trips validation at schemaVersion 3", () => {
  const result = validateConfig({
    ...baseConfig(),
    reviewRoles: [
      {
        role: "independent-review",
        targets: ["codex", "agy"],
        model: "configured",
        effort: "high",
        timeoutMs: 120_000
      }
    ]
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.schemaVersion, 3);
  assert.deepEqual(
    reviewTargets(result.value, "independent-review"),
    ["codex", "agy"]
  );
  assert.deepEqual(reviewTargets(result.value, "mechanical"), []);
  assert.equal(
    resolveReviewRole("independent-review", result.value.reviewRoles ?? [])
      ?.effort,
    "high"
  );
});

test("opencode is not a review target even though it is a supported harness", () => {
  const result = validateConfig({
    ...baseConfig(),
    reviewRoles: [
      {
        role: "independent-review",
        targets: ["codex", "opencode"],
        model: "configured",
        effort: "high"
      }
    ]
  });
  assertErrorPath(result, "$.reviewRoles[0].targets[1]");
});

test("reviewRoles entries reject malformed shapes", () => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    [{ role: "nope", targets: ["codex"] }, "$.reviewRoles[0].role"],
    [{ role: "independent-review", targets: [] }, "$.reviewRoles[0].targets"],
    [
      { role: "independent-review", targets: ["codex", "codex"] },
      "$.reviewRoles[0].targets"
    ],
    [
      { role: "independent-review", targets: ["codex"], timeoutMs: 0 },
      "$.reviewRoles[0].timeoutMs"
    ],
    [
      { role: "independent-review", targets: ["codex"], unexpected: true },
      "$.reviewRoles[0].unexpected"
    ]
  ];
  for (const [entry, path] of cases) {
    assertErrorPath(
      validateConfig({ ...baseConfig(), reviewRoles: [entry] }),
      path
    );
  }
  assertErrorPath(
    validateConfig({
      ...baseConfig(),
      reviewRoles: [
        { role: "independent-review", targets: ["codex"] },
        { role: "independent-review", targets: ["agy"] }
      ]
    }),
    "$.reviewRoles"
  );
});

test("orderChain moves a detected host to the end without dropping it", () => {
  assert.deepEqual(orderChain(["claude", "codex"], "claude"), [
    "codex",
    "claude"
  ]);
  assert.deepEqual(orderChain(["claude"], "claude"), ["claude"]);
  assert.deepEqual(orderChain(["codex", "agy", "claude"], "codex"), [
    "agy",
    "claude",
    "codex"
  ]);
  assert.deepEqual(orderChain(["codex", "agy"], undefined), ["codex", "agy"]);
  assert.deepEqual(orderChain(["codex", "agy"], "claude"), ["codex", "agy"]);
});

test("host detection accepts an explicit current CLI and otherwise recognizes Claude", () => {
  assert.equal(detectHostTarget({ AGENT_OPS_HOST: "agy" }), "agy");
  assert.equal(detectHostTarget({ AGENT_OPS_HOST: "codex" }), "codex");
  assert.equal(detectHostTarget({ AGENT_OPS_HOST: "unknown" }), undefined);
  assert.equal(detectHostTarget({ CLAUDECODE: "1" }), "claude");
  assert.equal(detectHostTarget({}), undefined);
  assert.equal(
    detectHostTarget({ AI_AGENT: "claude-code_2-1-228_agent" }),
    undefined
  );
  assert.equal(detectHostTarget({ CODEX_HOME: "/x" }), undefined);
});

test("a loaded config exposes reviewRoles through the config type", () => {
  const config: AgentOpsConfig = {
    schemaVersion: 3,
    profiles: ["core"],
    verification: { commands: [] },
    features: {
      completionGate: { enabled: false },
      stopVerification: { enabled: false }
    },
    pathMappings: [],
    securityExceptions: [],
    reviewRoles: [
      {
        role: "independent-review",
        targets: ["codex"],
        model: "configured",
        effort: "configured"
      }
    ]
  };
  assert.deepEqual(reviewTargets(config, "independent-review"), ["codex"]);
});
