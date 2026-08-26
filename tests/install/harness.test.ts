import assert from "node:assert/strict";
import test from "node:test";

import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import {
  COMMON_AGENTS_BLOCK,
  COMMON_CLAUDE_BLOCK,
  commonHarnessAdapters,
  HARNESS_IDS,
  harnessDescriptor,
  planHarnessContributions,
  resolveHarnessSelection,
  type HarnessContribution,
  type HarnessId,
  type HarnessInstallAdapter,
  type HarnessPlanContext
} from "../../runtime/src/install/harness.js";

const CONTEXT: HarnessPlanContext = {
  scope: "project",
  profiles: ["core", "guardrails"],
  capabilities: [
    "rules",
    "task",
    "verify",
    "review",
    "command-policy",
    "optional-stop-verify"
  ]
};

function contribution(id: HarnessId): HarnessContribution {
  return {
    artifacts: [
      {
        id: `${id}-artifact`,
        path: `.agent-ops/${id}.json`,
        content: `${id} artifact`
      }
    ],
    blocks: [
      {
        id: `${id}-block`,
        path: `${id.toUpperCase()}.md`,
        version: 1,
        content: `${id} block`
      }
    ]
  };
}

function adapter(
  id: HarnessId,
  calls: Array<{ id: HarnessId; context: HarnessPlanContext }>
): HarnessInstallAdapter {
  return {
    id,
    async plan(context: HarnessPlanContext) {
      calls.push({ id, context });
      return contribution(id);
    }
  };
}

test("selects exactly the requested concrete harness and passes context", async () => {
  const calls: Array<{ id: HarnessId; context: HarnessPlanContext }> = [];
  const adapters: readonly HarnessInstallAdapter[] = [
    adapter("claude", calls),
    adapter("codex", calls)
  ];

  const planned = await planHarnessContributions(
    ["claude"],
    CONTEXT,
    adapters
  );

  assert.deepEqual(planned, contribution("claude"));
  assert.deepEqual(calls.map(({ id }) => id), ["claude"]);
  assert.equal(calls[0]?.context, CONTEXT);
});

test("aggregates both harnesses in codex then claude order", async () => {
  const calls: Array<{ id: HarnessId; context: HarnessPlanContext }> = [];
  const adapters: readonly HarnessInstallAdapter[] = [
    adapter("claude", calls),
    adapter("codex", calls)
  ];

  const planned = await planHarnessContributions(["codex", "claude"], CONTEXT, adapters);

  assert.deepEqual(calls.map(({ id }) => id), ["codex", "claude"]);
  assert.deepEqual(planned, {
    artifacts: [
      ...contribution("codex").artifacts,
      ...contribution("claude").artifacts
    ],
    blocks: [
      ...contribution("codex").blocks,
      ...contribution("claude").blocks
    ]
  });
  assert.equal(calls[0]?.context, CONTEXT);
  assert.equal(calls[1]?.context, CONTEXT);
});

test("deduplicates the shared project AGENTS contribution for codex and opencode", async () => {
  const planned = await planHarnessContributions(
    ["codex", "opencode"],
    { ...CONTEXT, runtimePath: "/opt/agent-ops/hook-entry.js" },
    commonHarnessAdapters()
  );

  assert.deepEqual(
    planned.artifacts.map(({ id, path }) => ({ id, path })),
    [
      { id: "agents-rules", path: ".agent-ops/AGENTS.md" },
      { id: "opencode-plugin", path: ".opencode/plugins/agent-ops.js" }
    ]
  );
  assert.deepEqual(
    planned.blocks.map(({ id, path }) => ({ id, path })),
    [{ id: "agents-routing", path: "AGENTS.md" }]
  );
});

test("fails with a stable error when a requested adapter is missing", async () => {
  await assert.rejects(
    () =>
      planHarnessContributions(["codex", "claude"], CONTEXT, [
        {
          id: "codex",
          async plan() {
            return contribution("codex");
          }
        }
      ]),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "HARNESS_ADAPTER_MISSING" &&
      error.message === "Missing harness adapter: claude"
  );
});

test("fails with a stable error when a requested adapter is duplicated", async () => {
  const duplicateAdapters: readonly HarnessInstallAdapter[] = [
    {
      id: "codex",
      async plan() {
        return contribution("codex");
      }
    },
    {
      id: "codex",
      async plan() {
        return contribution("codex");
      }
    }
  ];

  await assert.rejects(
    () => planHarnessContributions(["codex"], CONTEXT, duplicateAdapters),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "HARNESS_ADAPTER_DUPLICATE" &&
      error.message === "Duplicate harness adapter: codex"
  );
});

