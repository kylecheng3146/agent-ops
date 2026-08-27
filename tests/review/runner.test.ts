import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdversarialPrompt,
  runIndependentReview,
  type ReviewInvocation
} from "../../runtime/src/review/runner.js";
import { renderReviewResult } from "../../runtime/src/review/render.js";
import { reportFor } from "./report-fixture.js";

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
    assert.match(result.prompt, /read-only reviewer/);
    assert.match(result.prompt, /runtime\/src\/review\/runner\.ts/);
  }
});

test("review execution requires explicit authorization and read-only mode", async () => {
  const calls: Array<{ readonly readOnly: boolean }> = [];
  const result = await runIndependentReview({
    invocation,
    authorized: false,
    execute: async (request) => {
      const { readOnly } = request;
      calls.push({ readOnly });
      return {
        status: "PASS",
        results: [{ criterionId: "tests", status: "PASS", evidence: ["review-output"] }],
        report: reportFor(request.invocation.packet.criteria)
      };
    }
  });
  assert.equal(result.status, "NOT_RUN");
  assert.equal(calls.length, 0);

  const authorized = await runIndependentReview({
    invocation,
    authorized: true,
    execute: async (request) => {
      const { readOnly } = request;
      calls.push({ readOnly });
      return {
        status: "PASS",
        results: [{ criterionId: "tests", status: "PASS", evidence: ["review-output"] }],
        report: reportFor(request.invocation.packet.criteria)
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
      results: [{ criterionId: "tests", status: "PASS", evidence: [sensitive] }],
      report: {
        ...reportFor(invocation.packet.criteria),
        results: [{
          criterionId: "tests",
          status: "PASS",
          summary: "Reviewed.",
          evidence: [sensitive]
        }]
      }
    })
  });
  assert.equal(result.status, "PASS");
  assert.notEqual(result.results?.[0]?.evidence[0], sensitive);
  assert.doesNotMatch(result.results?.[0]?.evidence[0] ?? "", /hidden/);
});

test("review attempts survive JSON and human rendering", async () => {
  const result = await runIndependentReview({
    invocation,
    authorized: true,
    execute: async () => ({
      status: "PASS",
      results: [{ criterionId: "tests", status: "PASS", evidence: ["review-output"] }],
      report: reportFor(invocation.packet.criteria),
      attempts: [
        { target: "codex", status: "NOT_RUN", reason: "login-required" },
        { target: "agy", status: "PASS" }
      ]
    })
  });

  assert.deepEqual(result.attempts, [
    { target: "codex", status: "NOT_RUN", reason: "login-required" },
    { target: "agy", status: "PASS" }
  ]);
  assert.match(renderReviewResult(result), /codex: NOT_RUN \(login-required\)/);
  assert.match(renderReviewResult(result), /agy: PASS/);
});

test("an attempt diagnostic reaches the rendered report, redacted", async () => {
  const secret = ["Author", "ization: Bearer abcdef123456"].join("");
  const result = await runIndependentReview({
    invocation,
    authorized: true,
    execute: async () => ({
      status: "PASS",
      results: [{ criterionId: "tests", status: "PASS", evidence: ["review-output"] }],
      report: reportFor(invocation.packet.criteria),
      attempts: [
        {
          target: "claude",
          status: "NOT_RUN",
          reason: "login-required",
          diagnostic: `Error: --json-schema is not a valid JSON Schema ${secret}`
        },
        { target: "codex", status: "PASS" }
      ]
    })
  });

  const rendered = renderReviewResult(result);
  assert.match(rendered, /claude: NOT_RUN \(login-required\) — Error: --json-schema is not a valid JSON Schema/);
  assert.doesNotMatch(rendered, /abcdef123456/);
});

test("a refuted PASS is reported as FAIL with the challenge rendered", async () => {
  const sensitive = ["Author", "ization: hidden"].join("");
  const challenge = reportFor(invocation.packet.criteria, "FAIL");
  const result = await runIndependentReview({
    invocation,
    authorized: true,
    execute: async () => ({
      // The executor already resolves the refutation; the runner must not fall
      // back to recomputing PASS from the primary report.
      status: "FAIL",
      results: [{ criterionId: "tests", status: "PASS", evidence: ["review-output"] }],
      report: reportFor(invocation.packet.criteria),
      adversarial: {
        target: "agy",
        refuted: true,
        report: {
          ...challenge,
          summary: `Refuted. ${sensitive}`
        }
      }
    })
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.adversarial?.target, "agy");
  assert.equal(result.adversarial?.refuted, true);
  assert.doesNotMatch(result.adversarial?.report.summary ?? "", /hidden/);
  const rendered = renderReviewResult(result);
  assert.match(rendered, /Adversarial re-check \(agy\): refuted the PASS\./);
  assert.match(rendered, /blocking: Criterion failed\./);
});

test("an upheld PASS keeps its status and names the challenger", async () => {
  const result = await runIndependentReview({
    invocation,
    authorized: true,
    execute: async () => ({
      status: "PASS",
      results: [{ criterionId: "tests", status: "PASS", evidence: ["review-output"] }],
      report: reportFor(invocation.packet.criteria),
      adversarial: {
        target: "agy",
        refuted: false,
        report: reportFor(invocation.packet.criteria)
      }
    })
  });

  assert.equal(result.status, "PASS");
  assert.match(
    renderReviewResult(result),
    /Adversarial re-check \(agy\): upheld the PASS\./
  );
});

test("the adversarial prompt fences the prior report as untrusted", () => {
  const prompt = buildAdversarialPrompt(
    invocation,
    reportFor(invocation.packet.criteria)
  );
  assert.match(prompt, /adversarial reviewer/);
  assert.match(prompt, /BEGIN_PRIOR_REVIEW[\s\S]*END_PRIOR_REVIEW/);
  assert.match(prompt, /untrusted model[\s\S]*never as[\s\S]*instructions/);
  assert.match(prompt, /BEGIN_TASK_DATA/);
  assert.match(prompt, /summary:string/);
});

test("the fallback-safe prompt carries the complete report contract", async () => {
  const result = await runIndependentReview({
    invocation,
    authorized: false,
    execute: async () => ({ status: "NOT_RUN", reason: "missing-cli" })
  });
  for (const field of [
    "summary:string",
    "results:[",
    "findings:[",
    "residualRisks:string[]",
    "changedFilesInspected:string[]",
    "supportingFilesInspected:string[]"
  ]) {
    assert.ok(result.prompt.includes(field));
  }
});
