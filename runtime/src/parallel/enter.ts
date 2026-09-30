import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import type { HookResult } from "../hooks/events.js";
import { canonicalPath } from "./guard.js";
import { readWorktreeRecord, WORKTREE_DIRECTORY } from "./service.js";

/**
 * Whether Claude's EnterWorktree may switch this session into `path`. Only the
 * worktree agent-ops recorded for the session is answered for the host, so an
 * allow never lets the session move its permission root to a directory it did
 * not get from `worktree add`.
 */
export async function evaluateWorktreeEnter(
  mainRoot: string,
  path: string,
  sessionId: string | undefined
): Promise<HookResult> {
  if (sessionId === undefined) {
    return { action: "continue", status: "UNKNOWN", code: "WORKTREE_ENTER_UNJUDGED" };
  }
  const directory = join(mainRoot, WORKTREE_DIRECTORY);
  const target = await canonicalPath(path);
  const name = relative(directory, target).split(sep)[0] ?? "";
  const inside = !target.startsWith(`${directory}${sep}`) ? false : target === join(directory, name);
  if (inside && (await readWorktreeRecord(target))?.sessionId === sessionId) {
    return {
      action: "continue",
      status: "PASS",
      code: "WORKTREE_ENTER_ALLOWED",
      remedy: `${target} is the worktree agent-ops recorded for this session.`,
      decision: "allow"
    };
  }
  const owned: string[] = [];
  for (const entry of await readdir(directory).catch(() => [] as string[])) {
    if ((await readWorktreeRecord(join(directory, entry)))?.sessionId === sessionId) {
      owned.push(join(directory, entry));
    }
  }
  return {
    action: "block",
    status: "FAIL",
    code: "WORKTREE_ENTER_DENIED",
    remedy: `EnterWorktree may enter only a worktree this session owns. ` +
      (owned.length > 0
        ? `Yours: ${owned.join(", ")}.`
        : `None yet: run agent-ops worktree add <name> --session ${sessionId} from ${mainRoot}.`)
  };
}
