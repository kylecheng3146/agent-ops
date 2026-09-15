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
    "/opt/agent ops/hook-entry.js",
    "linux"
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

test("registers the Claude loop through PowerShell on Windows", () => {
  const managed = buildClaudeHookSettings(
    ["project-loop"],
    "C:\\Program Files\\agent-ops\\hook-entry.js",
    "win32"
  );
  for (const event of LOOP_EVENTS) {
    const group = managed.hooks[event]?.[0];
    assert.deepEqual(
      group?.hooks[0],
      {
        type: "command",
        shell: "powershell",
        command:
          `& "${"${CLAUDE_PROJECT_DIR}"}/.claude/hooks/agent-ops-loop.ps1" ` +
          `"${event}" "--managed-by=agent-ops"`,
        timeout: 30
      },
      event
    );
  }
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
  // The gate keys its baseline on the session and reads Claude's recursion
  // marker as "not yet idle", which is the case it lets through.
  assert.deepEqual(
    normalizeClaudeHookInput({
      hook_event_name: "Stop",
      cwd: "/repo",
      session_id: "session-7",
      stop_hook_active: true
    }),
    {
      event: "stop",
      projectRoot: "/repo",
      sessionId: "session-7",
      terminationReason: "model_stop",
      fullyIdle: false
    }
  );
  assert.deepEqual(
    normalizeClaudeHookInput({
      hook_event_name: "Stop",
      cwd: "/repo",
      session_id: "session-7"
    }),
    {
      event: "stop",
      projectRoot: "/repo",
      sessionId: "session-7",
      terminationReason: "model_stop",
      fullyIdle: true
    }
  );
  assert.deepEqual(
    normalizeClaudeHookInput({
      hook_event_name: "SessionStart",
      cwd: "/repo",
      session_id: "session-7"
    }),
    {
      event: "session-start",
      projectRoot: "/repo",
      sessionId: "session-7"
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
      },
      {
        capability: "completion-gate",
        nativeEvent: "Stop",
        surfaceId: "claude-settings",
        support: "supported",
        runtimeFailure: "fail-closed"
      }
    ]
  );
});

test("blocks the Stop event when verification reports FAIL", () => {
  const parsed = JSON.parse(
    claudeHookOutput("Stop", {
      action: "continue",
      status: "FAIL",
      code: "STOP_VERIFICATION_FINISHED",
      evidence: {
        commandResults: [
          { commandId: "unit", exitCode: 0, testCount: 12 },
          { commandId: "independent-review", exitCode: 1, testCount: null }
        ],
        configHash: "a".repeat(64),
        timestamp: "2026-08-01T00:00:00.000Z"
      }
    }).stdout
  ) as {
    readonly decision: string;
    readonly reason: string;
    readonly evidence: unknown;
  };
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /independent-review/u);
  assert.match(parsed.reason, /agent-ops review/u);
  assert.equal(parsed.reason.includes("unit"), false);
});

test("the completion gate installs a gated Claude Stop hook", () => {
  const gated = buildClaudeHookSettings(
    ["lifecycle-summary", "completion-gate"],
    "/opt/agent-ops/hook-entry.js"
  );
  const handler = gated.hooks.Stop?.[0]?.hooks[0];

  assert.deepEqual(handler, {
    type: "command",
    command: "node",
    args: [
      "/opt/agent-ops/hook-entry.js",
      "claude",
      "Stop",
      "--managed-by=agent-ops",
      "--completion-gate"
    ],
    timeout: 30
  });
  // The flag trails the marker: the marker's position is what identifies a
  // managed handler, so moving it would orphan every existing installation.
  assert.equal(isClaudeManagedHandler(handler), true);

  // One managed Stop handler, not two: the gate already reports everything
  // report-only Stop verification would.
  const both = buildClaudeHookSettings(
    ["completion-gate", "optional-stop-verify"],
    "/opt/agent-ops/hook-entry.js"
  );
  assert.equal(both.hooks.Stop?.length, 1);
  assert.ok(
    (both.hooks.Stop?.[0]?.hooks[0].args ?? []).includes("--completion-gate")
  );

  // Without the capability nothing changes for an existing installation.
  const ungated = buildClaudeHookSettings(
    ["optional-stop-verify"],
    "/opt/agent-ops/hook-entry.js"
  );
  assert.ok(
    !(ungated.hooks.Stop?.[0]?.hooks[0].args ?? []).includes("--completion-gate")
  );
});

