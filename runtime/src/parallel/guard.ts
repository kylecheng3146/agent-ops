import {registeredRunWriter} from "../run/ownership.js";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import type { HookResult } from "../hooks/events.js";
import type { GitRunner } from "../verify/change-surface.js";
import {
  insideWorktreeDirectory,
  mayUseWorktree,
  readWorktreeRecord,
  WORKTREE_DIRECTORY
} from "./service.js";

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

/** The gitignored goal file the `run` profile writes in the main checkout. */
export const RUN_GOAL_FILE = join(".agent-ops", "state", "run-goal.md");

/**
 * In worktree auto mode the main checkout is shared by every session, so no
 * session writes it directly: each edit belongs in that session's own
 * `.worktrees/<name>`. Paths outside the repository are not this guard's
 * business.
 */
export async function evaluateWorktreeWrite(
  mainRoot: string,
  paths: readonly string[],
  sessionId: string | undefined,
  /** Creates or reuses this writer's worktree and returns its path. */
  ensureWorktree?: (sessionId: string, agentId: string | undefined) => Promise<string>,
  /** The subagent making the write, when there is one: it has a worktree of its own. */
  agentId?: string,
  /** The `auto-run` capability: `agent-ops run` starts from the main checkout. */
  autoRun = false
): Promise<HookResult> {
  for (const path of paths) {
    const target = await canonicalPath(path);
    if (autoRun && target === join(mainRoot, RUN_GOAL_FILE)) continue;
    const inMain = target === mainRoot || target.startsWith(`${mainRoot}${sep}`);
    if (inMain && insideWorktreeDirectory(mainRoot, target) && sessionId !== undefined) {
      // A worktree belongs to the session that made it: writing into another
      // session's mixes two tasks' changes into one review and one merge.
      const name = relative(join(mainRoot, WORKTREE_DIRECTORY), target).split(sep)[0] ?? "";
      const record = await readWorktreeRecord(join(mainRoot, WORKTREE_DIRECTORY, name));
      const permitted = record === null || (record.runId === undefined
        ? mayUseWorktree(record, sessionId, agentId)
        : await registeredRunWriter(record, sessionId, agentId));
      if (record !== null && !permitted) {
        const owner = record.sessionId;
        const sameSession = owner === sessionId;
        let own = "";
        if (ensureWorktree !== undefined) {
          own = await ensureWorktree(sessionId, agentId).then(
            (worktree) => ` Your own worktree is ${worktree}: edit there instead${agentId === undefined ? "" : ", with absolute paths under it"}.`,
            () => ""
          );
        }
        return {
          action: "block",
          status: "FAIL",
          code: sameSession ? "WORKTREE_OWNED_BY_OTHER_AGENT" : "WORKTREE_OWNED_BY_OTHER_SESSION",
          remedy: `${join(mainRoot, WORKTREE_DIRECTORY, name)} belongs to ${sameSession ? `another writer of this session (${record.agentId ?? "its main thread"})` : `another session (${owner})`}; ` +
            `this session is ${sessionId}.${own || " Run agent-ops worktree add <name> --session " + sessionId + " from " + mainRoot + " and edit in the printed path."}`
        };
      }
    }
    if (inMain && !insideWorktreeDirectory(mainRoot, target)) {
      let failure = "";
      if (sessionId !== undefined && ensureWorktree !== undefined) {
        try {
          const worktree = await ensureWorktree(sessionId, agentId);
          return {
            action: "block",
            status: "FAIL",
            code: "WORKTREE_CREATED",
            remedy: agentId === undefined
              ? `worktree.mode is auto, so this session now has its own worktree at ${worktree}. Enter it (Claude Code: EnterWorktree with path ${worktree}; otherwise use the worktree path as every command's working directory) and redo this edit there, at ${join(worktree, relative(mainRoot, target))}.`
              : `worktree.mode is auto, so this subagent now has its own worktree at ${worktree}. Redo this edit there with an absolute path, at ${join(worktree, relative(mainRoot, target))}, and use absolute paths under ${worktree} for every later edit.`
          };
        } catch (error) {
          failure = ` Creating this session's worktree failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const session = sessionId ?? "<session-id>";
      return {
        action: "block",
        status: "FAIL",
        code: "WORKTREE_REQUIRED",
        remedy: `worktree.mode is auto, so the main checkout is shared and not edited directly.${failure} Run \`agent-ops worktree add <name> --session ${session}\` in ${mainRoot}, enter the printed path (Claude Code: EnterWorktree with that path; otherwise use it as every command's working directory), and edit there.`
      };
    }
  }
  return { action: "continue", status: "PASS", code: "WORKTREE_WRITE_ALLOWED" };
}
