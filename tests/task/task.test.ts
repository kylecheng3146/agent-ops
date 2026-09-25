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
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import { COMPLETION_CONFIG, completionContext, passingCompletionEvidence } from "./completion-fixture.js";

function input(title = "Ship the task state"): CreateTaskInput {
  return {
    title,
    policyConfigHash: calculateConfigHash(COMPLETION_CONFIG),
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
      now: () => "2026-07-23T12:00:00.000Z",
      completion: completionContext(root)
    }
  );
}

test("task creation can atomically attach its session", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-"));
  try {
    const tasks = service(root);
    const created = await tasks.create({ ...input(), sessionId: "session-one" });
    assert.equal(
      (await tasks.status({ sessionId: "session-one" })).task.id,
      created.task.id
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

    const references = await passingCompletionEvidence(root, created);
    const completed = await tasks.complete(created.task.id, references);
    assert.equal(completed.status, "complete");
    assert.equal(
      completed.evidence["criterion-create"]?.[0],
      references["criterion-create"]?.[0]
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
    assert.ok(markdown.includes(references["criterion-complete"]![0]!));
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

test("reads schema version 1 task records created before failure fingerprints", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-"));
  const statePath = join(root, ".agent-ops", "tasks", "state.json");
  try {
    await mkdir(join(root, ".agent-ops", "tasks"), {
      recursive: true
    });
    await writeFile(
      statePath,
      `${JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            task: {
              schemaVersion: 1,
              id: "task-legacy",
              title: "Legacy task state",
              criteria: input().criteria
            },
            status: "active",
            evidence: {},
            createdAt: "2026-07-22T12:00:00.000Z",
            updatedAt: "2026-07-22T12:00:00.000Z",
            completedAt: null,
            archivedAt: null
          }
        ],
        sessions: []
      }, null, 2)}\n`
    );

    const records = await service(root).list();

    assert.equal(records[0]?.task.id, "task-legacy");
    assert.equal(records[0]?.failureFingerprint, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subtasks record their parent and stay independently completable", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-"));
  try {
    let next = 0;
    const tasks = service(root, () => `task-${(next += 1)}`);
    const parent = await tasks.create(input("Parent work"));
    const child = await tasks.create({
      ...input("Subtask work"),
      parentTaskId: parent.task.id
    });
    const unrelated = await tasks.create(input("Unrelated work"));

    assert.equal(child.task.parentTaskId, parent.task.id);
    assert.equal(parent.task.parentTaskId, undefined);
    assert.deepEqual(
      (await tasks.list({ parentTaskId: parent.task.id })).map(
        (record) => record.task.id
      ),
      [child.task.id]
    );
    assert.equal((await tasks.list()).length, 3);
    assert.equal(
      (await tasks.list({ parentTaskId: unrelated.task.id })).length,
      0
    );

    // Completing a subtask leaves the parent exactly as it was: the split is
    // tracking only, never a completion side effect.
    await tasks.complete(child.task.id, await passingCompletionEvidence(root, child));
    const parentAfter = await tasks.status({ taskId: parent.task.id });
    assert.equal(parentAfter.status, "active");
    assert.deepEqual(parentAfter.evidence, {});
    assert.match(await tasks.export(child.task.id), /^Parent task: task-1$/m);
    assert.doesNotMatch(await tasks.export(parent.task.id), /Parent task:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a subtask requires a known, unarchived parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-"));
  try {
    let next = 0;
    const tasks = service(root, () => `task-${(next += 1)}`);
    await assert.rejects(
      tasks.create({ ...input(), parentTaskId: "task-missing" }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_PARENT_NOT_FOUND"
    );

    const parent = await tasks.create(input("Parent work"));
    await tasks.archive(parent.task.id);
    await assert.rejects(
      tasks.create({ ...input(), parentTaskId: parent.task.id }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_PARENT_NOT_ACTIVE"
    );
    // The rejected creations left nothing behind.
    assert.equal((await tasks.list()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task state written before subtasks existed still loads", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-"));
  const statePath = join(root, ".agent-ops", "tasks", "state.json");
  try {
    await mkdir(join(root, ".agent-ops", "tasks"), { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            task: {
              schemaVersion: 1,
              id: "task-legacy",
              title: "Legacy task state",
              criteria: input().criteria
            },
            status: "active",
            evidence: {},
            createdAt: "2026-07-22T12:00:00.000Z",
            updatedAt: "2026-07-22T12:00:00.000Z",
            completedAt: null,
            archivedAt: null
          }
        ],
        sessions: []
      }, null, 2)}\n`
    );

    const tasks = service(root);
    const records = await tasks.list();
    assert.equal(records[0]?.task.parentTaskId, undefined);
    // A parent filter must not sweep in parentless legacy records.
    assert.equal((await tasks.list({ parentTaskId: "task-legacy" })).length, 0);
    // The legacy record is still a usable parent, and rewriting the file with a
    // subtask alongside it keeps both readable.
    const child = await tasks.create({
      ...input("Subtask of legacy"),
      parentTaskId: "task-legacy"
    });
    assert.deepEqual(
      (await tasks.list({ parentTaskId: "task-legacy" })).map(
        (record) => record.task.id
      ),
      [child.task.id]
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

test("the task CLI creates subtasks and lists them by parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-"));
  try {
    let next = 0;
    const tasks = service(root, () => `task-${(next += 1)}`);
    const criterionArgs = [
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
    ];
    const create = async (extra: readonly string[] = []) =>
      await runTaskCommand({
        args: parseArgs([
          "task", "create", "--title", "CLI task", ...criterionArgs, ...extra
        ]),
        service: tasks
      });

    await create();
    const child = await create(["--parent", "task-1"]);
    assert.equal(child.code, "TASK_CREATED");
    assert.equal(child.data?.record?.task.parentTaskId, "task-1");
    assert.match(child.data?.text ?? "", /^Parent task: task-1$/m);

    const listed = await runTaskCommand({
      args: parseArgs(["task", "status", "--parent", "task-1"]),
      service: tasks
    });
    assert.equal(listed.code, "TASK_LISTED");
    assert.equal(listed.data?.message, "Listed 1 subtask(s) of task-1.");
    assert.deepEqual(
      listed.data?.records?.map((record) => record.task.id),
      ["task-2"]
    );

    const missingParent = await runTaskCommand({
      args: parseArgs([
        "task", "create", "--title", "Orphan", ...criterionArgs,
        "--parent", "task-absent"
      ]),
      service: tasks
    });
    assert.equal(missingParent.code, "TASK_PARENT_NOT_FOUND");
    assert.equal(missingParent.status, "error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a subtask keeps the session attached to the top of its tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-attach-"));
  try {
    let next = 0;
    const tasks = service(root, () => `task-${++next}`);
    await tasks.create({ ...input("Parent"), sessionId: "session-one" });
    const child = await tasks.create({ ...input("Child"), parentTaskId: "task-1", sessionId: "session-one" });
    await tasks.create({ ...input("Grandchild"), parentTaskId: child.task.id, sessionId: "session-one" });
    assert.equal((await tasks.status({ sessionId: "session-one" })).task.id, "task-1");

    // A session that had nothing attached lands on the tree's top, too.
    await tasks.create({ ...input("Other child"), parentTaskId: "task-1", sessionId: "session-two" });
    assert.equal((await tasks.status({ sessionId: "session-two" })).task.id, "task-1");

    const message = await runTaskCommand({
      args: parseArgs(["task", "create", "--title", "Via CLI", "--parent", "task-1",
        "--criterion", JSON.stringify({ id: "one", description: "One.", verifierIds: ["unit"] }),
        "--criterion", JSON.stringify({ id: "two", description: "Two.", verifierIds: ["unit"] })]),
      service: tasks,
      sessionId: "session-one"
    });
    assert.match(message.data?.message ?? "", /^Created subtask task-5; the session stays on the top of its task tree\.$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review evidence records, keeps and clears the review base", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-review-base-"));
  try {
    const tasks = service(root);
    const created = await tasks.create(input());
    const criterion = created.task.criteria[0]!.id;
    const base = "a".repeat(40);
    await tasks.recordEvidence(created.task.id, { [criterion]: ["review:agy:one"] }, base);
    // A fresh service reads it back through the store's parser.
    assert.equal((await service(root).status({ taskId: created.task.id })).reviewBase, base);
    await tasks.recordEvidence(created.task.id, { [criterion]: ["review:agy:two"] });
    assert.equal((await service(root).status({ taskId: created.task.id })).reviewBase, base);
    await tasks.recordEvidence(created.task.id, { [criterion]: ["review:agy:three"] }, null);
    assert.equal("reviewBase" in await service(root).status({ taskId: created.task.id }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task create in worktree auto mode lands in the session's worktree", async () => {
  const main = await mkdtemp(join(tmpdir(), "agent-ops-task-main-"));
  const worktree = await mkdtemp(join(tmpdir(), "agent-ops-task-worktree-"));
  try {
    const mainTasks = service(main);
    const worktreeTasks = service(worktree);
    const sessions: string[] = [];
    const args = parseArgs([
      "task", "create", "--title", "Worktree task",
      "--criterion", JSON.stringify({ id: "one", description: "One.", verifierIds: ["unit"] }),
      "--criterion", JSON.stringify({ id: "two", description: "Two.", verifierIds: ["unit"] })
    ]);
    const sessionWorktree = async (sessionId: string) => {
      sessions.push(sessionId);
      return { service: worktreeTasks, path: worktree, base: "abc123" };
    };

    const result = await runTaskCommand({
      args, service: mainTasks, sessionId: "session-one", sessionWorktree
    });
    assert.equal(result.code, "TASK_CREATED");
    assert.deepEqual(sessions, ["session-one"]);
    assert.equal((await worktreeTasks.list()).length, 1);
    assert.equal((await mainTasks.list()).length, 0);
    const text = result.data?.text ?? "";
    assert.ok(text.includes(`- Claude Code: EnterWorktree with path ${worktree}\n`), text);
    assert.match(text, /run verify and review there with --base abc123;/u);
    assert.match(text, /agent-ops worktree finish from the main checkout, which completes the task and merges/u);
    assert.doesNotMatch(text, /task complete/u);
    assert.match(text, /^# Worktree task$/mu);

    // Without a session there is no worktree to bind, so nothing moves.
    const anonymous = await runTaskCommand({ args, service: mainTasks, sessionWorktree });
    assert.equal(anonymous.code, "TASK_CREATED");
    assert.deepEqual(sessions, ["session-one"]);
    assert.equal((await mainTasks.list()).length, 1);
  } finally {
    await rm(main, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
});