test("common adapters produce scoped routing blocks and managed rules", async () => {
  const project = await planHarnessContributions(
    ["codex", "claude"],
    CONTEXT,
    commonHarnessAdapters()
  );
  assert.deepEqual(
    project.blocks.map(({ path, content }) => ({ path, content })),
    [
      { path: "AGENTS.md", content: COMMON_AGENTS_BLOCK },
      { path: "CLAUDE.md", content: COMMON_CLAUDE_BLOCK }
    ]
  );
  assert.deepEqual(
    project.artifacts.map(({ path }) => path),
    [".agent-ops/AGENTS.md", ".agent-ops/CLAUDE.md"]
  );
  assert.ok(
    project.artifacts.every(({ content }) =>
      content.includes("Confirmed project init/update grants it")
    )
  );

  const user = await planHarnessContributions(
    ["codex", "claude", "opencode"],
    { ...CONTEXT, root: "/tmp/agent-ops-home", scope: "user" },
    commonHarnessAdapters()
  );
  assert.deepEqual(
    user.blocks.map(({ path }) => path),
    [".codex/AGENTS.md", ".claude/CLAUDE.md", ".opencode/AGENTS.md"]
  );
  const userOpencode = await planHarnessContributions(
    ["opencode"],
    {
      ...CONTEXT,
      root: "/tmp/agent-ops-home",
      scope: "user",
      runtimePath: "/opt/agent-ops/hook-entry.js"
    },
    commonHarnessAdapters()
  );
  assert.equal(
    userOpencode.artifacts.find(({ id }) => id === "opencode-plugin")?.path,
    ".config/opencode/plugins/agent-ops.js"
  );

  const advisory = await planHarnessContributions(
    ["codex"],
    {
      scope: "project",
      profiles: ["advisory"],
      capabilities: ["lifecycle-summary", "local-log"]
    },
    commonHarnessAdapters()
  );
  const advisoryRules = advisory.artifacts[0]?.content ?? "";
  assert.match(advisoryRules, /fail-open/);
  assert.doesNotMatch(advisoryRules, /acceptance criteria/);
  assert.doesNotMatch(advisoryRules, /independent review/);
  assert.doesNotMatch(advisoryRules, /Repository commands require/);
});

test("identical contributions from two harnesses collapse into one entry", async () => {
  const shared = {
    artifacts: [
      { id: "shared-rules", path: ".agent-ops/AGENTS.md", content: "shared" }
    ],
    blocks: [
      {
        id: "shared-routing",
        path: "AGENTS.md",
        version: 1,
        content: "block"
      }
    ]
  };
  const planned = await planHarnessContributions(
    ["codex", "claude"],
    CONTEXT,
    [
      { id: "codex", async plan() { return shared; } },
      { id: "claude", async plan() { return shared; } }
    ]
  );

  assert.deepEqual(planned, shared);
});

test("resolves harness aliases and rejects unusable selections", () => {
  assert.deepEqual(resolveHarnessSelection("both"), ["codex", "claude"]);
  assert.deepEqual(resolveHarnessSelection("all"), [...HARNESS_IDS]);
  assert.deepEqual(resolveHarnessSelection("claude"), ["claude"]);
  assert.deepEqual(resolveHarnessSelection("codex, claude"), [
    "codex",
    "claude"
  ]);
  assert.equal(resolveHarnessSelection(""), null);
  assert.equal(resolveHarnessSelection("codex,codex"), null);
  assert.deepEqual(resolveHarnessSelection("codex,opencode"), [
    "codex",
    "opencode"
  ]);
});

test("every harness exposes control and runtime adapter contracts", () => {
  for (const id of HARNESS_IDS) {
    const descriptor = harnessDescriptor(id);
    assert.equal(typeof descriptor.control.plan, "function", id);
    assert.equal(typeof descriptor.control.hookRegistered, "function", id);
    assert.ok(descriptor.control.registrations.length > 0, id);
    assert.equal(typeof descriptor.runtime.normalizeInput, "function", id);
    assert.equal(typeof descriptor.runtime.formatOutput, "function", id);
    assert.equal(
      typeof descriptor.runtime.formatRuntimeFailure,
      "function",
      id
    );
    for (const registration of descriptor.control.registrations) {
      assert.ok(registration.surfaceId.length > 0, id);
      assert.ok(registration.nativeEvent.length > 0, id);
      assert.ok(registration.normalizedEvent.length > 0, id);
      assert.ok(registration.capability.length > 0, id);
      const failure = descriptor.runtime.formatRuntimeFailure(
        registration.nativeEvent,
        registration.capability
      );
      assert.equal(failure.exitCode, 0, id);
      if (registration.runtimeFailure === "fail-closed") {
        assert.match(failure.stdout, /deny/, id);
      } else {
        assert.doesNotMatch(failure.stdout, /deny/, id);
      }
    }
  }
});

test("support declarations match the current real hook fidelity", () => {
  const supportByHarness = Object.fromEntries(
    HARNESS_IDS.map((id) => [
      id,
      Object.fromEntries(
        harnessDescriptor(id).control.registrations.map((registration) => [
          registration.capability,
          {
            support: registration.support,
            runtimeFailure: registration.runtimeFailure
          }
        ])
      )
    ])
  );

  assert.deepEqual(supportByHarness, {
    codex: {
      "lifecycle-summary": {
        support: "supported",
        runtimeFailure: "fail-open"
      },
      "command-policy": {
        support: "unknown",
        runtimeFailure: "native-unknown"
      },
      "optional-stop-verify": {
        support: "unsupported",
        runtimeFailure: "fail-open"
      }
    },
    claude: {
      "lifecycle-summary": {
        support: "supported",
        runtimeFailure: "fail-open"
      },
      "command-policy": {
        support: "supported",
        runtimeFailure: "fail-closed"
      },
      "optional-stop-verify": {
        support: "supported",
        runtimeFailure: "fail-open"
      }
    },
    opencode: {
      "lifecycle-summary": {
        support: "degraded",
        runtimeFailure: "fail-open"
      },
      "command-policy": {
        support: "supported",
        runtimeFailure: "fail-closed"
      },
      "optional-stop-verify": {
        support: "degraded",
        runtimeFailure: "fail-open"
      }
    }
  });
});
