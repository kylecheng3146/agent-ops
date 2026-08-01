import assert from "node:assert/strict";
import test from "node:test";

import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { runHookCommand } from "../../packages/cli/src/commands/hook.js";
import {
  HARNESS_IDS,
  harnessDescriptor
} from "../../runtime/src/install/harness.js";

function config(
  profiles: AgentOpsConfig["profiles"],
  stopEnabled = false
): AgentOpsConfig {
  return {
    schemaVersion: 2,
    profiles,
    verification: {
      commands: stopEnabled
        ? [
            {
              id: "unit",
              command: "unit-tool",
              args: [],
              cwd: ".",
              required: true,
              evidence: { kind: "test-count", minimum: 1 }
            }
          ]
        : []
    },
    features: {
      stopVerification: { enabled: stopEnabled }
    },
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

test("every supported registration is reachable through the real hook command", async () => {
  for (const harness of HARNESS_IDS) {
    const descriptor = harnessDescriptor(harness);
    for (const registration of descriptor.control.registrations) {
      if (registration.support !== "supported") {
        continue;
      }
      const lifecycle = registration.normalizedEvent === "session-start";
      const stopping = registration.normalizedEvent === "stop";
      let advisoryCalls = 0;
      const stdin = lifecycle
        ? harness === "claude"
          ? JSON.stringify({ hook_event_name: "SessionStart", cwd: "/repo" })
          : harness === "codex"
            ? JSON.stringify({ hook_event_name: "SessionStart", cwd: "/repo" })
            : JSON.stringify({ event: "SessionStart", projectRoot: "/repo" })
        : stopping
          ? JSON.stringify({ hook_event_name: "Stop", cwd: "/repo" })
        : harness === "claude"
          ? JSON.stringify({
              hook_event_name: "PreToolUse",
              cwd: "/repo",
              tool_name: "Bash",
              tool_input: { command: "git push --force origin main" }
            })
          : JSON.stringify({
              event: "PreToolUse",
              projectRoot: "/repo",
              input: { tool: "bash" },
              output: { args: { command: "git push --force origin main" } }
            });
      const output = await runHookCommand({
        harness,
        event: registration.nativeEvent,
        stdin,
        config: config(
          lifecycle ? ["advisory"] : ["core", "guardrails"],
          stopping
        ),
        trusted: true,
        ...(lifecycle
          ? {
              advisory: async () => {
                advisoryCalls += 1;
              }
            }
          : {}),
        ...(stopping
          ? {
              stopVerification: {
                confirmedConfig: true,
                trusted: true,
                scopeMapped: true,
                recursionMarker: false,
                configHash: "a".repeat(64),
                verify: async () => ({
                  status: "PASS" as const,
                  results: [
                    { commandId: "unit", exitCode: 0, testCount: 1 }
                  ]
                })
              }
            }
          : {})
      });
      assert.doesNotMatch(
        output.stdout,
        /HOOK_NOOP|UNAVAILABLE/,
        `${harness}:${registration.capability}`
      );
      if (lifecycle) {
        assert.equal(advisoryCalls, 1, `${harness}:${registration.capability}`);
        assert.deepEqual(
          output,
          { exitCode: 0, stdout: "", stderr: "" },
          `${harness}:${registration.capability}`
        );
      } else if (stopping) {
        assert.match(
          output.stdout,
          /STOP_VERIFICATION_FINISHED/,
          `${harness}:${registration.capability}`
        );
      } else {
        assert.match(output.stdout, /deny/, `${harness}:${registration.capability}`);
      }
    }
  }
});

test("advisory failure stays fail-open for every harness protocol", async () => {
  for (const harness of HARNESS_IDS) {
    const stdin =
      harness === "opencode"
        ? JSON.stringify({ event: "SessionStart", projectRoot: "/repo" })
        : JSON.stringify({ hook_event_name: "SessionStart", cwd: "/repo" });
    const output = await runHookCommand({
      harness,
      event: "SessionStart",
      stdin,
      config: config(["advisory"]),
      trusted: true,
      advisory: async () => {
        throw new Error("advisory unavailable");
      }
    });

    assert.equal(output.exitCode, 0);
    assert.match(output.stdout, /ADVISORY_FAILED/);
  }
});
