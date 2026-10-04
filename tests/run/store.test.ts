import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { RunStore } from "../../runtime/src/run/store.js";
import { createRunState } from "../../runtime/src/run/types.js";

test("RunStore atomically creates and CAS updates durable native state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-run-store-"));
  try {
    const store = new RunStore(root, { now: () => new Date("2026-10-04T00:00:00Z") });
    const created = await store.create(createRunState({
      runId: "run-1",
      coordinatorId: "coordinator-1",
      originalGoal: "finish the task with evidence",
      worktree: root,
      now: new Date("2026-10-04T00:00:00Z")
    }));
    assert.equal(created.revision, 0);
    const updated = await store.update(created.runId, 0, (state) => ({
      ...state,
      status: "running"
    }));
    assert.equal(updated.revision, 1);
    assert.equal((await store.read("run-1"))?.status, "running");
    await assert.rejects(
      store.update("run-1", 0, (state) => state),
      (error: unknown) => error instanceof AgentOpsError && error.code === "RUN_STATE_CONFLICT"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RunStore rejects malformed state instead of treating native completion as proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-run-store-invalid-"));
  try {
    const store = new RunStore(root);
    const state = createRunState({
      runId: "run-2",
      coordinatorId: "coordinator-1",
      originalGoal: "goal",
      worktree: root
    });
    await store.create(state);
    const path = store.path(state.runId);
    // An invalid objective hash would make a state file unverifiable.
    await assert.rejects(
      store.update(state.runId, 0, (current) => ({
        ...current,
        originalGoalHash: "0".repeat(64)
      })),
      (error: unknown) => error instanceof AgentOpsError && error.code === "RUN_STATE_INVALID"
    );
    assert.equal(path.endsWith("state.json"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
