import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { runTaskCommand } from "../../packages/cli/src/commands/task.js";
import { writeEnvelope } from "../../packages/cli/src/output.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import {
  TaskService,
  type CreateTaskInput
} from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";

function input(title = "Ship the task state"): CreateTaskInput {
  return {
    title,
    criteria: [
      {
        id: "criterion-create",
        description: "The task can be created.",
        verifierIds: ["unit"]
      },
      {
        id: "criterion-complete",
        description: "Completion requires evidence.",
        verifierIds: ["unit"]
      }
    ]
  };
}

function service(
  root: string,
  generateId: () => string = () => "task-generated"
): TaskService {
  return new TaskService(
    new FileTaskStore(
      join(root, ".agent-ops", "tasks", "state.json"),
      root
    ),
    {
      generateId,
      now: () => "2026-07-23T12:00:00.000Z"
    }
  );
}

test("creates, completes, archives, and exports structured task state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-"));
  try {
    const tasks = service(root);
    const created = await tasks.create(input());
    assert.equal(created.task.id, "task-generated");
    assert.equal(created.status, "active");

    await assert.rejects(
      tasks.complete(created.task.id, {
        "criterion-create": ["evidence/create.json"]
      }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_EVIDENCE_INCOMPLETE"
    );
    await assert.rejects(
      tasks.complete(created.task.id, {
        "criterion-create": [],
        "criterion-complete": ["evidence/complete.json"]
      }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_EVIDENCE_INCOMPLETE"
    );
    await assert.rejects(
      tasks.complete(created.task.id, {
        "criterion-create": ["evidence/create.json"],
        "criterion-complete": ["evidence/complete.json"],
        "criterion-unknown": ["evidence/unknown.json"]
      }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_EVIDENCE_INCOMPLETE"
    );

    const completed = await tasks.complete(created.task.id, {
      "criterion-create": ["evidence/create.json"],
      "criterion-complete": ["evidence/complete.json"]
    });
    assert.equal(completed.status, "complete");
    assert.equal(
      completed.evidence["criterion-create"]?.[0],
      "evidence/create.json"
    );

    const statePath = join(
      root,
      ".agent-ops",
      "tasks",
      "state.json"
    );
    const stateIdentity = (await lstat(statePath, { bigint: true })).ino;
    const markdown = await tasks.export(created.task.id);
    assert.match(markdown, /^# Ship the task state$/m);
    assert.match(markdown, /Status: complete/);
    assert.match(markdown, /evidence\/complete\.json/);
    if (process.platform !== "win32") {
      assert.equal(
        (await lstat(statePath, { bigint: true })).ino,
        stateIdentity
      );
    }

    const archived = await tasks.archive(created.task.id);
    assert.equal(archived.status, "archived");
    assert.equal(
      (await tasks.status({ taskId: created.task.id })).status,
      "archived"
    );
    const archivedMarkdown = await tasks.export(created.task.id);
    assert.match(archivedMarkdown, /Status: archived/);
    assert.match(
      archivedMarkdown,
      /Archived: 2026-07-23T12:00:00.000Z/
    );
    assert.equal(
      await tasks.export(created.task.id),
      archivedMarkdown
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enforces two to five valid acceptance criteria", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-"));
  try {
    const tasks = service(root);
    await assert.rejects(
      tasks.create({ title: "Too small", criteria: [input().criteria[0]] }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_INVALID"
    );
    await assert.rejects(
      tasks.create({
        title: "Too large",
        criteria: Array.from({ length: 6 }, (_, index) => ({
          id: `criterion-${index}`,
          description: `Criterion ${index}`,
          verifierIds: ["unit"]
        }))
      }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_INVALID"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent writers without losing tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-"));
  try {
    const storePath = join(root, ".agent-ops", "tasks", "state.json");
    let firstSequence = 0;
    let secondSequence = 0;
    const first = new TaskService(
      new FileTaskStore(storePath, root),
      {
        generateId: () => `task-a-${++firstSequence}`,
        now: () => "2026-07-23T12:00:00.000Z"
      }
    );
    const second = new TaskService(
      new FileTaskStore(storePath, root),
      {
        generateId: () => `task-b-${++secondSequence}`,
        now: () => "2026-07-23T12:00:00.000Z"
      }
    );

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).create(
          input(`Task ${index}`)
        )
      )
    );

    assert.equal((await first.list()).length, 20);
    if (process.platform !== "win32") {
      assert.equal(
        (await lstat(join(root, ".agent-ops", "tasks"))).mode & 0o777,
        0o700
      );
      assert.equal((await lstat(storePath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for malformed and oversized task state", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-"));
  const statePath = join(root, ".agent-ops", "tasks", "state.json");
  try {
    await mkdir(join(root, ".agent-ops", "tasks"), {
      recursive: true
    });
    await writeFile(statePath, "{broken");
    await assert.rejects(
      service(root).list(),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_STATE_INVALID"
    );

    await writeFile(statePath, "x".repeat(1024 * 1024 + 1));
    await assert.rejects(
      service(root).list(),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_STATE_TOO_LARGE"
    );
    assert.equal(
      (await readFile(statePath)).byteLength,
      1024 * 1024 + 1
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task command returns stable human and JSON views", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-"));
  try {
    const tasks = service(root);
    const args = parseArgs([
      "task",
      "create",
      "--title",
      "CLI task",
      "--criterion",
      JSON.stringify({
        id: "criterion-one",
        description: "First CLI outcome.",
        verifierIds: ["unit"]
      }),
      "--criterion",
      JSON.stringify({
        id: "criterion-two",
        description: "Second CLI outcome.",
        verifierIds: ["unit"]
      })
    ]);
    const result = await runTaskCommand({ args, service: tasks });
    assert.equal(result.code, "TASK_CREATED");
    assert.equal(result.status, "ok");
    assert.match(result.data?.text ?? "", /^# CLI task$/m);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const sink = {
      writeStdout: (value: string) => stdout.push(value),
      writeStderr: (value: string) => stderr.push(value)
    };
    writeEnvelope(sink, result, true);
    assert.equal(stderr.length, 0);
    const json = JSON.parse(stdout.join("")) as {
      code: string;
      data: { record: { task: { id: string } } };
    };
    assert.equal(json.code, "TASK_CREATED");
    assert.equal(json.data.record.task.id, "task-generated");

    stdout.length = 0;
    writeEnvelope(sink, result, false);
    assert.match(stdout.join(""), /^# CLI task$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
