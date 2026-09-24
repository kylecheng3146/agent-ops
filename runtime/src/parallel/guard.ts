import { realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import type { HookResult } from "../hooks/events.js";
import type { GitRunner } from "../verify/change-surface.js";
import { insideWorktreeDirectory } from "./service.js";

/** The main checkout of the repository `runner` runs in, or null. */
export async function resolveMainRoot(runner: GitRunner): Promise<string | null> {
  const result = await runner.run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (result.exitCode !== 0) return null;
  try {
    const commonDir = await realpath(new TextDecoder().decode(result.stdout).trim());
    return basename(commonDir) === ".git" ? dirname(commonDir) : null;
  } catch {
    return null;
  }
}

/**
 * The real path of `path`, resolved through its deepest existing ancestor: a
 * Write creates files that do not exist yet, and a symlinked spelling of the
 * repository must not decide whether an edit lands in the main checkout.
 */
export async function canonicalPath(path: string): Promise<string> {
  const pending: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...pending.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      pending.push(basename(current));
      current = parent;
    }
  }
}

/**
 * In worktree auto mode the main checkout is shared by every session, so no
 * session writes it directly: each edit belongs in that session's own
 * `.worktrees/<name>`. Paths outside the repository are not this guard's
 * business.
 */
export async function evaluateWorktreeWrite(
  mainRoot: string,
  paths: readonly string[],
  sessionId: string | undefined
): Promise<HookResult> {
  for (const path of paths) {
    const target = await canonicalPath(path);
    const inMain = target === mainRoot || target.startsWith(`${mainRoot}${sep}`);
    if (inMain && !insideWorktreeDirectory(mainRoot, target)) {
      const session = sessionId ?? "<session-id>";
      return {
        action: "block",
        status: "FAIL",
        code: "WORKTREE_REQUIRED",
        remedy: `worktree.mode is auto, so the main checkout is shared and not edited directly. Run \`agent-ops worktree add <name> --session ${session}\` in ${mainRoot}, enter the printed path (Claude Code: EnterWorktree with that path), and edit there.`
      };
    }
  }
  return { action: "continue", status: "PASS", code: "WORKTREE_WRITE_ALLOWED" };
}
