import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runProjectLoop } from "../../runtime/src/hooks/codex-loop.js";

const TOKEN = `ghp_${"A".repeat(36)}`;

async function createLoopRoot(harness: "claude" | "codex" = "codex"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-project-loop-"));
  const directory = join(root, `.${harness}`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "loop-goal.md"),
    "# Current goal\n\nKeep the loop testable.\n"
  );
  await writeFile(
    join(directory, "loop-state.md"),
    "# Loop state\n\nManual note remains.\n"
  );
  await writeFile(join(directory, "loop-telemetry.jsonl"), "");
  return root;
}

test("Codex blocks a high-confidence literal secret prompt without echoing it", async () => {
  const root = await createLoopRoot();
  try {
    const result = await runProjectLoop({
      harness: "codex",
      event: "UserPromptSubmit",
      input: { cwd: root, prompt: `Please use token=${TOKEN}` },
      root
    });

    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /secret/i);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex blocks a broad recursive delete before execution", async () => {
  const root = await createLoopRoot();
  try {
    const result = await runProjectLoop({
      harness: "codex",
      event: "PreToolUse",
      input: {
        cwd: root,
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" }
      },
      root
    });

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /dangerous command/i);
    assert.doesNotMatch(JSON.stringify(result), /rm -rf/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex blocks a literal secret supplied through a Bash command", async () => {
  const root = await createLoopRoot();
  try {
    const result = await runProjectLoop({
      harness: "codex",
      event: "PreToolUse",
      input: {
        cwd: root,
        tool_name: "Bash",
        tool_input: { command: `echo ${TOKEN}` }
      },
      root
    });

    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /secret/i);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
    const telemetry = await readFile(
      join(root, ".codex", "loop-telemetry.jsonl"),
      "utf8"
    );
    assert.doesNotMatch(telemetry, new RegExp(TOKEN));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permission requests retain the native approval flow", async () => {
  const root = await createLoopRoot();
  try {
    const result = await runProjectLoop({
      harness: "codex",
      event: "PermissionRequest",
      input: {
        cwd: root,
        tool_name: "Bash",
        tool_input: { command: "git reset --hard" },
        sandbox_permissions: "require_escalated"
      },
      root
    });

    assert.deepEqual(result, { exitCode: 0, stdout: "", stderr: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionStart supplies bounded goal and telemetry context without logging goal text", async () => {
  const root = await createLoopRoot();
  try {
    const goal = `# Current goal\n\nFocus on loop behaviour.\n${"x".repeat(4_000)}\n`;
    await writeFile(join(root, ".codex", "loop-goal.md"), goal);

    const result = await runProjectLoop({
      harness: "codex",
      event: "SessionStart",
      input: { cwd: root },
      root,
      now: () => "2026-08-03T00:00:00.000Z"
    });

    assert.equal(result.exitCode, 0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { additionalContext: string; hookEventName: string };
    };
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(output.hookSpecificOutput.additionalContext, /Focus on loop behaviour/u);
    assert.ok(output.hookSpecificOutput.additionalContext.length <= 1_400);

    const telemetry = await readFile(
      join(root, ".codex", "loop-telemetry.jsonl"),
      "utf8"
    );
    assert.match(telemetry, /"type":"loop-event"/u);
    assert.doesNotMatch(telemetry, /Focus on loop behaviour/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PreCompact writes a bounded Git-status snapshot without replacing user state", async () => {
  const root = await createLoopRoot();
  try {
    const result = await runProjectLoop({
      harness: "codex",
      event: "PreCompact",
      input: { cwd: root },
      root,
      now: () => "2026-08-03T00:00:00.000Z",
      gitStatus: async () => `## feature/loop\n${" M src/example.ts\n".repeat(600)}`
    });

    assert.deepEqual(result, { exitCode: 0, stdout: "", stderr: "" });
    const state = await readFile(join(root, ".codex", "loop-state.md"), "utf8");
    assert.match(state, /Manual note remains/u);
    assert.match(state, /agent-ops:start loop-snapshot v1/u);
    assert.match(state, /## feature\/loop/u);
    assert.ok(state.length <= 4_700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("telemetry is redacted and rotated by a byte bound", async () => {
  const root = await createLoopRoot();
  try {
    for (let index = 0; index < 8; index += 1) {
      await runProjectLoop({
        harness: "codex",
        event: "PreToolUse",
        input: {
          cwd: root,
          tool_name: "Bash",
          tool_input: { command: `git reset --hard HEAD~${index}` }
        },
        root,
        telemetryMaxBytes: 320,
        now: () => `2026-08-03T00:00:0${index}.000Z`
      });
    }

    const telemetry = await readFile(
      join(root, ".codex", "loop-telemetry.jsonl"),
      "utf8"
    );
    assert.ok(Buffer.byteLength(telemetry) <= 320);
    assert.match(telemetry, /"code":"destructive-reset"/u);
    assert.doesNotMatch(telemetry, /git reset|HEAD~|token/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed input and loop I/O failures fail open", async () => {
  const root = await createLoopRoot();
  try {
    const malformed = await runProjectLoop({
      harness: "codex",
      event: "UserPromptSubmit",
      input: null,
      root
    });
    const unavailableGit = await runProjectLoop({
      harness: "codex",
      event: "PreCompact",
      input: { cwd: root },
      root,
      gitStatus: async () => {
        throw new Error("git unavailable");
      }
    });

    assert.deepEqual(malformed, { exitCode: 0, stdout: "", stderr: "" });
    assert.deepEqual(unavailableGit, { exitCode: 0, stdout: "", stderr: "" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
