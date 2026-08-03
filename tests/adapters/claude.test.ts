import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildClaudeHookSettings,
  claudeSettingsTarget,
  isClaudeManagedHandler,
  mergeClaudeSettings,
  stripClaudeManagedHooks
} from "../../runtime/src/adapters/claude/config.js";
import {
  CLAUDE_CAPABILITY_REGISTRATIONS,
  CLAUDE_SUPPORTED_EVENTS,
  claudeNonInteractiveTrust
} from "../../runtime/src/adapters/claude/events.js";
import {
  claudeStopRecursionMarker,
  normalizeClaudeHookInput
} from "../../runtime/src/adapters/claude/input.js";
import { claudeHookOutput } from "../../runtime/src/adapters/claude/output.js";

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
] as const;

async function fixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      resolve("tests", "fixtures", "claude", "settings-existing.json"),
      "utf8"
    )
  ) as unknown;
}

async function denialFixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      resolve(
        "tests",
        "fixtures",
        "harness-denial",
        "claude-pretooluse-deny.json"
      ),
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

test("does not claim a foreign Claude handler merely because it carries the marker", () => {
  const foreignHandler = {
    type: "command",
    command: "foreign-command",
    args: ["audit", "--managed-by=agent-ops"],
    timeout: 30
  };
  const foreignSettings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [foreignHandler]
        }
      ]
    }
  };

  assert.equal(isClaudeManagedHandler(foreignHandler), false);
  assert.deepEqual(stripClaudeManagedHooks(foreignSettings), foreignSettings);
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

test("registers the Claude loop lifecycle through its generated launcher", async () => {
  const managed = buildClaudeHookSettings(
    ["project-loop"],
    "/opt/agent ops/hook-entry.js"
  );
  assert.deepEqual(Object.keys(managed.hooks), LOOP_EVENTS);
  assert.equal(managed.hooks.Stop, undefined);
  for (const event of LOOP_EVENTS) {
    const group = managed.hooks[event]?.[0];
    assert.deepEqual(
      group?.hooks[0],
      {
        type: "command",
        command: "bash",
        args: [
          "${CLAUDE_PROJECT_DIR}/.claude/hooks/agent-ops-loop.sh",
          event,
          "--managed-by=agent-ops"
        ],
        timeout: 30
      },
      event
    );
    assert.equal(
      group?.matcher,
      event === "PreToolUse" || event === "PermissionRequest"
        ? "Bash"
        : undefined,
      event
    );
  }

  const existing = await fixture();
  const merged = mergeClaudeSettings(existing, managed);
  assert.deepEqual(
    merged.hooks.PostToolUse?.[0],
    (existing as typeof merged).hooks.PostToolUse?.[0]
  );
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
});

test("Claude PreToolUse denial shape conformance only matches its fixture", async () => {
  // This asserts the documented wire shape, not host runtime enforcement.
  const output = claudeHookOutput("PreToolUse", {
    action: "block",
    status: "UNKNOWN",
    code: "COMMAND_POLICY_UNAVAILABLE",
    remedy:
      "Fix .agent-ops/config.json, or set AGENT_OPS_DISABLE=1 in your shell to temporarily disable agent-ops."
  });
  assert.deepEqual(JSON.parse(output.stdout), await denialFixture());
});

test("reports Stop evidence without a blocking decision", () => {
  assert.deepEqual(
    claudeHookOutput("Stop", {
      action: "continue",
      status: "PASS",
      code: "STOP_VERIFICATION_FINISHED",
      evidence: {
        commandResults: [{ commandId: "unit", exitCode: 0, testCount: 1 }],
        configHash: "a".repeat(64),
        timestamp: "2026-08-01T00:00:00.000Z"
      }
    }),
    {
      exitCode: 0,
      stdout: JSON.stringify({
        systemMessage: "agent-ops: STOP_VERIFICATION_FINISHED",
        evidence: {
          commandResults: [{ commandId: "unit", exitCode: 0, testCount: 1 }],
          configHash: "a".repeat(64),
          timestamp: "2026-08-01T00:00:00.000Z"
        }
      }),
      stderr: ""
    }
  );
});

test("surfaces non-interactive trust limitations", () => {
  assert.deepEqual(CLAUDE_SUPPORTED_EVENTS, [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SubagentStart",
    "SubagentStop",
    "Stop"
  ]);
  assert.equal(claudeNonInteractiveTrust(false), "interactive-dialog");
  assert.equal(claudeNonInteractiveTrust(true), "dialog-skipped");
  assert.deepEqual(
    CLAUDE_CAPABILITY_REGISTRATIONS.map(({ capability, nativeEvent, surfaceId, support, runtimeFailure }) => ({
      capability,
      nativeEvent,
      surfaceId,
      support,
      runtimeFailure
    })),
    [
      {
        capability: "lifecycle-summary",
        nativeEvent: "SessionStart",
        surfaceId: "claude-settings",
        support: "supported",
        runtimeFailure: "fail-open"
      },
      {
        capability: "command-policy",
        nativeEvent: "PreToolUse",
        surfaceId: "claude-settings",
        support: "supported",
        runtimeFailure: "fail-closed"
      },
      {
        capability: "optional-stop-verify",
        nativeEvent: "Stop",
        surfaceId: "claude-settings",
        support: "supported",
        runtimeFailure: "fail-open"
      }
    ]
  );
});
