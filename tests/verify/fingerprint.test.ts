import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import {
  advanceFailureFingerprint,
  createFailureFingerprint
} from "../../runtime/src/verify/fingerprint.js";

const SECRET = `sk-${"a".repeat(24)}`;

test("creates stable bounded fingerprints without raw diagnostics", () => {
  const first = createFailureFingerprint({
    commandId: "unit",
    failureClass: "nonzero-exit",
    exitCategory: "exit-1",
    diagnostics: `token=${SECRET}\n${"detail ".repeat(200)}`
  });
  const second = createFailureFingerprint({
    commandId: "unit",
    failureClass: "nonzero-exit",
    exitCategory: "exit-1",
    diagnostics: `token=sk-${"b".repeat(24)}\n${"detail ".repeat(200)}`
  });

  assert.equal(first.value, second.value);
  assert.match(first.value, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(SECRET));
  assert.ok(Buffer.byteLength(first.diagnostics, "utf8") <= 512);
  assert.match(first.diagnostics, /\[REDACTED_VALUE\]/);
});

test("the second consecutive match requires a change of approach", () => {
  const failure = createFailureFingerprint({
    commandId: "unit",
    failureClass: "timeout",
    exitCategory: "timeout",
    diagnostics: "test command timed out"
  });
  const first = advanceFailureFingerprint(
    null,
    failure,
    "2026-07-23T12:00:00.000Z"
  );
  assert.equal(first.state.consecutive, 1);
  assert.equal(first.signal, null);

  const second = advanceFailureFingerprint(
    first.state,
    failure,
    "2026-07-23T12:01:00.000Z"
  );
  assert.equal(second.state.consecutive, 2);
  assert.equal(second.signal, "CHANGE_APPROACH_REQUIRED");
});

test("a different failure resets the consecutive count", () => {
  const firstFailure = createFailureFingerprint({
    commandId: "unit",
    failureClass: "timeout",
    exitCategory: "timeout",
    diagnostics: "timeout"
  });
  const nextFailure = createFailureFingerprint({
    commandId: "lint",
    failureClass: "nonzero-exit",
    exitCategory: "exit-2",
    diagnostics: "lint failed"
  });
  const first = advanceFailureFingerprint(
    null,
    firstFailure,
    "2026-07-23T12:00:00.000Z"
  );
  const changed = advanceFailureFingerprint(
    first.state,
    nextFailure,
    "2026-07-23T12:01:00.000Z"
  );

  assert.equal(changed.state.consecutive, 1);
  assert.equal(changed.state.value, nextFailure.value);
  assert.equal(changed.signal, null);
});

test("persists per-task repetition state without changing task requirements", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-fingerprint-"));
  try {
    const tasks = new TaskService(
      new FileTaskStore(
        join(root, ".agent-ops", "tasks", "state.json"),
        root
      ),
      {
        generateId: () => "task-one",
        now: () => "2026-07-23T12:00:00.000Z"
      }
    );
    const created = await tasks.create({
      title: "Keep requirements stable",
      criteria: [
        {
          id: "criterion-one",
          description: "First outcome.",
          verifierIds: ["unit"]
        },
        {
          id: "criterion-two",
          description: "Second outcome.",
          verifierIds: ["unit"]
        }
      ]
    });
    const originalTask = structuredClone(created.task);
    const failure = createFailureFingerprint({
      commandId: "unit",
      failureClass: "nonzero-exit",
      exitCategory: "exit-1",
      diagnostics: "failed"
    });

    assert.equal(
      (await tasks.recordFailure(created.task.id, failure)).signal,
      null
    );
    assert.equal(
      (await tasks.recordFailure(created.task.id, failure)).signal,
      "CHANGE_APPROACH_REQUIRED"
    );
    const status = await tasks.status({ taskId: created.task.id });
    assert.deepEqual(status.task, originalTask);
    assert.equal(status.failureFingerprint?.consecutive, 2);

    await tasks.clearFailure(created.task.id);
    assert.equal(
      (await tasks.status({ taskId: created.task.id }))
        .failureFingerprint,
      null
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
