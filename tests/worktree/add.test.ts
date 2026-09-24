import assert from "node:assert/strict";
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { FileCompletionGateStore } from "../../runtime/src/hooks/completion-gate.js";
import { addWorktree, readWorktreeRecord } from "../../runtime/src/worktree/service.js";
import { CONFIG, deps, gateFor, git, repository, stopEvent, write } from "./fixture.js";

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

test("add creates the worktree on its own branch and excludes the directory once", async () => {
  const root = await repository();
  try {
    const d = deps();
    const first = await addWorktree(d, { cwd: root, name: "alpha", sessionId: SESSION });
    await addWorktree(d, { cwd: root, name: "beta", sessionId: "session-two" });

    assert.equal(first.record.path, join(root, ".worktrees", "alpha"));
    assert.equal(first.record.branch, "agent-ops/alpha");
    assert.equal(first.record.targetBranch, "main");
    assert.equal(first.record.base, await git(root, "rev-parse", "HEAD"));
    assert.equal(await git(first.record.path, "rev-parse", "--abbrev-ref", "HEAD"), "agent-ops/alpha");
    const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    assert.equal(exclude.split("\n").filter((line) => line === "/.worktrees/").length, 1);
    // The main checkout's change surface does not see either worktree.
    assert.equal(await git(root, "status", "--porcelain"), "");
    assert.deepEqual(await readWorktreeRecord(first.record.path), first.record);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("add copies ignored agent-ops files and .worktreeinclude matches but never a checked-out file", async () => {
  const root = await repository();
  try {
    await write(root, ".env", "SECRET=1\n");
    await write(root, ".worktreeinclude", ".env\n");
    await git(root, "add", ".worktreeinclude");
    await git(root, "commit", "-m", "include");
    // An uncommitted edit to a tracked, manifest-listed file stays in main.
    await write(root, "CLAUDE.md", "uncommitted rules\n");

    const result = await addWorktree(deps(), { cwd: root, name: "alpha", sessionId: SESSION });
    const path = result.record.path;

    assert.deepEqual(result.copied, [
      ".agent-ops/CLAUDE.md",
      ".agent-ops/config.json",
      ".agent-ops/manifest.json",
      ".env"
    ]);
    assert.equal(await readFile(join(path, ".agent-ops", "CLAUDE.md"), "utf8"), "managed rules\n");
    assert.equal(await readFile(join(path, ".env"), "utf8"), "SECRET=1\n");
    assert.equal(await readFile(join(path, "CLAUDE.md"), "utf8"), "committed rules\n");
    assert.equal(await git(path, "status", "--porcelain"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trust is inherited only for a trusted main checkout with the identical config", async () => {
  const trusted = await repository();
  const untrusted = await repository();
  const drifted = await repository();
  try {
    const a = deps({ trust: "TRUSTED" });
    const inherited = await addWorktree(a, { cwd: trusted, name: "alpha", sessionId: SESSION });
    assert.equal(inherited.trusted, true);
    assert.deepEqual(a.granted, [inherited.record.path]);

    const b = deps({ trust: "UNTRUSTED" });
    const plain = await addWorktree(b, { cwd: untrusted, name: "alpha", sessionId: SESSION });
    assert.equal(plain.trusted, false);
    assert.deepEqual(b.granted, []);

    // A tracked config the main checkout has edited differs in the worktree.
    await git(drifted, "add", "-f", ".agent-ops/config.json");
    await git(drifted, "commit", "-m", "track config");
    await write(drifted, ".agent-ops/config.json", `${JSON.stringify({ ...CONFIG, profiles: ["core"] })}\n`);
    const c = deps({ trust: "TRUSTED" });
    const differing = await addWorktree(c, { cwd: drifted, name: "alpha", sessionId: SESSION });
    assert.equal(differing.trusted, false);
    assert.deepEqual(c.granted, []);
  } finally {
    await rm(trusted, { recursive: true, force: true });
    await rm(untrusted, { recursive: true, force: true });
    await rm(drifted, { recursive: true, force: true });
  }
});

test("setup runs in the new worktree, and a failing step rolls the worktree back", async () => {
  const withSetup = { ...CONFIG, worktree: { mode: "auto" as const, setup: [{ command: "pnpm", args: ["install"] }] } };
  const ok = await repository(withSetup);
  const failing = await repository(withSetup);
  const untrusted = await repository(withSetup);
  try {
    const good = deps();
    const created = await addWorktree(good, { cwd: ok, name: "alpha", sessionId: SESSION });
    assert.deepEqual(created.setup, ["pnpm install"]);
    assert.equal(good.setupRuns[0]?.cwd, created.record.path);
    assert.equal(good.setupRuns[0]?.step.timeoutMs, 600000);

    const bad = deps({ setupExit: 1 });
    await assert.rejects(
      addWorktree(bad, { cwd: failing, name: "alpha", sessionId: SESSION }),
      rejectsWith("WORKTREE_SETUP_FAILED")
    );
    assert.equal(await exists(join(failing, ".worktrees", "alpha")), false);
    assert.equal(await git(failing, "branch", "--list", "agent-ops/alpha"), "");
    assert.deepEqual(bad.revoked, bad.granted);
    assert.equal(await new FileCompletionGateStore(failing).read(SESSION), null);

    await assert.rejects(
      addWorktree(deps({ trust: "UNTRUSTED" }), { cwd: untrusted, name: "alpha", sessionId: SESSION }),
      rejectsWith("WORKTREE_SETUP_UNTRUSTED")
    );
    assert.equal(await exists(join(untrusted, ".worktrees", "alpha")), false);
  } finally {
    await rm(ok, { recursive: true, force: true });
    await rm(failing, { recursive: true, force: true });
    await rm(untrusted, { recursive: true, force: true });
  }
});

test("add seeds the worktree gate and redirects the main checkout's Stop to it", async () => {
  const root = await repository();
  try {
    const { record } = await addWorktree(deps(), { cwd: root, name: "alpha", sessionId: SESSION });
    assert.equal((await new FileCompletionGateStore(root).read(SESSION))?.root, record.path);
    assert.notEqual(await new FileCompletionGateStore(record.path).read(SESSION), null);
    const main = gateFor(root, CONFIG);

    assert.equal((await main.handle(stopEvent(SESSION)))?.code, "COMPLETION_GATE_ALLOWED");

    await write(record.path, "source.txt", "worktree edit\n");
    assert.equal((await main.handle(stopEvent(SESSION)))?.code, "COMPLETION_GATE_TASK_REQUIRED");
    await git(record.path, "checkout", "--", "source.txt");

    await write(root, "source.txt", "main edit\n");
    assert.equal((await main.handle(stopEvent(SESSION)))?.code, "COMPLETION_GATE_MAIN_CHANGED");
    await git(root, "checkout", "--", "source.txt");

    await rm(record.path, { recursive: true, force: true });
    assert.equal((await main.handle(stopEvent(SESSION)))?.code, "COMPLETION_GATE_WORKTREE_MISSING");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("add refuses invalid names, a missing session and nested invocation", async () => {
  const root = await repository();
  try {
    const d = deps();
    for (const name of [undefined, "", "Upper", "-lead", "trail-", "a/b", "a..b", "x".repeat(65)]) {
      await assert.rejects(addWorktree(d, { cwd: root, name, sessionId: SESSION }), rejectsWith("WORKTREE_NAME_INVALID"));
    }
    await assert.rejects(addWorktree(d, { cwd: root, name: "alpha", sessionId: undefined }), rejectsWith("WORKTREE_SESSION_REQUIRED"));
    const { record } = await addWorktree(d, { cwd: root, name: "alpha", sessionId: SESSION });
    await assert.rejects(addWorktree(d, { cwd: record.path, name: "beta", sessionId: SESSION }), rejectsWith("WORKTREE_NESTED"));
    await assert.rejects(addWorktree(d, { cwd: root, name: "alpha", sessionId: SESSION }), rejectsWith("WORKTREE_EXISTS"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree add parses a name and --session and rejects anything else", () => {
  assert.deepEqual(
    (({ command, action, worktreeName, sessionId }) => ({ command, action, worktreeName, sessionId }))(
      parseArgs(["worktree", "add", "alpha", "--session", "s-1"])
    ),
    { command: "worktree", action: "add", worktreeName: "alpha", sessionId: "s-1" }
  );
  assert.equal(parseArgs(["worktree", "finish", "alpha"]).action, "finish");
  for (const [argv, code] of [
    [["worktree"], "CLI_ACTION_REQUIRED"],
    [["worktree", "add"], "CLI_OPTION_NOT_ALLOWED"],
    [["worktree", "add", "a", "b"], "CLI_UNEXPECTED_ARGUMENT"],
    [["worktree", "add", "a", "--yes"], "CLI_OPTION_NOT_ALLOWED"],
    [["worktree", "add", "a", "--task", "t"], "CLI_OPTION_NOT_ALLOWED"],
    [["worktree", "add", "a", "--base", "main"], "CLI_OPTION_NOT_ALLOWED"],
    [["worktree", "finish", "a", "--session", "s-1"], "CLI_OPTION_NOT_ALLOWED"]
  ] as const) {
    assert.throws(() => parseArgs(argv), (error: unknown) =>
      typeof error === "object" && error !== null && (error as { code?: string }).code === code,
      argv.join(" "));
  }
});

test("add carries an ignored config even without an install manifest", async () => {
  const root = await repository();
  try {
    await rm(join(root, ".agent-ops", "manifest.json"));
    const result = await addWorktree(deps(), { cwd: root, name: "alpha", sessionId: SESSION });
    assert.deepEqual(result.copied, [".agent-ops/config.json"]);
    assert.equal(result.trusted, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
