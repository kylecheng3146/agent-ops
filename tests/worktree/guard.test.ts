import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { runHookProcess } from "../../packages/cli/src/hook-process.js";
import { normalizeClaudeHookInput } from "../../runtime/src/adapters/claude/input.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { runProjectLoop } from "../../runtime/src/hooks/codex-loop.js";
import { evaluateWorktreeWrite } from "../../runtime/src/parallel/guard.js";
import {
  addWorktree,
  readWorktreeRecord,
  sessionWorktreeName
} from "../../runtime/src/parallel/service.js";
import { CONFIG, deps, gateFor, gitRunner, repository } from "./fixture.js";

const SESSION = "session-one";
const AUTO: AgentOpsConfig = { ...CONFIG, worktree: { mode: "auto" } };

function edit(cwd: string, filePath: string, tool = "Edit") {
  return {
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    cwd,
    tool_name: tool,
    tool_input: tool === "NotebookEdit" ? { notebook_path: filePath } : { file_path: filePath }
  };
}

async function preToolUse(
  root: string,
  config: AgentOpsConfig,
  input: unknown,
  worktree?: ReturnType<typeof deps>
): Promise<string> {
  const stdout: string[] = [];
  await runHookProcess(["claude", "PreToolUse"], {
    stdin: Readable.from([JSON.stringify(input)]),
    writeStdout: (value) => { stdout.push(value); },
    writeStderr: () => undefined
  }, "0.2.9", {
    root,
    loadConfig: async () => config,
    trust: async () => "UNTRUSTED",
    gitRunner: gitRunner(root),
    ...(worktree === undefined ? {} : { worktree })
  });
  return stdout.join("");
}

function denialReason(stdout: string): string {
  const output = JSON.parse(stdout) as {
    hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
  };
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  return output.hookSpecificOutput.permissionDecisionReason;
}

test("Claude file tools normalize to a file-write event with absolute paths", () => {
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    const event = normalizeClaudeHookInput(edit("/repo", "src/a.ts", tool));
    assert.deepEqual(event, { event: "file-write", projectRoot: "/repo", paths: [resolve("/repo", "src/a.ts")], sessionId: SESSION }, tool);
  }
  assert.deepEqual(
    (normalizeClaudeHookInput(edit("/repo", "/elsewhere/b.ts")) as unknown as { paths: string[] }).paths,
    [resolve("/elsewhere/b.ts")]
  );
  assert.equal(normalizeClaudeHookInput({ ...edit("/repo", "a"), tool_name: "Read" }).event, "unsupported");
});

