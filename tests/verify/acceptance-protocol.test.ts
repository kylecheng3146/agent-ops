import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTANCE_FAILURE,
  aggregateAcceptanceRun,
  makeAcceptanceCheck,
  makeAcceptanceRun,
  type AcceptanceCheckResult
} from "../../runtime/src/verify/acceptance-protocol.js";

const OPTIONS = {
  executionId: "execution-one",
  framework: "fixture",
  frameworkVersion: "1",
  phase: "candidate" as const
};

function check(
  checkId: string,
  status: "PASS" | "FAIL" | "UNKNOWN",
  failureClass: string = status === "PASS" ? "none" : "assertion-failed",
  attempts: number | null = 1,
  evidence: readonly string[] = [`evidence:${checkId}`]
): AcceptanceCheckResult {
  return makeAcceptanceCheck({
    ...OPTIONS,
    checkId,
    status,
    failureClass,
    attempts,
    evidence
  });
}

function run(results: readonly AcceptanceCheckResult[], completed = true, diagnostics: readonly string[] = []) {
  return makeAcceptanceRun({
    ...OPTIONS,
    results,
    completed,
    completionEvidence: completed ? ["complete:1"] : [],
    diagnostics
  });
}

test("acceptance protocol passes only an exact complete set of checks", () => {
  const aggregate = aggregateAcceptanceRun(
    run([check("a", "PASS"), check("b", "PASS")]),
    ["a", "b"]
  );
  assert.equal(aggregate.status, "PASS");
  assert.equal(aggregate.failureClass, "none");
  assert.deepEqual(aggregate.missingCheckIds, []);
});

test("only an explicit assertion failure is behavioral red", () => {
  const aggregate = aggregateAcceptanceRun(
    run([check("a", "FAIL")]),
    ["a"]
  );
  assert.equal(aggregate.status, "FAIL");
  assert.equal(aggregate.failureClass, ACCEPTANCE_FAILURE.assertion);
  assert.equal(
    aggregateAcceptanceRun(
      run([check("a", "FAIL", ACCEPTANCE_FAILURE.fixture)]),
      ["a"]
    ).status,
    "UNKNOWN"
  );
});

test("missing, duplicate, retry, skipped, and incomplete evidence fail closed", () => {
  assert.equal(
    aggregateAcceptanceRun(run([check("a", "PASS")]), ["a", "b"]).status,
    "UNKNOWN"
  );
  assert.equal(
    aggregateAcceptanceRun(run([check("a", "PASS"), check("a", "PASS")]), ["a"]).failureClass,
    ACCEPTANCE_FAILURE.duplicate
  );
  assert.equal(
    aggregateAcceptanceRun(run([check("a", "PASS", "none", 2)]), ["a"]).failureClass,
    ACCEPTANCE_FAILURE.retry
  );
  assert.equal(
    aggregateAcceptanceRun(run([check("a", "UNKNOWN", ACCEPTANCE_FAILURE.skipped)]), ["a"]).status,
    "UNKNOWN"
  );
  assert.equal(
    aggregateAcceptanceRun(run([check("a", "PASS")], false), ["a"]).failureClass,
    ACCEPTANCE_FAILURE.incomplete
  );
});

test("empty evidence and adapter diagnostics cannot become PASS", () => {
  const emptyEvidence = { ...check("a", "PASS"), evidence: [] } as AcceptanceCheckResult;
  assert.equal(
    aggregateAcceptanceRun(run([emptyEvidence]), ["a"]).failureClass,
    ACCEPTANCE_FAILURE.emptyEvidence
  );
  assert.equal(
    aggregateAcceptanceRun(run([check("a", "PASS")], true, ["fixture-error"]), ["a"]).status,
    "UNKNOWN"
  );
});
