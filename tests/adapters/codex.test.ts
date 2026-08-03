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
  CODEX_CAPABILITY_REGISTRATIONS,
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

async function denialFixture(): Promise<unknown> {
  return JSON.parse(
    await readFile(
      resolve(
        "tests",
        "fixtures",
        "harness-denial",
        "codex-pretooluse-continue.json"
      ),
      "utf8"
    )
  ) as unknown;
}

const RUNTIME_PATH = "/opt/agent-ops/hook-entry.js";
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

test("merges only agent-ops groups and preserves unrelated Codex hooks", async () => {
  const existing = await fixture();
  const managed = buildCodexHookConfig(
    ["lifecycle-summary", "command-policy", "optional-stop-verify"],
    RUNTIME_PATH
  );

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
  for (const event of ["PreToolUse", "SessionStart", "Stop"]) {
    assert.match(
      serialized,
      new RegExp(
        `node \\\\"${RUNTIME_PATH}\\\\" codex ${event} --managed-by=agent-ops`
      ),
      event
    );
  }
});

test("uses one hooks.json representation and an absolute runtime path", () => {
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

  const expected =
    `node "${RUNTIME_PATH}" codex PreToolUse --managed-by=agent-ops`;
  const config = buildCodexHookConfig(["command-policy"], RUNTIME_PATH);
  const hook = config.hooks.PreToolUse?.[0]?.hooks[0];
  assert.equal(hook?.command, expected);
  // The command is one shell string, so the path stays quoted and PATH is
  // never consulted for the agent-ops binary.
  assert.equal(hook?.commandWindows, expected);
});

test("registers the Codex loop lifecycle through its generated launcher", async () => {
  const managed = buildCodexHookConfig(["project-loop"], RUNTIME_PATH);
  assert.deepEqual(Object.keys(managed.hooks), LOOP_EVENTS);
  assert.equal(managed.hooks.Stop, undefined);
  for (const event of LOOP_EVENTS) {
    const group = managed.hooks[event]?.[0];
    const handler = group?.hooks[0];
    assert.equal(
      handler?.command,
      `bash "$(git rev-parse --show-toplevel)/.codex/hooks/agent-ops-loop.sh" ${event} --managed-by=agent-ops`,
      event
    );
    assert.equal(
      group?.matcher,
      event === "PreToolUse" || event === "PermissionRequest"
        ? "^Bash$"
        : undefined,
      event
    );
  }

  const existing = await fixture();
  const merged = mergeCodexHookConfig(existing, managed);
  assert.deepEqual(
    merged.hooks.PostToolUse?.[0],
    (existing as typeof merged).hooks.PostToolUse?.[0]
  );
});

test("rejects runtime paths that break the quoted command", () => {
  for (const invalid of ["", '/opt/a"b/hook.js', "/opt/a\0b/hook.js"]) {
    assert.throws(
      () => buildCodexHookConfig(["command-policy"], invalid),
      /Codex hook runtime path is invalid/,
      JSON.stringify(invalid)
    );
  }
});

test("still recognizes the pre-0.1.5 PATH-resolved handler as owned", () => {
  const legacy = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            { type: "command", command: "agent-ops hook codex SessionStart" }
          ]
        }
      ]
    }
  };
  const merged = mergeCodexHookConfig(
    legacy,
    buildCodexHookConfig(["lifecycle-summary"], RUNTIME_PATH)
  );
  assert.equal(merged.hooks.SessionStart?.length, 1);
  assert.doesNotMatch(
    JSON.stringify(merged),
    /"command":"agent-ops hook codex SessionStart"/
  );
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
  assert.deepEqual(
    codexHookOutput("Stop", {
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
        continue: true,
        systemMessage: "agent-ops: STOP_VERIFICATION_FINISHED",
        evidence: {
          commandResults: [{ commandId: "unit", exitCode: 0, testCount: 1 }],
          configHash: "a".repeat(64),
          timestamp: "2026-08-01T00:00:00.000Z"
        }
      })
    }
  );
  assert.equal(CODEX_NON_ZERO_EXIT_BEHAVIOR, "UNKNOWN");
  assert.equal(CODEX_PRE_TOOL_BLOCKING, "UNKNOWN");
});

test("Codex PreToolUse non-denial shape conformance only matches its fixture", async () => {
  // This asserts the documented wire shape, not host runtime enforcement.
  const output = codexHookOutput("PreToolUse", {
    action: "continue",
    status: "UNKNOWN",
    code: "COMMAND_POLICY_UNAVAILABLE"
  });
  assert.deepEqual(JSON.parse(output.stdout), await denialFixture());
  assert.doesNotMatch(output.stdout, /deny/);
});

test("declares only documented event and matcher support", () => {
  assert.deepEqual(CODEX_SUPPORTED_EVENTS, [
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
  assert.equal(codexMatcherSupport("PreToolUse"), "tool-name");
  assert.equal(codexMatcherSupport("Stop"), "unsupported");
  assert.equal(codexMatcherSupport("UserPromptSubmit"), "unsupported");
  assert.deepEqual(
    CODEX_CAPABILITY_REGISTRATIONS.map(({ capability, nativeEvent, surfaceId, support, runtimeFailure }) => ({
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
        surfaceId: "codex-hooks",
        support: "supported",
        runtimeFailure: "fail-open"
      },
      {
        capability: "command-policy",
        nativeEvent: "PreToolUse",
        surfaceId: "codex-hooks",
        support: "unknown",
        runtimeFailure: "native-unknown"
      },
      {
        capability: "optional-stop-verify",
        nativeEvent: "Stop",
        surfaceId: "codex-hooks",
        support: "unsupported",
        runtimeFailure: "fail-open"
      }
    ]
  );
});
