import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { runReviewCommand } from "../../packages/cli/src/commands/review.js";

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
