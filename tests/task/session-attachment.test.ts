import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";

function service(root: string): TaskService {
  let sequence = 0;
  return new TaskService(
    new FileTaskStore(
      join(root, ".agent-ops", "tasks", "state.json"),
      root
    ),
    {
      generateId: () => `task-${++sequence}`,
      now: () => "2026-07-23T12:00:00.000Z"
    }
  );
}

async function createTask(
  tasks: TaskService,
  title: string
): Promise<string> {
  return (
    await tasks.create({
      title,
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
    })
  ).task.id;
}

test("requires explicit attachment and supports concurrent sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-session-"));
  try {
    const tasks = service(root);
    const taskId = await createTask(tasks, "Shared task");

    await assert.rejects(
      tasks.status({ sessionId: "session-new" }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_SESSION_UNATTACHED"
    );

    await tasks.attach("session-one", taskId);
    await tasks.attach("session-two", taskId);
    assert.equal(
      (await tasks.status({ sessionId: "session-one" })).task.id,
      taskId
    );
    assert.equal(
      (await tasks.status({ sessionId: "session-two" })).task.id,
      taskId
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one session switches explicitly and historical tasks never auto-attach", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-session-"));
  try {
    const tasks = service(root);
    const firstId = await createTask(tasks, "First task");
    const secondId = await createTask(tasks, "Second task");

    await tasks.attach("session-one", firstId);
    await tasks.attach("session-one", secondId);
    assert.equal(
      (await tasks.status({ sessionId: "session-one" })).task.id,
      secondId
    );
    assert.equal(
      (await tasks.status({ taskId: firstId })).task.id,
      firstId
    );
    await assert.rejects(
      tasks.status({ sessionId: "session-future" }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_SESSION_UNATTACHED"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archiving detaches sessions and archived tasks cannot be attached", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-session-"));
  try {
    const tasks = service(root);
    const taskId = await createTask(tasks, "Archived task");
    await tasks.attach("session-one", taskId);
    await tasks.archive(taskId);

    await assert.rejects(
      tasks.status({ sessionId: "session-one" }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_SESSION_UNATTACHED"
    );
    await assert.rejects(
      tasks.attach("session-two", taskId),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_NOT_ACTIVE"
    );
    assert.equal(
      (await tasks.status({ taskId })).status,
      "archived"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
