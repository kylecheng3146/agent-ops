import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import type { ReviewScope } from "../review/scope.js";
import { resolveGitCommit, type GitRunner } from "./change-surface.js";

/**
 * Escape-ledger records are committed after the fix; a commit touching only them leaves the base-mode fingerprint alone.
 * Only top-level task records qualify: rules/ steer the surface gate and stay fingerprinted.
 */
const ledgerRecord = (path: string): boolean => /^\.agent-ops-escapes\/task-[A-Za-z0-9-]+\.json$/u.test(path);

/** HEAD's tree without the ledger, so a ledger-only commit yields the same digest. */
async function ledgerFreeTree(runner: GitRunner): Promise<string> {
  const result = await runner.run(["ls-tree", "-r", "--full-tree", "-z", "HEAD"]);
  if (result.exitCode !== 0) throw new AgentOpsError("CHANGE_SURFACE_GIT_FAILED", "Git could not list the HEAD tree.");
  const entries = Buffer.from(result.stdout).toString("utf8").split("\0").filter(entry => entry !== "" && !ledgerRecord(entry.split("\t", 2)[1]!));
  return sha256(entries.join("\0"));
}

export async function calculateSourceFingerprint(
  root: string,
  scope: ReviewScope,
  runner: GitRunner
): Promise<string> {
  if (scope.mode === "base") {
    return sha256(JSON.stringify({
      domain: "agent-ops-source-v2",
      mode: scope.noChange === true ? "goal-no-change" : "base",
      tree: await ledgerFreeTree(runner),
      base: scope.resolvedBase,
      paths: scope.changedFiles.filter(path => !ledgerRecord(path))
    }));
  }
  const head = await resolveGitCommit(runner, "HEAD");
  const paths = [] as Array<Record<string, unknown>>;
  for (const path of scope.changedFiles) {
    const absolute = join(root, ...path.split("/"));
    let entry;
    try {
      entry = await lstat(absolute);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        paths.push({ path, kind: "deleted" });
        continue;
      }
      throw error;
    }
    if (!entry.isFile()) {
      throw new AgentOpsError("SOURCE_SNAPSHOT_UNAVAILABLE", "Review source contains an unsupported entry.");
    }
    const bytes = await readFile(absolute);
    paths.push({
      path,
      kind: "file",
      executable: (entry.mode & 0o111) !== 0,
      hash: sha256(bytes)
    });
  }
  return worktreeFingerprint(head, paths);
}

/** A worktree-mode fingerprint; with no paths, that of a clean checkout at `head`. */
export function worktreeFingerprint(head: string, paths: ReadonlyArray<Record<string, unknown>> = []): string {
  return sha256(JSON.stringify({
    domain: "agent-ops-source-v1",
    mode: "worktree",
    head,
    base: null,
    paths
  }));
}
