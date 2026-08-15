import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import type { ReviewScope } from "../review/scope.js";
import { resolveGitCommit, type GitRunner } from "./change-surface.js";

export async function calculateSourceFingerprint(
  root: string,
  scope: ReviewScope,
  runner: GitRunner
): Promise<string> {
  const head = await resolveGitCommit(runner, "HEAD");
  if (scope.mode === "base") {
    return sha256(JSON.stringify({
      domain: "agent-ops-source-v1",
      mode: "base",
      head,
      base: scope.resolvedBase,
      paths: [...scope.changedFiles]
    }));
  }
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
  return sha256(JSON.stringify({
    domain: "agent-ops-source-v1",
    mode: "worktree",
    head,
    base: null,
    paths
  }));
}
