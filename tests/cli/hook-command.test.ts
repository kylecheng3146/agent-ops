import assert from "node:assert/strict";
import test from "node:test";

import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { runHookCommand } from "../../packages/cli/src/commands/hook.js";

function config(profiles: AgentOpsConfig["profiles"]): AgentOpsConfig {
  return {
    schemaVersion: 1,
    profiles,
    verification: { commands: [] },
    pathMappings: [],
    securityExceptions: []
  };
}

test("guardrail profiles block a destructive shell command", async () => {
  const output = await runHookCommand({
    harness: "claude",
    event: "PreToolUse",
    stdin: JSON.stringify({
      hook_event_name: "PreToolUse",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "git reset --hard origin/main" }
    }),
    config: config(["core", "guardrails"]),
    trusted: true
  });
  assert.equal(output.exitCode, 0);
  const decision = JSON.parse(output.stdout) as {
    hookSpecificOutput?: { permissionDecision?: string };
  };
  assert.equal(
    decision.hookSpecificOutput?.permissionDecision,
    "deny"
  );
});

test("core-only profiles never block", async () => {
  const output = await runHookCommand({
    harness: "claude",
    event: "PreToolUse",
    stdin: JSON.stringify({
      hook_event_name: "PreToolUse",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "git reset --hard origin/main" }
    }),
    config: config(["core"]),
    trusted: true
  });
  assert.deepEqual(output, { exitCode: 0, stdout: "", stderr: "" });
});

test("malformed input and unknown events stay fail-open", async () => {
  assert.deepEqual(
    await runHookCommand({
      harness: "codex",
      event: "SessionStart",
      stdin: "{not json",
      config: config(["core", "advisory"]),
      trusted: false
    }),
    { exitCode: 0, stdout: "", stderr: "" }
  );

  const unsupported = await runHookCommand({
    harness: "codex",
    event: "SessionStart",
    stdin: JSON.stringify({
      hook_event_name: "Unknown",
      cwd: "/repo"
    }),
    config: config(["core", "advisory"]),
    trusted: false
  });
  assert.equal(unsupported.exitCode, 0);
  assert.equal(
    JSON.parse(unsupported.stdout).continue,
    true
  );
});

test("an empty profile list cannot crash the hook", async () => {
  assert.deepEqual(
    await runHookCommand({
      harness: "claude",
      event: "Stop",
      stdin: JSON.stringify({ hook_event_name: "Stop", cwd: "/repo" }),
      config: config([]),
      trusted: false
    }),
    { exitCode: 0, stdout: "", stderr: "" }
  );
});
