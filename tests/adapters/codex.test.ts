import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildCodexHookConfig,
  codexHookTarget,
  mergeCodexHookConfig
} from "../../runtime/src/adapters/codex/config.js";
import {
  CODEX_SUPPORTED_EVENTS,
  codexMatcherSupport
} from "../../runtime/src/adapters/codex/events.js";
import { normalizeCodexHookInput } from "../../runtime/src/adapters/codex/input.js";
import {
  CODEX_PRE_TOOL_BLOCKING,
  CODEX_NON_ZERO_EXIT_BEHAVIOR,
  codexHookOutput
} from "../../runtime/src/adapters/codex/output.js";

async function fixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      resolve("tests", "fixtures", "codex", "hooks-existing.json"),
      "utf8"
    )
  ) as unknown;
}

test("merges only agent-ops groups and preserves unrelated Codex hooks", async () => {
  const existing = await fixture();
  const managed = buildCodexHookConfig([
    "lifecycle-summary",
    "command-policy",
    "optional-stop-verify"
  ]);

  const merged = mergeCodexHookConfig(existing, managed);

  assert.equal(merged.description, "User-authored Codex hooks.");
  assert.deepEqual(
    merged.hooks.PostToolUse,
    (existing as typeof merged).hooks.PostToolUse
  );
  const serialized = JSON.stringify(merged);
  assert.match(serialized, /user-policy check/);
  assert.match(serialized, /mixed-user-policy check/);
  assert.match(serialized, /user-audit append/);
  assert.doesNotMatch(serialized, /agent-ops hook codex legacy/);
  assert.match(serialized, /agent-ops hook codex PreToolUse/);
  assert.match(serialized, /agent-ops hook codex SessionStart/);
  assert.match(serialized, /agent-ops hook codex Stop/);
});

test("uses one hooks.json representation and portable commands per layer", () => {
  assert.deepEqual(codexHookTarget("project"), {
    path: ".codex/hooks.json",
    representation: "json",
    requiresProjectTrust: true
  });
  assert.deepEqual(codexHookTarget("user"), {
    path: ".codex/hooks.json",
    representation: "json",
    requiresProjectTrust: false
  });

  const serialized = JSON.stringify(
    buildCodexHookConfig(["command-policy"])
  );
  assert.match(serialized, /agent-ops hook codex PreToolUse/);
  assert.doesNotMatch(serialized, /(?:\/Users\/|\/home\/|~\/|\.cmd\b)/);
  assert.match(serialized, /"commandWindows":"agent-ops hook codex PreToolUse"/);
});

test("normalizes only documented Codex common fields", () => {
  assert.deepEqual(
    normalizeCodexHookInput({
      hook_event_name: "SessionStart",
      cwd: "/repo",
      session_id: "session-secret",
      transcript_path: "/private/transcript.jsonl",
      model: "current-model",
      source: "resume",
      unknown: "drop-me"
    }),
    {
      event: "session-start",
      projectRoot: "/repo"
    }
  );
  assert.deepEqual(
    normalizeCodexHookInput({
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
    normalizeCodexHookInput({
      hook_event_name: "PreToolUse",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: {
        command: "git push --force origin main"
      },
      transcript_path: "/private/transcript.jsonl"
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
    normalizeCodexHookInput({
      hook_event_name: "Stop",
      cwd: "/repo",
      stop_hook_active: true
    }),
    {
      event: "stop",
      projectRoot: "/repo"
    }
  );
});

test("encodes only documented Codex output behavior", () => {
  assert.deepEqual(
    codexHookOutput("SessionStart", {
      action: "continue",
      status: "PASS",
      code: "HOOK_NOOP"
    }),
    { exitCode: 0, stdout: "" }
  );
  assert.deepEqual(
    codexHookOutput("Stop", {
      action: "block",
      status: "FAIL",
      code: "STOP_FAILED"
    }),
    {
      exitCode: 0,
      stdout: JSON.stringify({
        continue: false,
        stopReason: "STOP_FAILED"
      })
    }
  );
  assert.equal(CODEX_NON_ZERO_EXIT_BEHAVIOR, "UNKNOWN");
  assert.equal(CODEX_PRE_TOOL_BLOCKING, "UNKNOWN");
});

test("declares only documented event and matcher support", () => {
  assert.deepEqual(CODEX_SUPPORTED_EVENTS, [
    "SessionStart",
    "PreToolUse",
    "Stop"
  ]);
  assert.equal(codexMatcherSupport("PreToolUse"), "tool-name");
  assert.equal(codexMatcherSupport("Stop"), "unsupported");
  assert.equal(codexMatcherSupport("UserPromptSubmit"), "unsupported");
});
