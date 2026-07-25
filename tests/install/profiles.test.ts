import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import {
  PROFILE_CAPABILITIES,
  resolveProfiles
} from "../../runtime/src/install/profiles.js";
import {
  COMMON_AGENTS_BLOCK,
  COMMON_CLAUDE_BLOCK
} from "../../runtime/src/install/harness.js";

const ALL_CAPABILITIES = [
  "rules",
  "task",
  "verify",
  "review",
  "lifecycle-summary",
  "local-log",
  "command-policy",
  "optional-stop-verify"
];

test("defines the exact capabilities for each installation profile", () => {
  assert.deepEqual(PROFILE_CAPABILITIES, {
    core: ["rules", "task", "verify", "review"],
    advisory: ["lifecycle-summary", "local-log"],
    guardrails: ["command-policy", "optional-stop-verify"]
  });
});

test("guardrails implies core while advisory remains independent", () => {
  assert.deepEqual(resolveProfiles(["guardrails"]), {
    profiles: ["core", "guardrails"],
    capabilities: [
      "rules",
      "task",
      "verify",
      "review",
      "command-policy",
      "optional-stop-verify"
    ]
  });
  assert.deepEqual(resolveProfiles(["advisory"]), {
    profiles: ["advisory"],
    capabilities: ["lifecycle-summary", "local-log"]
  });
});

test("deduplicates and returns profiles and capabilities in canonical order", () => {
  const resolved = resolveProfiles([
    "guardrails",
    "advisory",
    "core",
    "guardrails",
    "advisory"
  ]);

  assert.deepEqual(resolved, {
    profiles: ["core", "advisory", "guardrails"],
    capabilities: ALL_CAPABILITIES
  });
  assert.equal(
    new Set(resolved.capabilities).size,
    resolved.capabilities.length
  );
});

test("deduplicates repeated core selections", () => {
  assert.deepEqual(resolveProfiles(["core", "core"]), {
    profiles: ["core"],
    capabilities: ["rules", "task", "verify", "review"]
  });
});

test("fails closed with a stable AgentOpsError when no profile is selected", () => {
  assert.throws(
    () => resolveProfiles([]),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "PROFILE_REQUIRED" &&
      error.message === "At least one installation profile is required."
  );
});

test("common routing templates use only managed specification paths", async () => {
  const templates = [
    {
      path: "templates/common/AGENTS.block.md",
      target: ".agent-ops/AGENTS.md"
    },
    {
      path: "templates/common/CLAUDE.block.md",
      target: ".agent-ops/CLAUDE.md"
    }
  ];

  for (const template of templates) {
    const content = (await readFile(resolve(template.path), "utf8"))
      .replace(/\r\n?/gu, "\n");
    const referencedMarkdownPaths = [
      ...content.matchAll(/`([^`]+\.md)`/g)
    ].map((match) => match[1]);

    assert.match(content, /Loop Engineering/);
    assert.deepEqual(referencedMarkdownPaths, [template.target]);
    assert.doesNotMatch(content, /<!--\s*agent-ops:/i);
    assert.doesNotMatch(content, /(?:^|\s)\/(?:Users|home)\//);
    assert.equal(
      content,
      template.target.endsWith("AGENTS.md")
        ? COMMON_AGENTS_BLOCK
        : COMMON_CLAUDE_BLOCK
    );
  }
});
