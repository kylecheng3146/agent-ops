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
  assert.match(envelope.data?.text ?? "", /no-task-context/);
});

test("review command resolves configured role metadata before task-context failure", async () => {
  const envelope = await runReviewCommand({
    args: parseArgs(["review", "--yes", "--criterion", "review"]),
    authorized: true,
    role: "independent-review",
    roles: [{
      role: "independent-review",
      targets: ["claude"],
      model: "review-model",
      effort: "high"
    }],
    execute: async () => { throw new Error("must not execute without a task"); }
  });
  assert.equal(envelope.status, "error");
  assert.match(envelope.data?.text ?? "", /claude|review-model|high/);
});
