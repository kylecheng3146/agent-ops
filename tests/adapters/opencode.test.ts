import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpencodePlugin,
  opencodePluginEvents,
  opencodePluginTarget,
  isOpencodeManagedPlugin
} from "../../runtime/src/adapters/opencode/config.js";
import {
  OPENCODE_CAPABILITY_REGISTRATIONS,
  OPENCODE_PLUGIN_HOOKS,
  OPENCODE_SESSION_START_FIDELITY,
  OPENCODE_SUPPORTED_EVENTS
} from "../../runtime/src/adapters/opencode/events.js";
import { normalizeOpencodeHookInput } from "../../runtime/src/adapters/opencode/input.js";
import { opencodeHookOutput } from "../../runtime/src/adapters/opencode/output.js";

const RUNTIME_PATH = "/opt/agent-ops/hook-entry.js";

test("normalizes opencode lifecycle and bash tool inputs", () => {
  assert.deepEqual(
    normalizeOpencodeHookInput({
      event: "SessionStart",
      projectRoot: "/repo"
    }),
    { event: "session-start", projectRoot: "/repo" }
  );
  assert.deepEqual(
    normalizeOpencodeHookInput({
      event: "PreToolUse",
      projectRoot: "/repo",
      input: {
        tool: "bash"
      },
      output: {
        args: { command: "git push --force origin main" }
      }
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
    normalizeOpencodeHookInput({
      event: "PreToolUse",
      projectRoot: "/repo",
      input: { tool: "read", args: { filePath: ".env" } }
    }),
    { event: "unsupported", projectRoot: "/repo" }
  );
  assert.deepEqual(
    normalizeOpencodeHookInput({ event: "Stop", projectRoot: "/repo" }),
    { event: "stop", projectRoot: "/repo" }
  );
  assert.deepEqual(
    normalizeOpencodeHookInput({ event: "other", projectRoot: "/repo" }),
    { event: "unsupported", projectRoot: "/repo" }
  );
});

test("declares opencode hooks and generates a managed plugin source", () => {
  assert.deepEqual(OPENCODE_SUPPORTED_EVENTS, [
    "SessionStart",
    "PreToolUse",
    "Stop"
  ]);
  assert.deepEqual(OPENCODE_PLUGIN_HOOKS, {
    SessionStart: "plugin-init",
    PreToolUse: "tool.execute.before",
    Stop: "event:session.idle"
  });
  assert.equal(OPENCODE_SESSION_START_FIDELITY, "app-init");
  assert.deepEqual(
    OPENCODE_CAPABILITY_REGISTRATIONS.map(({ capability, nativeEvent, surfaceId, support, runtimeFailure }) => ({
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
        surfaceId: "opencode-plugin",
        support: "unsupported",
        runtimeFailure: "fail-open"
      },
      {
        capability: "command-policy",
        nativeEvent: "PreToolUse",
        surfaceId: "opencode-plugin",
        support: "supported",
        runtimeFailure: "fail-closed"
      },
      {
        capability: "optional-stop-verify",
        nativeEvent: "Stop",
        surfaceId: "opencode-plugin",
        support: "unsupported",
        runtimeFailure: "fail-open"
      }
    ]
  );
  assert.deepEqual(
    opencodePluginTarget("project"),
    {
      path: ".opencode/plugins/agent-ops.js",
      representation: "javascript",
      requiresProjectTrust: true
    }
  );
  assert.deepEqual(
    opencodePluginTarget("user", "/tmp/agent-ops-home"),
    {
      path: ".config/opencode/plugins/agent-ops.js",
      representation: "javascript",
      requiresProjectTrust: false
    }
  );
  assert.deepEqual(
    opencodePluginTarget(
      "user",
      "/tmp/agent-ops-home",
      "/tmp/agent-ops-home/xdg-config"
    ),
    {
      path: "xdg-config/opencode/plugins/agent-ops.js",
      representation: "javascript",
      requiresProjectTrust: false
    }
  );
  assert.deepEqual(
    opencodePluginTarget(
      "user",
      "/tmp/agent-ops-home",
      "/tmp/agent-ops-home/ignored-xdg",
      "/tmp/agent-ops-home/custom-opencode"
    ),
    {
      path: "custom-opencode/plugins/agent-ops.js",
      representation: "javascript",
      requiresProjectTrust: false
    }
  );
  assert.deepEqual(
    opencodePluginEvents([
      "lifecycle-summary",
      "command-policy",
      "optional-stop-verify"
    ]),
    ["SessionStart", "PreToolUse", "Stop"]
  );

  const source = buildOpencodePlugin(
    ["lifecycle-summary", "command-policy", "optional-stop-verify"],
    RUNTIME_PATH
  );
  assert.equal(typeof source, "string");
  assert.ok(source !== null);
  assert.match(source, /export const AgentOps/);
  assert.match(source, /tool\.execute\.before/);
  assert.match(source, /session\.idle/);
  assert.match(source, /node/);
  assert.match(source, /opencode/);
  assert.match(source, /--managed-by=agent-ops/);
  assert.match(source, /\$/);
  assert.equal(isOpencodeManagedPlugin(source), true);
  assert.equal(
    buildOpencodePlugin(["rules"], RUNTIME_PATH),
    null
  );
  assert.equal(
    buildOpencodePlugin(["rules"], "relative/hook-entry.js"),
    null
  );
});

test("emits a deny decision only for a blocked bash hook", () => {
  assert.deepEqual(
    JSON.parse(
      opencodeHookOutput("PreToolUse", {
        action: "block",
        status: "FAIL",
        code: "destructive-force-push"
      }).stdout
    ),
    { decision: "deny", reason: "destructive-force-push" }
  );
  assert.deepEqual(
    JSON.parse(
      opencodeHookOutput("Stop", {
        action: "continue",
        status: "UNKNOWN",
        code: "STOP_VERIFICATION_UNAVAILABLE"
      }).stdout
    ),
    { decision: "allow", reason: "STOP_VERIFICATION_UNAVAILABLE" }
  );
});
