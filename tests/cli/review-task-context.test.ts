import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { runReviewCommand } from "../../packages/cli/src/commands/review.js";
import type { ReviewExecutionRequest } from "../../runtime/src/review/runner.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";

const SESSION = "session-review";

function service(root: string): TaskService {
  let sequence = 0;
  return new TaskService(
    new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root),
    {
      generateId: () => `task-${++sequence}`,
      now: () => "2026-08-12T03:00:00.000Z"
    }
  );
}

async function withTask(
  attach: boolean
): Promise<{ readonly root: string; readonly tasks: TaskService }> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-review-"));
  const tasks = service(root);
  const record = await tasks.create({
    title: "Ship the reviewer",
    criteria: [
      {
        id: "tests",
        description: "The test suite passes.",
        verifierIds: ["unit"]
      },
      {
        id: "scope",
        description: "No unrelated files changed.",
        verifierIds: ["diff"]
      }
    ]
  });
  if (attach) {
    await tasks.attach(SESSION, record.task.id);
  }
  return { root, tasks };
}

function passing(request: ReviewExecutionRequest) {
  return {
    status: "PASS" as const,
    results: request.invocation.packet.criteria.map((criterion) => ({
      criterionId: criterion.id,
      status: "PASS" as const,
      evidence: [`inspected ${criterion.id}`]
    }))
  };
}

test("criterion descriptions and verifiers come from the bound task", async () => {
  const { root, tasks } = await withTask(true);
  try {
    let seen: ReviewExecutionRequest | undefined;
    const envelope = await runReviewCommand({
      args: parseArgs(["review", "--yes"]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      execute: async (request) => {
        seen = request;
        return passing(request);
      }
    });
    assert.equal(envelope.status, "ok");
    assert.deepEqual(
      seen?.invocation.packet.criteria.map((criterion) => criterion.description),
      ["The test suite passes.", "No unrelated files changed."]
    );
    assert.deepEqual(seen?.invocation.packet.criteria[0]?.verifierIds, ["unit"]);
    assert.match(envelope.data?.result.prompt ?? "", /The test suite passes\./);
    assert.match(envelope.data?.result.prompt ?? "", /machine-verified by: unit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--criterion filters the bound task and rejects unknown ids", async () => {
  const { root, tasks } = await withTask(true);
  try {
    const filtered = await runReviewCommand({
      args: parseArgs(["review", "--yes", "--criterion", "scope"]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      execute: async (request) => passing(request)
    });
    assert.equal(filtered.status, "ok");
    assert.deepEqual(
      filtered.data?.result.results?.map((item) => item.criterionId),
      ["scope"]
    );

    const unknown = await runReviewCommand({
      args: parseArgs(["review", "--yes", "--criterion", "nope"]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      execute: async (request) => passing(request)
    });
    assert.equal(unknown.status, "error");
    assert.equal(unknown.code, "REVIEW_NOT_RUN");
    assert.equal(unknown.data?.result.reason, "no-task-context");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no bound task reports no-task-context and spawns nothing", async () => {
  const { root, tasks } = await withTask(false);
  try {
    let calls = 0;
    const envelope = await runReviewCommand({
      args: parseArgs(["review", "--yes"]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      execute: async (request) => {
        calls += 1;
        return passing(request);
      }
    });
    assert.equal(envelope.status, "error");
    assert.equal(envelope.data?.result.status, "NOT_RUN");
    assert.equal(envelope.data?.result.reason, "no-task-context");
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence for an active task is prefixed with the review target", async () => {
  const { root, tasks } = await withTask(true);
  try {
    await runReviewCommand({
      args: parseArgs(["review", "--yes"]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      execute: async (request) => passing(request)
    });
    const record = await tasks.status({ sessionId: SESSION });
    assert.deepEqual(Object.keys(record.evidence).sort(), ["scope", "tests"]);
    for (const references of Object.values(record.evidence)) {
      for (const reference of references) {
        assert.match(reference, /^review:codex:/);
      }
    }
    assert.equal(record.status, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a completed task is printed but never written to", async () => {
  const { root, tasks } = await withTask(true);
  try {
    const record = await tasks.status({ sessionId: SESSION });
    const completed = await tasks.complete(record.task.id, {
      tests: ["npm test"],
      scope: ["git diff"]
    });
    const envelope = await runReviewCommand({
      args: parseArgs(["review", "--yes"]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      taskId: completed.task.id,
      execute: async (request) => passing(request)
    });
    assert.equal(envelope.status, "ok");
    const after = await tasks.status({ taskId: completed.task.id });
    assert.deepEqual(after.evidence, completed.evidence);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("without --yes nothing is spawned and no evidence is written", async () => {
  const { root, tasks } = await withTask(true);
  try {
    let calls = 0;
    const envelope = await runReviewCommand({
      args: parseArgs(["review"]),
      authorized: false,
      tasks,
      sessionId: SESSION,
      execute: async (request) => {
        calls += 1;
        return passing(request);
      }
    });
    assert.equal(envelope.data?.result.reason, "authorization-required");
    assert.equal(calls, 0);
    const record = await tasks.status({ sessionId: SESSION });
    assert.deepEqual(record.evidence, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a not-run review points the operator at doctor", async () => {
  const { root, tasks } = await withTask(true);
  try {
    const envelope = await runReviewCommand({
      args: parseArgs(["review", "--yes"]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      execute: async () => ({
        status: "NOT_RUN",
        reason: "missing-cli" as const
      })
    });
    assert.equal(envelope.status, "error");
    assert.match(envelope.data?.text ?? "", /agent-ops doctor --check-auth/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
