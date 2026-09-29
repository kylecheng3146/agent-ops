import assert from "node:assert/strict";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { Readable } from "node:stream";

import { runHookProcess } from "../../packages/cli/src/hook-process.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import {
  addWorktree,
  readSessionOrigin,
  readWorktreeRecord,
  recordSessionOrigin,
  sessionWorktreeName
} from "../../runtime/src/parallel/service.js";
import { CONFIG, deps, git, gitRunner, repository, write } from "./fixture.js";

const SESSION = "session-one";

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function rejectsWith(code: string) {
  return (error: unknown) => error instanceof AgentOpsError && error.code === code;
}

test("add pins the branch the session began on, however far the checkout has moved", async () => {
  const root = await repository();
  try {
    const d = deps();
    await git(root, "checkout", "-qb", "feature/a");
    await write(root, "a.txt", "on feature/a\n");
    await git(root, "add", "a.txt");
    await git(root, "commit", "-qm", "feature/a work");
    await recordSessionOrigin(d, { cwd: root, sessionId: SESSION });
    await git(root, "checkout", "-qb", "develop", "main");
    // Resume fires SessionStart again from the new branch: first write wins.
    await recordSessionOrigin(d, { cwd: root, sessionId: SESSION });
    assert.equal(await readSessionOrigin(root, SESSION), "feature/a");

    const { record } = await addWorktree(d, { cwd: root, name: "alpha", sessionId: SESSION });
    assert.equal(record.targetBranch, "feature/a");
    assert.equal(record.base, await git(root, "rev-parse", "feature/a"));
    assert.equal(await exists(join(record.path, "a.txt")), true);
    assert.equal(await git(root, "rev-parse", "--abbrev-ref", "HEAD"), "develop");

    // An explicit target or base outranks the record.
    const explicit = await addWorktree(d, { cwd: root, name: "beta", sessionId: SESSION, targetBranch: "main" });
    assert.equal(explicit.record.targetBranch, "main");
    assert.equal(explicit.record.base, await git(root, "rev-parse", "HEAD"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("add without a record reads HEAD, and a recorded branch that is gone is an error", async () => {
  const root = await repository();
  try {
    const d = deps();
    const none = await addWorktree(d, { cwd: root, name: "alpha", sessionId: "unrecorded" });
    assert.equal(none.record.targetBranch, "main");

    await git(root, "checkout", "-qb", "feature/gone");
    await recordSessionOrigin(d, { cwd: root, sessionId: SESSION });
    await git(root, "checkout", "-q", "main");
    await git(root, "branch", "-D", "feature/gone");
    await assert.rejects(
      addWorktree(d, { cwd: root, name: "beta", sessionId: SESSION }),
      (error: unknown) => rejectsWith("WORKTREE_ORIGIN_MISSING")(error) &&
        (error as Error).message.includes("--target-branch")
    );
    assert.equal(await exists(join(root, ".worktrees", "beta")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the SessionStart and PreToolUse hooks pin the branch through to the created worktree", async () => {
  const config: AgentOpsConfig = { ...CONFIG, worktree: { mode: "auto" } };
  const root = await repository(config);
  try {
    const d = deps();
    const run = async (event: string, input: unknown): Promise<string> => {
      const stdout: string[] = [];
      await runHookProcess(["claude", event], {
        stdin: Readable.from([JSON.stringify(input)]),
        writeStdout: (value) => { stdout.push(value); },
        writeStderr: () => undefined
      }, "0.2.9", {
        root, loadConfig: async () => config, trust: async () => "UNTRUSTED",
        gitRunner: gitRunner(root), worktree: d
      });
      return stdout.join("");
    };
    await git(root, "checkout", "-qb", "feature/a");
    await run("SessionStart", { hook_event_name: "SessionStart", session_id: SESSION, cwd: root, source: "startup" });
    await git(root, "checkout", "-qb", "develop", "main");
    const denied = await run("PreToolUse", {
      hook_event_name: "PreToolUse", session_id: SESSION, cwd: root,
      tool_name: "Edit", tool_input: { file_path: join(root, "source.txt") }
    });

    assert.match(denied, /WORKTREE_CREATED/u);
    const record = await readWorktreeRecord(join(root, ".worktrees", sessionWorktreeName(SESSION)));
    assert.equal(record?.targetBranch, "feature/a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nothing is recorded from a detached HEAD or from inside a worktree", async () => {
  const root = await repository();
  try {
    const d = deps();
    await git(root, "checkout", "-q", "--detach");
    await recordSessionOrigin(d, { cwd: root, sessionId: SESSION });
    assert.equal(await readSessionOrigin(root, SESSION), null);

    await git(root, "checkout", "-q", "main");
    const { record } = await addWorktree(d, { cwd: root, name: "alpha", sessionId: "other" });
    await recordSessionOrigin(d, { cwd: record.path, sessionId: SESSION });
    assert.equal(await readSessionOrigin(root, SESSION), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