test("a gate refusal blocks the Claude stop and its permit is only ever asked", () => {
  const blocked = claudeHookOutput("Stop", {
    action: "block",
    status: "FAIL",
    code: "COMPLETION_GATE_TASK_INCOMPLETE",
    remedy: "Complete the attached task before stopping."
  });
  const decision = JSON.parse(blocked.stdout) as Record<string, unknown>;
  assert.equal(decision.decision, "block");
  assert.match(String(decision.reason), /COMPLETION_GATE_TASK_INCOMPLETE/u);
  assert.match(String(decision.reason), /Complete the attached task/u);

  const permit = claudeHookOutput("PreToolUse", {
    action: "block",
    status: "UNKNOWN",
    code: "COMPLETION_GATE_PERMIT_CONFIRMATION",
    remedy: "A one-time Stop permit needs your approval."
  });
  const specific = (JSON.parse(permit.stdout) as {
    hookSpecificOutput: Record<string, unknown>;
  }).hookSpecificOutput;
  // Asked, never denied and never allowed: an agent that could answer this
  // for itself would hold the key to its own gate.
  assert.equal(specific.permissionDecision, "ask");
  assert.match(
    String(specific.permissionDecisionReason),
    /COMPLETION_GATE_PERMIT_CONFIRMATION/u
  );
});

test("the managed-handler matcher rejects node handlers that are not ours", () => {
  const node = (args: readonly string[]): unknown => ({
    type: "command",
    command: "node",
    args: [...args],
    timeout: 30
  });

  // The marker is a plain string anyone may write. A handler mistaken for ours
  // is one `update` rewrites and `uninstall` deletes.
  for (const args of [
    // Someone else's harness, our marker.
    ["/other/tool.js", "codex", "Stop", "--managed-by=agent-ops"],
    // The marker in the wrong position.
    ["/opt/hook.js", "claude", "--managed-by=agent-ops", "Stop"],
    // Too few and too many arguments.
    ["/opt/hook.js", "claude", "--managed-by=agent-ops"],
    ["/opt/hook.js", "claude", "Stop", "--managed-by=agent-ops", "--completion-gate", "--extra"],
    // A trailing flag we never write.
    ["/opt/hook.js", "claude", "Stop", "--managed-by=agent-ops", "--dangerous"],
    // No runtime path at all.
    ["", "claude", "Stop", "--managed-by=agent-ops"]
  ]) {
    assert.equal(isClaudeManagedHandler(node(args)), false, args.join(" "));
  }

  // A handler an older agent-ops wrote for an event this version no longer
  // knows is still ours to remove; rejecting it would orphan it forever.
  assert.equal(
    isClaudeManagedHandler(node(["/old/hook.js", "claude", "legacy", "--managed-by=agent-ops"])),
    true
  );
});

test("a gated loop install reaches the gate on SessionStart and PreToolUse", () => {
  // Platform pinned: the loop launcher is bash on POSIX and PowerShell on
  // Windows, and this test is about the gate's own handler sitting beside it.
  const gated = buildClaudeHookSettings(
    ["project-loop", "completion-gate"],
    "/opt/agent-ops/hook-entry.js",
    "linux"
  );
  const groups = gated.hooks.PreToolUse ?? [];

  // The loop launcher runs a different process, and the gate does not live
  // there: without its own handler, `allow-stop` would never reach the user.
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.hooks[0]?.command, "bash");
  assert.deepEqual(groups[1]?.hooks[0]?.args, [
    "/opt/agent-ops/hook-entry.js",
    "claude",
    "PreToolUse",
    "--managed-by=agent-ops"
  ]);
  assert.equal(groups[1]?.matcher, "Bash");

  // SessionStart for the same reason: the gate records its baseline there, and
  // without one every stop is refused as uninitialized.
  const startGroups = gated.hooks.SessionStart ?? [];
  assert.equal(startGroups.length, 2);
  assert.equal(startGroups[0]?.hooks[0]?.command, "bash");
  assert.deepEqual(startGroups[1]?.hooks[0]?.args, [
    "/opt/agent-ops/hook-entry.js",
    "claude",
    "SessionStart",
    "--managed-by=agent-ops"
  ]);

  // An ungated loop install is untouched.
  const ungated = buildClaudeHookSettings(
    ["project-loop"],
    "/opt/agent-ops/hook-entry.js",
    "linux"
  );
  assert.equal((ungated.hooks.PreToolUse ?? []).length, 1);
  assert.equal((ungated.hooks.SessionStart ?? []).length, 1);

  // The same on Windows, where the loop launcher is a PowerShell command.
  const windows = buildClaudeHookSettings(
    ["project-loop", "completion-gate"],
    "/opt/agent-ops/hook-entry.js",
    "win32"
  );
  const windowsGroups = windows.hooks.PreToolUse ?? [];
  assert.equal(windowsGroups.length, 2);
  assert.equal(windowsGroups[0]?.hooks[0]?.shell, "powershell");
  assert.equal(windowsGroups[1]?.hooks[0]?.command, "node");
});
