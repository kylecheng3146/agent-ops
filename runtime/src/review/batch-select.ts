import { AgentOpsError } from "../fs/paths.js";
import type { StoredTaskRecord } from "../task/store.js";

/**
 * The tasks one `batch --parent` covers: the parent's active subtasks in
 * creation order, then the parent itself. Archived and completed tasks, and
 * tasks under another parent, are left out.
 */
export function selectBatchTasks(
  records: readonly StoredTaskRecord[],
  parentId: string
): readonly StoredTaskRecord[] {
  const parent = records.find((record) => record.task.id === parentId);
  if (parent === undefined) {
    throw new AgentOpsError("BATCH_PARENT_NOT_FOUND", `Parent task not found: ${parentId}`);
  }
  if (parent.status !== "active") {
    throw new AgentOpsError("BATCH_PARENT_NOT_ACTIVE", `Parent task is not active: ${parentId}`);
  }
  const subtasks = records
    .filter((record) => record.task.parentTaskId === parentId && record.status === "active")
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.task.id.localeCompare(right.task.id));
  return [...subtasks, parent];
}

export interface BatchBaseInput {
  /** `--base`: applies to subtasks. */
  readonly base?: string;
  /** `--parent-base`: applies to the parent. */
  readonly parentBase?: string;
  /** The worktree's own base, the fallback for a task with no record yet. */
  readonly worktreeBase?: string;
}

export type BatchBaseSource = "flag" | "recorded" | "worktree";

/**
 * An explicit flag wins, then the commit the task's last PASS review measured
 * against (so a rerun reproduces the same fingerprint), then the worktree base.
 * A parent's base is a human choice that cannot be derived from the repository.
 */
export function resolveBatchBase(
  record: StoredTaskRecord,
  isParent: boolean,
  input: BatchBaseInput
): { readonly base: string; readonly source: BatchBaseSource } {
  const flag = isParent ? input.parentBase : input.base;
  if (flag !== undefined) {
    return { base: flag, source: "flag" };
  }
  if (record.reviewBase !== undefined) {
    return { base: record.reviewBase, source: "recorded" };
  }
  if (input.worktreeBase !== undefined) {
    return { base: input.worktreeBase, source: "worktree" };
  }
  throw new AgentOpsError(
    "BATCH_BASE_UNKNOWN",
    `No base for task ${record.task.id}: pass ${isParent ? "--parent-base" : "--base"} or run from an agent-ops worktree.`
  );
}