test("the guard denies main-checkout writes and allows worktree and outside writes", async () => {
  const root = await repository();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "agent-ops-outside-")));
  try {
    const main = await evaluateWorktreeWrite(root, [join(root, "src", "new-file.ts")], SESSION);
    assert.equal(main.action, "block");
    assert.equal(main.code, "WORKTREE_REQUIRED");
    assert.match(main.remedy ?? "", /agent-ops worktree add <name> --session session-one/u);

    await mkdir(join(root, ".worktrees", "alpha"), { recursive: true });
    assert.equal((await evaluateWorktreeWrite(root, [join(root, ".worktrees", "alpha", "a.ts")], SESSION)).action, "continue");
    assert.equal((await evaluateWorktreeWrite(root, [join(outside, "notes.md")], SESSION)).action, "continue");
    // A non-canonical spelling of the main checkout is still the main checkout.
    const spelled = root.startsWith("/private/") ? root.slice("/private".length) : root;
    assert.equal((await evaluateWorktreeWrite(root, [join(spelled, "a.ts")], SESSION)).action, "block");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("the hook denies a main-checkout Edit only in auto mode", async () => {
  const root = await repository(AUTO);
  try {
    const denied = JSON.parse(await preToolUse(root, AUTO, edit(root, join(root, "source.txt")))) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /^WORKTREE_REQUIRED: /u);

    const { record } = await addWorktree(deps(), { cwd: root, name: "alpha", sessionId: SESSION });
    assert.equal(await preToolUse(record.path, AUTO, edit(record.path, join(record.path, "source.txt"))), "");
    assert.equal(await preToolUse(root, CONFIG, edit(root, join(root, "source.txt"))), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the first blocked Edit creates the session's worktree, and later ones reuse it", async () => {
  const root = await repository(AUTO);
  try {
    const first = denialReason(await preToolUse(root, AUTO, edit(root, join(root, "source.txt")), deps()));
    const path = join(root, ".worktrees", sessionWorktreeName(SESSION));
    assert.match(first, /^WORKTREE_CREATED: /u);
    assert.ok(first.includes(`EnterWorktree with path ${path}`), first);
    assert.ok(first.includes(join(path, "source.txt")), first);
    assert.equal((await readWorktreeRecord(path))?.sessionId, SESSION);

    const second = denialReason(await preToolUse(root, AUTO, edit(root, join(root, "other.txt")), deps()));
    assert.match(second, /^WORKTREE_CREATED: /u);
    assert.ok(second.includes(`EnterWorktree with path ${path}`), second);
    assert.deepEqual(await readdir(join(root, ".worktrees")), [sessionWorktreeName(SESSION)]);

    // Inside the worktree the edit goes through.
    assert.equal(await preToolUse(path, AUTO, edit(path, join(path, "source.txt")), deps()), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("without a session id or when creation fails, the manual remedy stays", async () => {
  const root = await repository();
  try {
    let calls = 0;
    const anonymous = await evaluateWorktreeWrite(root, [join(root, "a.ts")], undefined, async () => {
      calls += 1;
      return "/never";
    });
    assert.equal(anonymous.code, "WORKTREE_REQUIRED");
    assert.equal(calls, 0);

    const failed = await evaluateWorktreeWrite(root, [join(root, "a.ts")], SESSION, async () => {
      throw new Error("Setup step failed (npm ci, exit 1)");
    });
    assert.equal(failed.action, "block");
    assert.equal(failed.code, "WORKTREE_REQUIRED");
    assert.match(failed.remedy ?? "", /Creating this session's worktree failed: Setup step failed \(npm ci, exit 1\)/u);
    assert.match(failed.remedy ?? "", /agent-ops worktree add <name> --session session-one/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session worktree names are valid worktree names", () => {
  assert.equal(sessionWorktreeName("a4b7e8de-3473-4936-bf49-b062ccdc6ffb"), "session-a4b7e8de");
  assert.equal(sessionWorktreeName("rm -rf /; O'Brien"), "session-rmrfobri");
  assert.equal(sessionWorktreeName("---"), "session-0");
});

test("SessionStart tells the agent its session id, and auto mode asks for a worktree", async () => {
  const root = await repository(AUTO);
  try {
    await mkdir(join(root, ".claude"), { recursive: true });
    const loop = await runProjectLoop({
      harness: "claude",
      event: "SessionStart",
      input: { cwd: root, session_id: SESSION, source: "startup" },
      root
    });
    const context = (JSON.parse(loop.stdout) as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    assert.match(context, /^Session: session-one$/mu);
    const tricky = await runProjectLoop({
      harness: "claude",
      event: "SessionStart",
      input: { cwd: root, session_id: "rm -rf /; o'brien", source: "startup" },
      root
    });
    assert.doesNotMatch(tricky.stdout, /Session: /u);

    const started = await gateFor(root, AUTO).handle({ event: "session-start", projectRoot: root, sessionId: SESSION });
    assert.equal(started?.code, "COMPLETION_GATE_WORKTREE_MODE");
    assert.match(started?.remedy ?? "", /run agent-ops task create from this checkout, which creates this session's worktree/u);
    assert.match(started?.remedy ?? "", /worktree add <name> --session 'session-one'/u);
    assert.equal(
      (await gateFor(root, CONFIG).handle({ event: "session-start", projectRoot: root, sessionId: "session-off" }))?.code,
      "COMPLETION_GATE_READY"
    );

    // A session that starts inside a worktree is already where it belongs.
    const { record } = await addWorktree(deps(), { cwd: root, name: "alpha", sessionId: "session-two" });
    assert.equal(
      (await gateFor(record.path, AUTO).handle({ event: "session-start", projectRoot: record.path, sessionId: "session-three" }))?.code,
      "COMPLETION_GATE_READY"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
