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

test("task-only review options require an explicit task", () => {
  assert.throws(
    () => parseArgs(["review", "--criterion", "change-quality"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CLI_OPTION_NOT_ALLOWED"
  );
});
