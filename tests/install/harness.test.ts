import assert from "node:assert/strict";
import test from "node:test";

import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import {
  COMMON_AGENTS_BLOCK,
  COMMON_CLAUDE_BLOCK,
  commonHarnessAdapters,
  planHarnessContributions,
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
    "claude",
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

  const planned = await planHarnessContributions("both", CONTEXT, adapters);

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

test("fails with a stable error when a requested adapter is missing", async () => {
  await assert.rejects(
    () =>
      planHarnessContributions("both", CONTEXT, [
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
    () => planHarnessContributions("codex", CONTEXT, duplicateAdapters),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "HARNESS_ADAPTER_DUPLICATE" &&
      error.message === "Duplicate harness adapter: codex"
  );
});

test("common adapters produce scoped routing blocks and managed rules", async () => {
  const project = await planHarnessContributions(
    "both",
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
      content.includes("installation approval never grants trust")
    )
  );

  const user = await planHarnessContributions(
    "both",
    { ...CONTEXT, scope: "user" },
    commonHarnessAdapters()
  );
  assert.deepEqual(
    user.blocks.map(({ path }) => path),
    [".codex/AGENTS.md", ".claude/CLAUDE.md"]
  );
});
