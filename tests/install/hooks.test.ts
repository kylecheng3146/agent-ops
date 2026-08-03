import assert from "node:assert/strict";
import test from "node:test";

import {
  planHookRegistration,
  planHookRemoval,
  CLAUDE_HOOK_PATH,
  CODEX_HOOK_PATH
} from "../../runtime/src/install/hooks.js";
import type { ManagedHookRecord } from "../../runtime/src/contracts.js";

const RUNTIME_PATH = "/opt/agent ops/hook-entry.js";
const LOOP_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop"
];

function claudeRecord(): ManagedHookRecord {
  return {
    id: "claude-hooks",
    path: CLAUDE_HOOK_PATH,
    harness: "claude",
    events: ["SessionStart"],
    owner: "agent-ops"
  };
}

test("core-only capabilities register no hook file", () => {
  assert.equal(
    planHookRegistration({
      harness: "claude",
      scope: "project",
      capabilities: ["rules", "task", "verify", "review"],
      runtimePath: RUNTIME_PATH,
      currentSource: null
    }),
    null
  );
});

test("registration preserves foreign settings and hooks", () => {
  const planned = planHookRegistration({
    harness: "claude",
    scope: "project",
    capabilities: ["lifecycle-summary"],
    runtimePath: RUNTIME_PATH,
    currentSource: JSON.stringify({
      model: "opus",
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "node", args: ["mine.js"] }] }
        ]
      }
    })
  });
  assert.notEqual(planned, null);
  assert.equal(planned?.disclosure, "opaque");
  const settings = JSON.parse(planned?.content ?? "") as {
    model: string;
    hooks: Record<string, { hooks: { args?: string[] }[] }[]>;
  };
  assert.equal(settings.model, "opus");
  const groups = settings.hooks.SessionStart ?? [];
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]?.hooks[0]?.args, ["mine.js"]);
  assert.equal(
    groups[1]?.hooks[0]?.args?.includes("--managed-by=agent-ops"),
    true
  );
  assert.deepEqual(planned?.record, {
    id: "claude-hooks",
    path: CLAUDE_HOOK_PATH,
    harness: "claude",
    events: ["SessionStart"],
    owner: "agent-ops"
  });
});

test("codex registration targets its own hook file", () => {
  const planned = planHookRegistration({
    harness: "codex",
    scope: "project",
    capabilities: ["command-policy"],
    runtimePath: RUNTIME_PATH,
    currentSource: null
  });
  assert.equal(planned?.record.path, CODEX_HOOK_PATH);
  assert.deepEqual(planned?.record.events, ["PreToolUse"]);
  assert.equal(
    planned?.content.includes(
      `node \\"${RUNTIME_PATH}\\" codex PreToolUse --managed-by=agent-ops`
    ),
    true
  );
});

test("loop registration records all native lifecycle events without Stop", () => {
  for (const [harness, path] of [
    ["codex", CODEX_HOOK_PATH],
    ["claude", CLAUDE_HOOK_PATH]
  ] as const) {
    const planned = planHookRegistration({
      harness,
      scope: "project",
      capabilities: ["project-loop"],
      runtimePath: RUNTIME_PATH,
      currentSource: JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "foreign-policy" }] }
          ]
        }
      })
    });
    assert.equal(planned?.record.path, path, harness);
    assert.deepEqual(planned?.record.events, LOOP_EVENTS, harness);
    assert.doesNotMatch(planned?.content ?? "", /"Stop"/u, harness);
    assert.match(planned?.content ?? "", /foreign-policy/u, harness);
  }
});

test("removal strips only owned handlers", () => {
  const registered = planHookRegistration({
    harness: "claude",
    scope: "project",
    capabilities: ["lifecycle-summary"],
    runtimePath: RUNTIME_PATH,
    currentSource: JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "node", args: ["mine.js"] }] }
        ]
      }
    })
  });
  const removal = planHookRemoval(
    claudeRecord(),
    registered?.content ?? ""
  );
  assert.equal(removal.disclosure, "opaque");
  const settings = JSON.parse(removal.content ?? "") as {
    hooks: Record<string, { hooks: { args?: string[] }[] }[]>;
  };
  assert.equal(settings.hooks.SessionStart?.length, 1);
  assert.deepEqual(
    settings.hooks.SessionStart?.[0]?.hooks[0]?.args,
    ["mine.js"]
  );
});

test("removal deletes a file that holds nothing but managed hooks", () => {
  const registered = planHookRegistration({
    harness: "claude",
    scope: "project",
    capabilities: ["lifecycle-summary"],
    runtimePath: RUNTIME_PATH,
    currentSource: null
  });
  assert.equal(
    planHookRemoval(claudeRecord(), registered?.content ?? "").content,
    null
  );
});

test("removal keeps a file that also holds foreign settings", () => {
  const registered = planHookRegistration({
    harness: "claude",
    scope: "project",
    capabilities: ["lifecycle-summary"],
    runtimePath: RUNTIME_PATH,
    currentSource: JSON.stringify({ model: "opus" })
  });
  const removal = planHookRemoval(
    claudeRecord(),
    registered?.content ?? ""
  );
  assert.equal(
    JSON.parse(removal.content ?? "").model,
    "opus"
  );
});

test("invalid hook settings fail closed", () => {
  assert.throws(() =>
    planHookRegistration({
      harness: "claude",
      scope: "project",
      capabilities: ["lifecycle-summary"],
      runtimePath: RUNTIME_PATH,
      currentSource: "{not json"
    })
  );
});
