import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildAgyHookSettings,
  isAgyHookRegistered,
  mergeAgyHooks,
  stripAgyHooks
} from "../../runtime/src/adapters/agy/config.js";
import { normalizeAgyHookInput } from "../../runtime/src/adapters/agy/input.js";
import { agyHookOutput } from "../../runtime/src/adapters/agy/output.js";

test("agy installs its supported loop subset under one owned hook name", () => {
  const managed = buildAgyHookSettings(["project-loop"], "/opt/agent ops/hook-entry.js");
  assert.deepEqual(Object.keys(managed.hooks), ["PreInvocation", "PreToolUse"]);
  const merged = mergeAgyHooks({ foreign: { enabled: true } }, managed);
  assert.deepEqual(merged.foreign, { enabled: true });
  assert.equal(isAgyHookRegistered(merged, ["project-loop"]), true);
  assert.deepEqual(stripAgyHooks(merged), { foreign: { enabled: true } });
});

test("agy uses cmd /c for Windows hook commands", () => {
  const managed = buildAgyHookSettings(
    ["command-policy"],
    "C:\\Program Files\\agent-ops\\hook-entry.js",
    "win32"
  );
  const hook = (managed.hooks.PreToolUse?.[0] as {
    hooks: readonly [{ command: string }];
  }).hooks[0];
  assert.match(hook.command, /^cmd \/c node "C:\\Program Files\\agent-ops\\hook-entry\.js"/u);
  assert.equal(isAgyHookRegistered(mergeAgyHooks({}, managed), ["command-policy"]), true);
});

test("agy recognizes the Windows fixture as managed", () => {
  const fixture = JSON.parse(
    readFileSync(resolve("tests/fixtures/agy/hooks-windows.json"), "utf8")
  ) as unknown;
  assert.equal(isAgyHookRegistered(fixture, ["command-policy"]), true);
});

test("agy rejects a foreign hook using the reserved agent-ops name", () => {
  assert.throws(
    () => mergeAgyHooks({ "agent-ops": { PreInvocation: [] } }, { hooks: {} }),
    /Refusing to replace/u
  );
});

test("agy rejects disabled, tampered, and mixed owned hook entries", () => {
  const managed = mergeAgyHooks({}, buildAgyHookSettings(
    ["lifecycle-summary", "command-policy"],
    "/opt/hook-entry.js"
  ));
  const owned = managed["agent-ops"] as Record<string, unknown>;
  for (const changed of [
    { ...owned, enabled: false },
    { ...owned, PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "echo bypass", timeout: 30 }] }] },
    { ...owned, ForeignEvent: [] }
  ]) {
    const source = { "agent-ops": changed };
    assert.equal(isAgyHookRegistered(source, ["command-policy"]), false);
    assert.throws(() => mergeAgyHooks(source, { hooks: {} }), /Refusing to replace/u);
    assert.throws(() => stripAgyHooks(source), /not owned/u);
  }
});

test("agy normalizes camelCase run_command input and emits native denial", () => {
  assert.deepEqual(
    normalizeAgyHookInput({
      workspacePaths: ["/repo"],
      toolCall: { name: "run_command", args: { CommandLine: "git reset --hard" } }
    }),
    {
      event: "command",
      projectRoot: "/repo",
      command: "git",
      args: ["reset", "--hard"],
      scope: "/repo"
    }
  );
  assert.deepEqual(
    JSON.parse(agyHookOutput("PreToolUse", {
      action: "continue", status: "PASS", code: "OK"
    }).stdout),
    { decision: "allow" }
  );
  assert.deepEqual(
    JSON.parse(agyHookOutput("PreToolUse", {
      action: "block", status: "FAIL", code: "COMMAND_DENIED"
    }).stdout),
    { decision: "deny", reason: "agent-ops: COMMAND_DENIED" }
  );
});

test("agy Stop verification is report-only", () => {
  assert.deepEqual(
    JSON.parse(agyHookOutput("Stop", {
      action: "continue", status: "PASS", code: "OK"
    }).stdout),
    { decision: "allow" }
  );
  assert.deepEqual(
    JSON.parse(agyHookOutput("Stop", {
      action: "block", status: "FAIL", code: "VERIFY_FAILED"
    }).stdout),
    { decision: "allow", reason: "agent-ops: VERIFY_FAILED" }
  );
});

test("agy uses native force_ask and Stop continuation for the completion gate", () => {
  const completionHooks = mergeAgyHooks({}, buildAgyHookSettings(
    ["project-loop", "completion-gate"],
    "/opt/hook-entry.js"
  ));
  assert.equal(isAgyHookRegistered(completionHooks, ["project-loop", "completion-gate"]), true);
  assert.equal(isAgyHookRegistered(
    mergeAgyHooks({}, buildAgyHookSettings(["project-loop", "optional-stop-verify"], "/opt/hook-entry.js")),
    ["project-loop", "completion-gate"]
  ), false);
  assert.deepEqual(JSON.parse(agyHookOutput("PreToolUse", {
    action: "block",
    status: "UNKNOWN",
    code: "COMPLETION_GATE_PERMIT_CONFIRMATION"
  }).stdout), {
    decision: "force_ask",
    reason: "agent-ops: COMPLETION_GATE_PERMIT_CONFIRMATION"
  });
  assert.deepEqual(JSON.parse(agyHookOutput("Stop", {
    action: "block",
    status: "FAIL",
    code: "COMPLETION_GATE_TASK_REQUIRED"
  }).stdout), {
    decision: "continue",
    reason: "agent-ops: COMPLETION_GATE_TASK_REQUIRED"
  });
});
