import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildClaudeHookSettings,
  claudeRoutingBlock,
  claudeSettingsTarget,
  mergeClaudeSettings
} from "../../runtime/src/adapters/claude/config.js";
import {
  CLAUDE_SUPPORTED_EVENTS,
  claudeNonInteractiveTrust
} from "../../runtime/src/adapters/claude/events.js";
import {
  claudeStopRecursionMarker,
  normalizeClaudeHookInput
} from "../../runtime/src/adapters/claude/input.js";
import { claudeHookOutput } from "../../runtime/src/adapters/claude/output.js";

async function fixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      resolve("tests", "fixtures", "claude", "settings-existing.json"),
      "utf8"
    )
  ) as unknown;
}

test("merges only agent-ops hooks and preserves unrelated Claude settings", async () => {
  const existing = await fixture();
  const managed = buildClaudeHookSettings(
    [
      "lifecycle-summary",
      "command-policy",
      "optional-stop-verify"
    ],
    "/opt/agent ops/hook-entry.js"
  );

  const merged = mergeClaudeSettings(existing, managed);
  const serialized = JSON.stringify(merged);

  assert.deepEqual(
    merged.permissions,
    (existing as typeof merged).permissions
  );
  assert.match(serialized, /user-policy/);
  assert.match(serialized, /\/user\/hook\.js/);
  assert.match(serialized, /user-audit append/);
  assert.doesNotMatch(serialized, /\/old\/agent-ops/);
  assert.match(serialized, /SessionStart/);
  assert.match(serialized, /PreToolUse/);
  assert.match(serialized, /Stop/);
});

test("uses settings.json paths and never invents standalone hooks.json", () => {
  assert.deepEqual(claudeSettingsTarget("project"), {
    path: ".claude/settings.json",
    requiresWorkspaceTrust: true
  });
  assert.deepEqual(claudeSettingsTarget("user"), {
    path: "~/.claude/settings.json",
    requiresWorkspaceTrust: false
  });
  assert.doesNotMatch(
    JSON.stringify([
      claudeSettingsTarget("project"),
      claudeSettingsTarget("user")
    ]),
    /hooks\.json/
  );
});

test("prefers direct exec and keeps paths with spaces as one argument", () => {
  const settings = buildClaudeHookSettings(
    ["command-policy"],
    "/opt/agent ops/hook-entry.js"
  );
  const handler = settings.hooks.PreToolUse?.[0]?.hooks[0];

  assert.deepEqual(handler, {
    type: "command",
    command: "node",
    args: [
      "/opt/agent ops/hook-entry.js",
      "claude",
      "PreToolUse",
      "--managed-by=agent-ops"
    ],
    timeout: 30
  });
  assert.equal("shell" in (handler ?? {}), false);
});

test("provides a bounded CLAUDE.md routing block as context, not policy", () => {
  const block = claudeRoutingBlock();

  assert.match(block, /\.agent-ops\/CLAUDE\.md/);
  assert.match(block, /context/i);
  assert.doesNotMatch(block, /system prompt|hard override/i);
  assert.ok(block.length < 500);
});

test("normalizes only fields used by Claude hook policy", () => {
  assert.deepEqual(
    normalizeClaudeHookInput({
      hook_event_name: "PreToolUse",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "git push --force origin main" },
      transcript_path: "/private/transcript.jsonl",
      session_id: "drop-me"
    }),
    {
      event: "command",
      projectRoot: "/repo",
      command: "git",
      args: ["push", "--force", "origin", "main"],
      scope: "/repo"
    }
  );
  assert.deepEqual(
    normalizeClaudeHookInput({
      hook_event_name: "PreToolUse",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: {
        command: "echo ok && git push --force \"origin\" main"
      }
    }),
    {
      event: "command-batch",
      projectRoot: "/repo",
      commands: [
        { command: "echo", args: ["ok"] },
        {
          command: "git",
          args: ["push", "--force", "origin", "main"]
        }
      ],
      scope: "/repo"
    }
  );
  assert.deepEqual(
    normalizeClaudeHookInput({
      hook_event_name: "Stop",
      cwd: "/repo",
      stop_hook_active: true
    }),
    {
      event: "stop",
      projectRoot: "/repo"
    }
  );
  assert.equal(
    claudeStopRecursionMarker({
      hook_event_name: "Stop",
      stop_hook_active: true
    }),
    true
  );
  assert.equal(
    claudeStopRecursionMarker({
      hook_event_name: "Stop",
      stop_hook_active: false
    }),
    false
  );
});

test("preserves Claude event-specific JSON decisions", () => {
  assert.deepEqual(
    claudeHookOutput("PreToolUse", {
      action: "block",
      status: "FAIL",
      code: "destructive-force-push"
    }),
    {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "destructive-force-push"
        }
      }),
      stderr: ""
    }
  );
  assert.deepEqual(
    claudeHookOutput("Stop", {
      action: "block",
      status: "FAIL",
      code: "STOP_FAILED"
    }),
    {
      exitCode: 0,
      stdout: JSON.stringify({
        decision: "block",
        reason: "STOP_FAILED"
      }),
      stderr: ""
    }
  );
});

test("surfaces non-interactive trust limitations", () => {
  assert.deepEqual(CLAUDE_SUPPORTED_EVENTS, [
    "SessionStart",
    "PreToolUse",
    "Stop"
  ]);
  assert.equal(claudeNonInteractiveTrust(false), "interactive-dialog");
  assert.equal(claudeNonInteractiveTrust(true), "dialog-skipped");
});
