import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import {randomUUID} from "node:crypto";
import { join } from "node:path";

import { AgentOpsError } from "../fs/paths.js";
import { ReviewInterruptedError } from "./execute.js";
import {withPrivateFileLock} from "../security/permissions.js";

/** Reviews allowed at once across every worktree of a repository. */
export const REVIEW_SLOT_WIDTH = 2;
const POLL_MS = 1000;
// A review is two reviewer sessions of at most 15 minutes each plus probes.
const STALE_MS = 2 * 60 * 60 * 1000;

export interface ReviewSlotOptions {
  /** A directory every worktree shares: the repository's common Git directory. */
  readonly dir: string;
  readonly width?: number;
  readonly signal?: AbortSignal;
  readonly pollMs?: number;
  readonly staleMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onWait?: (line: string) => void;
  /** Shown by the office view; identifies who holds the slot, never what it reviews. */
  readonly holder?: { readonly taskId?: string; readonly root?: string };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

async function stale(path: string, staleMs: number): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as { pid?: unknown; at?: unknown };
    if (typeof owner.pid !== "number" || typeof owner.at !== "number") return true;
    return !alive(owner.pid) || Date.now() - owner.at > staleMs;
  } catch {
    // A holder between mkdir and writing its owner file looks like this too.
    try {
      return Date.now() - (await stat(path)).mtimeMs > 60_000;
    } catch {
      return true;
    }
  }
}

/**
 * Runs `action` once one of `width` shared slots is free. Reviewer CLIs are
 * metered and flaky under load, and writers in separate worktrees each start
 * their own review, so this is what keeps the total bounded. A slot held by a
 * dead process is reclaimed.
 */
export async function withReviewSlot<T>(
  options: ReviewSlotOptions,
  action: () => Promise<T>
): Promise<T> {
  const width = options.width ?? REVIEW_SLOT_WIDTH;
  if (!Number.isInteger(width) || width < 1) {
    throw new AgentOpsError("REVIEW_SLOT_INVALID_WIDTH", "Review slot width must be a positive integer.");
  }
  const sleep = options.sleep ?? (async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms)));
  let waiting = false;
  let held: string | undefined;
  const token = randomUUID();
  while (held === undefined) {
    if (options.signal?.aborted === true) throw new ReviewInterruptedError(String(options.signal.reason ?? ""));
    for (let index = 0; index < width && held === undefined; index += 1) {
      const path = join(options.dir, `agent-ops-review-slot-${index}.lock`);
      try {
        const claimed = await withPrivateFileLock(path + ".state", options.dir, async () => {
          if (options.signal?.aborted === true) throw new ReviewInterruptedError(String(options.signal.reason ?? ""));
          for (;;) {
            try {
              await mkdir(path);
              await writeFile(join(path, "owner.json"), JSON.stringify({...options.holder, pid: process.pid, at: Date.now(), token}));
              return true;
            } catch (error) {
              if ((error as {code?: string}).code !== "EEXIST") throw error;
              if (!await stale(path, options.staleMs ?? STALE_MS)) return false;
              await rm(path, {recursive: true, force: true});
            }
          }
        });
        if (claimed) held = path;
      } catch (error) {
        if (!(error instanceof AgentOpsError) || error.code !== "PRIVATE_STATE_LOCK_TIMEOUT") throw error;
      }
    }
    if (held === undefined) {
      if (!waiting) {
        waiting = true;
        options.onWait?.(`review: waiting for one of ${String(width)} shared review slots`);
      }
      await sleep(options.pollMs ?? POLL_MS);
    }
  }
  try {
    if (options.signal?.aborted === true) throw new ReviewInterruptedError(String(options.signal.reason ?? ""));
    return await action();
  } finally {
    await withPrivateFileLock(held + ".state", options.dir, async () => {
      const owner = await readFile(join(held!, "owner.json"), "utf8").catch(error => {
        if ((error as {code?: string}).code === "ENOENT") return null;
        throw error;
      });
      if (owner !== null && JSON.parse(owner)?.token === token) await rm(held!, {recursive: true, force: true});
    });
  }
}
