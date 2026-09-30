import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { runHookProcess } from "../../packages/cli/src/hook-process.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { evaluateWorktreeEnter } from "../../runtime/src/parallel/enter.js";
import { addWorktree } from "../../runtime/src/parallel/service.js";
import { CONFIG, deps, gitRunner, repository } from "./fixture.js";

const ME = "session-one";
const AUTO: AgentOpsConfig = { ...CONFIG, worktree: { mode: "auto" } };

test("EnterWorktree is allowed only into a worktree recorded for the session", async () => {
  const root = await repository(AUTO);
  try {
    const mine = (await addWorktree(deps(), { cwd: root, name: "alpha", sessionId: ME })).record;
    const theirs = (await addWorktree(deps(), { cwd: root, name: "beta", sessionId: "session-two" })).record;
    const second = (await addWorktree(deps(), { cwd: root, name: "gamma", sessionId: ME })).record;

    for (const own of [mine, second]) {
      const allowed = await evaluateWorktreeEnter(root, own.path, ME);
      assert.equal(allowed.decision, "allow", own.path);
      assert.equal(allowed.code, "WORKTREE_ENTER_ALLOWED");
    }

    const foreign = await evaluateWorktreeEnter(root, theirs.path, ME);
    assert.equal(foreign.action, "block");
    assert.equal(foreign.code, "WORKTREE_ENTER_DENIED");
    assert.equal(foreign.decision, undefined);
    assert.ok((foreign.remedy ?? "").includes(mine.path), foreign.remedy ?? "");
    assert.ok((foreign.remedy ?? "").includes(second.path), foreign.remedy ?? "");
    assert.ok(!(foreign.remedy ?? "").includes(theirs.path), foreign.remedy ?? "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("anything that is not exactly a session's worktree root is denied or left to the host", async () => {
  const root = await repository(AUTO);
  const outside = await realpath(await mkdtemp(join(tmpdir(), "agent-ops-elsewhere-")));
  try {
    const mine = (await addWorktree(deps(), { cwd: root, name: "alpha", sessionId: ME })).record;
    await mkdir(join(mine.path, "src"), { recursive: true });
    await mkdir(join(root, ".worktrees", "unrecorded"), { recursive: true });

    for (const path of [
      join(mine.path, "src"),
      join(root, ".worktrees"),
      join(root, ".worktrees", "unrecorded"),
      join(root, ".worktrees", "missing"),
      root,
      outside,
      join(mine.path, "..", "..", "..")
    ]) {
      const result = await evaluateWorktreeEnter(root, path, ME);
      assert.equal(result.action, "block", path);
      assert.equal(result.code, "WORKTREE_ENTER_DENIED", path);
    }

    // A host that names no session cannot be judged, so the host decides.
    const unjudged = await evaluateWorktreeEnter(root, mine.path, undefined);
    assert.equal(unjudged.action, "continue");
    assert.equal(unjudged.decision, undefined);
    assert.ok(((await evaluateWorktreeEnter(root, outside, "session-three")).remedy ?? "")
      .includes("agent-ops worktree add <name> --session session-three"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

async function enterHook(root: string, config: AgentOpsConfig, path: string, session = ME): Promise<string> {
  const stdout: string[] = [];
  await runHookProcess(["claude", "PreToolUse"], {
    stdin: Readable.from([JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: session,
      cwd: root,
      tool_name: "EnterWorktree",
      tool_input: { path }
    })]),
    writeStdout: (value) => { stdout.push(value); },
    writeStderr: () => undefined
  }, "0.4.0", {
    root,
    loadConfig: async () => config,
    trust: async () => "UNTRUSTED",
    gitRunner: gitRunner(root)
  });
  return stdout.join("");
}

test("the hook answers an EnterWorktree of the session's own worktree with allow, and any other with deny", async () => {
  const root = await repository(AUTO);
  try {
    const mine = (await addWorktree(deps(), { cwd: root, name: "alpha", sessionId: ME })).record;
    const allowed = JSON.parse(await enterHook(root, AUTO, mine.path)) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    assert.equal(allowed.hookSpecificOutput.permissionDecision, "allow");

    const denied = JSON.parse(await enterHook(root, AUTO, root)) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /^WORKTREE_ENTER_DENIED: /u);

    // Outside auto mode the host keeps its own question.
    assert.equal(await enterHook(root, CONFIG, mine.path), "");
    // Another session gets no allow for this one's worktree.
    const other = JSON.parse(await enterHook(root, AUTO, mine.path, "session-two")) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    assert.equal(other.hookSpecificOutput.permissionDecision, "deny");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
