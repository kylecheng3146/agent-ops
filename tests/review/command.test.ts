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
  assert.match(envelope.data?.text ?? "", /missing-cli|authorization-required/);
});

test("review command resolves configured role harness and model", async () => {
  const envelope = await runReviewCommand({
    args: parseArgs(["review", "--yes", "--criterion", "review"]),
    authorized: true,
    role: "independent-review",
    roles: [{
      role: "independent-review",
      harness: "claude",
      model: "review-model",
      effort: "high"
    }],
    execute: async () => ({
      status: "PASS",
      results: [{
        criterionId: "review",
        status: "PASS" as const,
        evidence: ["review-output"]
      }]
    })
  });
  assert.equal(envelope.status, "ok");
  assert.match(envelope.data?.text ?? "", /claude|review-model|high/);
});
