import assert from "node:assert/strict";
import test from "node:test";

import { dispatchHookEvent } from "../../runtime/src/hooks/dispatch.js";
import { runHookEntry } from "../../runtime/src/hooks/hook-entry.js";
import { normalizeHookEvent } from "../../runtime/src/hooks/normalize.js";
import { encodeHookOutput } from "../../runtime/src/hooks/output.js";

test("normalizes only fields used by hook policy", () => {
  assert.deepEqual(
    normalizeHookEvent({
      event: "command",
      projectRoot: "/repo",
      command: "git",
      args: ["push", "--force"],
      scope: "packages/cli",
      transcript: "must not survive",
      unknown: { token: "must not survive" }
    }),
    {
      event: "command",
      projectRoot: "/repo",
      command: "git",
      args: ["push", "--force"],
      scope: "packages/cli"
    }
  );
});

test("advisory failures fail open", async () => {
  const result = await dispatchHookEvent(
    {
      event: "session-start",
      projectRoot: "/repo"
    },
    {
      capabilities: ["lifecycle-summary"],
      trusted: true,
      advisory: async () => {
        throw new Error("synthetic advisory failure");
      }
    }
  );

  assert.deepEqual(result, {
    action: "continue",
    status: "UNKNOWN",
    code: "ADVISORY_FAILED"
  });
});

test("high-confidence command guardrails block", async () => {
  const result = await dispatchHookEvent(
    {
      event: "command",
      projectRoot: "/repo",
      command: "git",
      args: ["push", "--force", "origin", "main"],
      scope: "packages/cli"
    },
    {
      capabilities: ["command-policy"],
      trusted: true
    }
  );

  assert.equal(result.action, "block");
  assert.equal(result.status, "FAIL");
  assert.equal(result.code, "destructive-force-push");
});

test("high-confidence commands in a shell batch block", async () => {
  const result = await dispatchHookEvent(
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
    },
    {
      capabilities: ["command-policy"],
      trusted: true
    }
  );

  assert.equal(result.action, "block");
  assert.equal(result.code, "destructive-force-push");
});

test("outer repository trust gates Stop verification", async () => {
  let calls = 0;
  const result = await dispatchHookEvent(
    {
      event: "stop",
      projectRoot: "/repo"
    },
    {
      capabilities: ["optional-stop-verify"],
      trusted: false,
      stopVerification: {
        confirmedConfig: true,
        trusted: true,
        scopeMapped: true,
        recursionMarker: false,
        configHash: "a".repeat(64),
        verify: async () => {
          calls += 1;
          return {
            status: "PASS",
            results: [
              { commandId: "unit", exitCode: 0, testCount: 1 }
            ]
          };
        }
      }
    }
  );

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.code, "STOP_VERIFICATION_UNTRUSTED");
  assert.equal(calls, 0);
});

test("unsupported events remain explicitly unsupported", async () => {
  const result = await runHookEntry(
    JSON.stringify({ event: "tool-use", projectRoot: "/repo" }),
    {
      capabilities: ["command-policy"],
      trusted: true
    }
  );

  assert.deepEqual(result, {
    action: "continue",
    status: "UNKNOWN",
    code: "HOOK_EVENT_UNSUPPORTED"
  });
});

test("invalid JSON stdin fails safely without throwing", async () => {
  const result = await runHookEntry("{not-json", {
    capabilities: ["command-policy"],
    trusted: true
  });

  assert.deepEqual(result, {
    action: "continue",
    status: "UNKNOWN",
    code: "HOOK_INPUT_INVALID"
  });
});

test("encoded hook output enforces a byte limit", () => {
  assert.throws(
    () =>
      encodeHookOutput(
        {
          action: "continue",
          status: "UNKNOWN",
          code: "x".repeat(128)
        },
        32
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "HOOK_OUTPUT_TOO_LARGE"
  );
});
