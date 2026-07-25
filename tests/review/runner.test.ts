import assert from "node:assert/strict";
import test from "node:test";

import {
  runIndependentReview,
  type ReviewInvocation
} from "../../runtime/src/review/runner.js";

const invocation: ReviewInvocation = {
  harness: "codex",
  model: "configured-model",
  effort: "medium",
  packet: {
    request: "Review.",
    criteria: [{ id: "tests", description: "Tests pass." }],
    artifactRefs: ["runtime/src/review/runner.ts"],
    evidenceRequirements: [{ criterionId: "tests", requirement: "test output" }]
  }
};

test("missing CLI, login, or quota produces NOT_RUN and a copyable prompt", async () => {
  for (const reason of ["missing-cli", "login-required", "quota-exhausted"] as const) {
    const result = await runIndependentReview({
      invocation,
      authorized: true,
      execute: async () => ({ status: "NOT_RUN", reason })
    });
    assert.equal(result.status, "NOT_RUN");
    assert.match(result.prompt, /Review the requested criteria/);
    assert.match(result.prompt, /runtime\/src\/review\/runner\.ts/);
  }
});

test("review execution requires explicit authorization and read-only mode", async () => {
  const calls: Array<{ readonly readOnly: boolean }> = [];
  const result = await runIndependentReview({
    invocation,
    authorized: false,
    execute: async ({ readOnly }) => {
      calls.push({ readOnly });
      return {
        status: "PASS",
        results: [{ criterionId: "tests", status: "PASS", evidence: ["review-output"] }]
      };
    }
  });
  assert.equal(result.status, "NOT_RUN");
  assert.equal(calls.length, 0);

  const authorized = await runIndependentReview({
    invocation,
    authorized: true,
    execute: async ({ readOnly }) => {
      calls.push({ readOnly });
      return {
        status: "PASS",
        results: [{ criterionId: "tests", status: "PASS", evidence: ["review-output"] }]
      };
    }
  });
  assert.equal(authorized.status, "PASS");
  assert.deepEqual(calls, [{ readOnly: true }]);
});

test("review evidence is redacted and safe for human or JSON output", async () => {
  const sensitive = ["Author", "ization: hidden"].join("");
  const result = await runIndependentReview({
    invocation,
    authorized: true,
    execute: async () => ({
      status: "PASS",
      results: [{ criterionId: "tests", status: "PASS", evidence: [sensitive] }]
    })
  });
  assert.equal(result.status, "PASS");
  assert.notEqual(result.results?.[0]?.evidence[0], sensitive);
  assert.doesNotMatch(result.results?.[0]?.evidence[0] ?? "", /hidden/);
});
