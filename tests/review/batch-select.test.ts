import assert from "node:assert/strict";
import test from "node:test";

import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { resolveBatchBase, selectBatchTasks } from "../../runtime/src/review/batch-select.js";
import type { StoredTaskRecord } from "../../runtime/src/task/store.js";

function record(
  id: string,
  options: {
    readonly status?: StoredTaskRecord["status"];
    readonly parent?: string;
    readonly createdAt?: string;
    readonly reviewBase?: string;
  } = {}
): StoredTaskRecord {
  return {
    task: {
      schemaVersion: 1,
      id,
      title: id,
      criteria: [],
      ...(options.parent === undefined ? {} : { parentTaskId: options.parent })
    },
    status: options.status ?? "active",
    evidence: {},
    createdAt: options.createdAt ?? "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    failureFingerprint: null,
    policyConfigHash: null,
    completionBase: null,
    ...(options.reviewBase === undefined ? {} : { reviewBase: options.reviewBase })
  } as unknown as StoredTaskRecord;
}

function code(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return error instanceof AgentOpsError ? error.code : String(error);
  }
  return undefined;
}

test("select-tree: active subtasks in creation order, then the parent; nothing else", () => {
  const records = [
    record("late", { parent: "p", createdAt: "2026-09-30T03:00:00.000Z" }),
    record("p", { createdAt: "2026-09-30T01:00:00.000Z" }),
    record("early", { parent: "p", createdAt: "2026-09-30T02:00:00.000Z" }),
    record("done", { parent: "p", status: "complete" }),
    record("shelved", { parent: "p", status: "archived" }),
    record("other-child", { parent: "q" }),
    record("q"),
    record("loose")
  ];
  assert.deepEqual(selectBatchTasks(records, "p").map((item) => item.task.id), ["early", "late", "p"]);
  assert.deepEqual(selectBatchTasks([record("solo")], "solo").map((item) => item.task.id), ["solo"]);
});

test("select-errors: an unknown or inactive parent is rejected with its own code", () => {
  const records = [record("p", { status: "complete" }), record("child", { parent: "p" })];
  assert.equal(code(() => selectBatchTasks(records, "missing")), "BATCH_PARENT_NOT_FOUND");
  assert.equal(code(() => selectBatchTasks(records, "p")), "BATCH_PARENT_NOT_ACTIVE");
  assert.equal(code(() => selectBatchTasks([record("p", { status: "archived" })], "p")), "BATCH_PARENT_NOT_ACTIVE");
});

test("base-precedence: flag, then recorded reviewBase, then worktree base; parent uses its own flag", () => {
  const recorded = record("a", { reviewBase: "rec" });
  const fresh = record("b");
  const input = { base: "flag", parentBase: "pflag", worktreeBase: "wt" };
  assert.deepEqual(resolveBatchBase(recorded, false, input), { base: "flag", source: "flag" });
  assert.deepEqual(resolveBatchBase(recorded, false, { worktreeBase: "wt" }), { base: "rec", source: "recorded" });
  assert.deepEqual(resolveBatchBase(fresh, false, { worktreeBase: "wt" }), { base: "wt", source: "worktree" });
  // --base never reaches the parent, and --parent-base never reaches a subtask.
  assert.deepEqual(resolveBatchBase(fresh, true, { base: "flag", worktreeBase: "wt" }), { base: "wt", source: "worktree" });
  assert.deepEqual(resolveBatchBase(recorded, true, { base: "flag", parentBase: "pflag" }), { base: "pflag", source: "flag" });
  assert.deepEqual(resolveBatchBase(recorded, false, { parentBase: "pflag" }), { base: "rec", source: "recorded" });
  assert.equal(code(() => resolveBatchBase(fresh, false, {})), "BATCH_BASE_UNKNOWN");
  assert.equal(code(() => resolveBatchBase(fresh, true, { base: "flag" })), "BATCH_BASE_UNKNOWN");
});
