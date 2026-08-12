import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateReviewResults,
  type ReviewCriterionResult
} from "../../runtime/src/review/result.js";
import { buildReviewPacket } from "../../runtime/src/review/packet.js";

test("builds an isolated packet without rationale, logs, or credentials", () => {
  const packet = buildReviewPacket({
    request: "Review the implementation.",
    criteria: [{ id: "tests", description: "Tests pass." }],
    artifactRefs: ["runtime/src/review/packet.ts"],
    evidenceRequirements: [{ criterionId: "tests", requirement: "test output" }],
    implementationRationale: "hidden rationale",
    rawLogs: "Authorization header omitted",
    credential: "credential-value"
  });

  assert.deepEqual(Object.keys(packet).sort(), [
    "artifactRefs",
    "criteria",
    "evidenceRequirements",
    "request"
  ]);
  assert.doesNotMatch(JSON.stringify(packet), /hidden rationale|Authorization|credential-value/);
});

function result(
  criterionId: string,
  status: "PASS" | "FAIL",
  evidence = "evidence"
): ReviewCriterionResult {
  return { criterionId, status, evidence: [evidence] };
}

test("aggregates exactly one passing result per requested criterion", () => {
  const summary = aggregateReviewResults(
    ["tests", "scope"],
    [result("tests", "PASS"), result("scope", "PASS")]
  );
  assert.equal(summary.status, "PASS");
  assert.deepEqual(summary.results.map((item) => item.criterionId), [
    "tests",
    "scope"
  ]);
});

test("protocol violations are reported as invalid, not as a FAIL verdict", () => {
  for (const results of [
    [result("tests", "PASS")],
    [result("tests", "PASS"), result("tests", "PASS")],
    [result("tests", "PASS"), result("other", "PASS")],
    [{ criterionId: "tests", status: "PASS" as const, evidence: [] }]
  ]) {
    assert.equal(
      aggregateReviewResults(
        results.length === 1 && results[0]?.criterionId === "tests" &&
          results[0]?.evidence.length > 0
          ? ["tests", "scope"]
          : ["tests"],
        results
      ).valid,
      false
    );
  }
  assert.equal(
    aggregateReviewResults(
      ["tests"],
      [result("tests", "PASS", "   ")]
    ).valid,
    false
  );
  const failed = aggregateReviewResults(["tests"], [result("tests", "FAIL")]);
  assert.equal(failed.valid, true);
  assert.equal(failed.status, "FAIL");
});
