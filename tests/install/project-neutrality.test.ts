import assert from "node:assert/strict";
import test from "node:test";

import { buildClaudeHookSettings } from "../../runtime/src/adapters/claude/config.js";
import { buildCodexHookConfig } from "../../runtime/src/adapters/codex/config.js";
import { buildOpencodePlugin } from "../../runtime/src/adapters/opencode/config.js";
import {
  commonHarnessAdapters,
  planHarnessContributions
} from "../../runtime/src/install/harness.js";
import { planHookRegistration } from "../../runtime/src/install/hooks.js";

const CAPABILITIES = [
  "rules",
  "task",
  "verify",
  "review",
  "lifecycle-summary",
  "local-log",
  "command-policy",
  "optional-stop-verify"
] as const;
const RUNTIME_PATH = "/opt/agent-ops/hook-entry.js";

test("generated runtime artifacts contain no comparison-project tokens", async () => {
  const contribution = await planHarnessContributions(
    ["codex", "claude", "opencode"],
    {
      scope: "project",
      profiles: ["core", "advisory", "guardrails"],
      capabilities: CAPABILITIES,
      runtimePath: RUNTIME_PATH
    },
    commonHarnessAdapters()
  );
  const codexHooks = planHookRegistration({
    harness: "codex",
    scope: "project",
    capabilities: CAPABILITIES,
    runtimePath: RUNTIME_PATH,
    currentSource: "{}"
  });
  const claudeHooks = planHookRegistration({
    harness: "claude",
    scope: "project",
    capabilities: CAPABILITIES,
    runtimePath: RUNTIME_PATH,
    currentSource: "{}"
  });
  const opencodePlugin = buildOpencodePlugin(CAPABILITIES, RUNTIME_PATH);
  const generated = [
    ...contribution.artifacts.map(({ content }) => content),
    ...contribution.blocks.map(({ content }) => content),
    JSON.stringify(buildCodexHookConfig(CAPABILITIES, RUNTIME_PATH)),
    JSON.stringify(buildClaudeHookSettings(CAPABILITIES, RUNTIME_PATH)),
    codexHooks?.content ?? "",
    claudeHooks?.content ?? "",
    opencodePlugin ?? ""
  ];

  for (const output of generated) {
    assert.doesNotMatch(output, /vue-tsc|vitest|claude-mem/iu);
  }
});
