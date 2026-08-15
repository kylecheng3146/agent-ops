import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { resolveReviewScope } from "../../runtime/src/review/scope.js";
import type { GitRunner } from "../../runtime/src/verify/change-surface.js";

function nul(...paths: readonly string[]): Uint8Array {
  return Buffer.from(paths.map((path) => `${path}\0`).join(""));
}

function runner(changed: readonly string[], baseChanged: readonly string[] = []): GitRunner {
  return {
    run: async (args) => ({
      exitCode: 0,
      stdout: args[0] === "rev-parse"
        ? Buffer.from(`${"a".repeat(40)}\n`)
        : args[0] === "diff" && args.some((arg) => arg.endsWith("...HEAD"))
          ? nul(...baseChanged)
          : args[0] === "diff" && args[1] === "--cached"
            ? nul(...changed)
            : new Uint8Array()
    })
  };
}

test("review scope uses the sorted worktree surface and rejects empty scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-scope-"));
  try {
    const scope = await resolveReviewScope({
      root,
      runner: runner(["src/b.ts", "src/a.ts"])
    });
    assert.deepEqual(scope, {
      mode: "worktree",
      changedFiles: ["src/a.ts", "src/b.ts"]
    });
    await assert.rejects(
      resolveReviewScope({ root, runner: runner([]) }),
      (error: unknown) => error instanceof AgentOpsError && error.code === "REVIEW_NO_CHANGE_SURFACE"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("base scope requires a clean worktree and resolves one commit range", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-scope-"));
  try {
    const scope = await resolveReviewScope({
      root,
      runner: runner([], ["src/committed.ts"]),
      base: "origin/main"
    });
    assert.equal(scope.mode, "base");
    assert.deepEqual(scope.changedFiles, ["src/committed.ts"]);
    await assert.rejects(
      resolveReviewScope({ root, runner: runner(["src/dirty.ts"]), base: "origin/main" }),
      (error: unknown) => error instanceof AgentOpsError && error.code === "REVIEW_DIRTY_WORKTREE"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review scope rejects symlinked path components", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-scope-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-ops-outside-"));
  try {
    await mkdir(join(outside, "src"));
    await symlink(outside, join(root, "src"));
    await assert.rejects(
      resolveReviewScope({ root, runner: runner(["src/example.ts"]) }),
      (error: unknown) => error instanceof AgentOpsError && error.code === "REVIEW_UNSAFE_PATH"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
