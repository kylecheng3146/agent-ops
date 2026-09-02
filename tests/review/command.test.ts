import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { runReviewCommand } from "../../packages/cli/src/commands/review.js";

test("review command returns an error envelope when review is not run", async () => {
  const envelope = await runReviewCommand({
    args: parseArgs(["review", "--json"]),
    authorized: false
  });
  assert.equal(envelope.status, "error");
  assert.equal(envelope.code, "REVIEW_NOT_RUN");
  assert.equal(envelope.data?.result.status, "NOT_RUN");
  assert.match(envelope.data?.text ?? "", /authorization-required/);
});

test("generic review resolves configured role metadata", async () => {
  const envelope = await runReviewCommand({
    args: parseArgs(["review", "--yes"]),
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

test("an explicit configured harness narrows the planned review chain", async () => {
  let planned: readonly string[] | undefined;
  const envelope = await runReviewCommand({
    args: parseArgs(["review", "--harness", "claude", "--yes"]),
    authorized: true,
    roles: [{
      role: "independent-review",
      targets: ["codex", "claude"],
      model: "review-model",
      effort: "high",
      timeoutMs: 42_000
    }],
    targets: ["claude"],
    execute: async (request) => {
      planned = request.invocation.plannedTargets;
      return { status: "NOT_RUN", reason: "missing-cli" };
    }
  });

  assert.deepEqual(planned, ["claude"]);
  assert.equal(envelope.data?.result.harness, "claude");
  assert.deepEqual(envelope.data?.result.plannedTargets, ["claude"]);
  assert.match(envelope.data?.text ?? "", /Planned reviewers: claude/);
});

test("an explicit unconfigured harness is rejected before review", async () => {
  let called = false;
  await assert.rejects(
    runReviewCommand({
      args: parseArgs(["review", "--harness", "claude", "--yes"]),
      authorized: true,
      roles: [{ role: "independent-review", targets: ["codex"] }],
      execute: async () => {
        called = true;
        return { status: "NOT_RUN", reason: "missing-cli" };
      }
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "REVIEW_TARGET_NOT_CONFIGURED"
  );
  assert.equal(called, false);
});

test("task-only review options require an explicit task", () => {
  assert.throws(
    () => parseArgs(["review", "--criterion", "change-quality"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CLI_OPTION_NOT_ALLOWED"
  );
});
