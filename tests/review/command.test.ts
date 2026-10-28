import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { runReviewCommand } from "../../packages/cli/src/commands/review.js";
import { REVIEW_ATTESTATION_DIRECTORY } from "../../runtime/src/review/attestation.js";
import { taskContractHash } from "../../runtime/src/task/contract.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { reportFor } from "./report-fixture.js";

test("review command returns an error envelope when review is not run", async () => {
  const envelope = await runReviewCommand({
    args: parseArgs(["review", "--task", "task-one", "--yes", "--json"]),
    authorized: false
  });
  assert.equal(envelope.status, "error");
  assert.equal(envelope.code, "REVIEW_NOT_RUN");
  assert.equal(envelope.data?.result.status, "NOT_RUN");
  assert.match(envelope.data?.text ?? "", /authorization-required/);
});

test("a third failed review under one contract stops review before any reviewer runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-round-cap-"));
  try {
    const tasks = new TaskService(new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root));
    const { task } = await tasks.create({
      title: "Converge", criteria: [
        { id: "tests", description: "Tests pass.", verifierIds: ["unit"] },
        { id: "scope", description: "No unrelated files changed.", verifierIds: ["unit"] }
      ]
    });
    await tasks.attach("session-cap", task.id);
    const directory = join(root, ...REVIEW_ATTESTATION_DIRECTORY.split("/"));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fail = async (n: number) => {
      const fingerprint = n.toString(16).padStart(64, "0");
      await writeFile(join(directory, `${fingerprint}.${task.id}.reports.json`), JSON.stringify({
        schemaVersion: 2, sourceFingerprint: fingerprint, taskId: task.id, status: "FAIL", harness: "codex",
        plannedTargets: ["codex", "codex"], attempts: [], preflight: [], taskContractHash: taskContractHash(task),
        report: reportFor([{ id: "tests" }, { id: "scope" }], "FAIL"), createdAt: `2026-09-0${n}T00:00:00.000Z`
      }), { mode: 0o600 });
    };
    let executed = 0;
    const review = () => runReviewCommand({
      args: parseArgs(["review", "--task", task.id, "--yes"]), authorized: true, tasks, sessionId: "session-cap", root,
      execute: async () => { executed += 1; return { status: "NOT_RUN", reason: "missing-cli" }; }
    });
    await fail(1);
    await fail(2);
    await review();
    assert.equal(executed, 1, "two failed rounds still review");

    await fail(3);
    const capped = await review();
    assert.equal(executed, 1, "no reviewer runs at the cap");
    assert.equal(capped.code, "REVIEW_NOT_RUN");
    assert.equal(capped.data?.result.status, "NOT_RUN");
    assert.equal(capped.data?.result.reason, "round-cap");
    assert.match(capped.data?.text ?? "", /round-cap/);
    assert.match(capped.data?.text ?? "", /agent-ops task revise --task \S+ --expected-contract [a-f0-9]{64} --reason/);
    assert.match(capped.data?.text ?? "", /ask the user/);

    await tasks.revise(task.id, {
      expectedContractHash: taskContractHash(task), reason: "New approach.",
      criteria: [
        { id: "tests", description: "Tests pass with the new design.", verifierIds: ["unit"] },
        { id: "scope", description: "No unrelated files changed.", verifierIds: ["unit"] }
      ]
    });
    await review();
    assert.equal(executed, 2, "a revised contract reviews again");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic review resolves configured role metadata", async () => {
  const envelope = await runReviewCommand({
    args: parseArgs(["review", "--task", "task-one", "--yes"]),
    authorized: true,
    role: "independent-review",
    roles: [{
      role: "independent-review",
      targets: ["claude"],
      model: "review-model",
      effort: "high"
    }],
    execute: async () => ({ status: "NOT_RUN", reason: "missing-cli" })
  });
  assert.equal(envelope.status, "error");
  assert.match(envelope.data?.text ?? "", /claude|review-model|high/);
  assert.match(envelope.data?.result.prompt ?? "", /change-quality/);
});

test("the configured pair is passed to the review executor", async () => {
  let planned: readonly string[] | undefined;
  const envelope = await runReviewCommand({
    args: parseArgs(["review", "--task", "task-one", "--yes"]),
    authorized: true,
    roles: [{
      role: "independent-review",
      targets: ["codex", "claude"],
      model: "review-model",
      effort: "high",
      timeoutMs: 42_000
    }],
    execute: async (request) => {
      planned = request.invocation.plannedTargets;
      return { status: "NOT_RUN", reason: "missing-cli" };
    }
  });

  assert.deepEqual(planned, ["codex", "claude"]);
  assert.equal(envelope.data?.result.harness, "codex");
  assert.deepEqual(envelope.data?.result.plannedTargets, ["codex", "claude"]);
  assert.match(envelope.data?.text ?? "", /Planned reviewers: codex → claude/);
});

test("an empty configured target set remains not run", async () => {
  let called = false;
  const envelope = await runReviewCommand({
    args: parseArgs(["review", "--task", "task-one", "--yes"]),
    authorized: true,
    roles: [],
    execute: async () => {
      called = true;
      return { status: "NOT_RUN", reason: "missing-cli" };
    }
  });
  assert.equal(envelope.code, "REVIEW_NOT_RUN");
  assert.equal(called, true);
});

test("partial review options are rejected for the complete review", () => {
  assert.throws(
    () => parseArgs(["review", "--task", "task-one", "--yes", "--criterion", "change-quality"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CLI_OPTION_NOT_ALLOWED"
  );
});
