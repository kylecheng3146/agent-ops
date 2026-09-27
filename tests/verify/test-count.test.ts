import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTestCount,
  parseTestCount,
  parseTestSummary
} from "../../runtime/src/verify/test-count.js";

test("parses explicit Node, Jest, Vitest, pytest, and Rust summaries", () => {
  assert.equal(parseTestCount("# tests 12\n# pass 12\n# fail 0\n"), 12);
  assert.equal(parseTestCount("ℹ tests 12\nℹ pass 10\nℹ skipped 2\nℹ fail 0\n"), 10);
  assert.equal(
    parseTestCount("Tests: 1 failed, 4 passed, 5 total\n"),
    4
  );
  assert.equal(
    parseTestCount("Tests  1 failed | 4 passed (5)\n"),
    4
  );
  assert.equal(
    parseTestCount("5 passed, 2 skipped in 0.10s\n"),
    5
  );
  assert.equal(
    parseTestCount(
      "test result: ok. 5 passed; 1 failed; 2 ignored; 0 measured; 0 filtered out\n"
    ),
    5
  );
});

test("returns null for absent, malformed, contradictory, or unsafe counts", () => {
  assert.equal(parseTestCount("ok package/example 0.2s\n"), null);
  assert.equal(parseTestCount("# tests nope\n"), null);
  assert.equal(parseTestCount("# tests 2\nTests: 3 total\n"), null);
  assert.equal(parseTestCount("# tests 9007199254740992\n"), null);
});

test("recognizes explicit zero-test summaries as zero", () => {
  assert.equal(parseTestCount("# tests 0\n"), 0);
  assert.equal(parseTestCount("collected 0 items\n"), 0);
  assert.equal(
    parseTestCount(
      "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n"
    ),
    0
  );
  assert.equal(parseTestCount("5 deselected in 0.10s\n"), 0);
});

test("fails zero or below-minimum counts and keeps unparseable output UNKNOWN", () => {
  assert.deepEqual(evaluateTestCount(0), {
    status: "FAIL",
    code: "ZERO_TESTS",
    testCount: 0
  });
  assert.deepEqual(evaluateTestCount(2, 3), {
    status: "FAIL",
    code: "TEST_COUNT_BELOW_MINIMUM",
    testCount: 2
  });
  assert.deepEqual(evaluateTestCount(3, 3), {
    status: "PASS",
    code: "TEST_COUNT_OK",
    testCount: 3
  });
  assert.deepEqual(evaluateTestCount(null), {
    status: "UNKNOWN",
    code: "TEST_COUNT_UNPARSEABLE",
    testCount: null
  });
});


test("all skipped, todo and expected failures contribute no passed tests", () => {
  for (const summary of [
    "# tests 3\n# pass 0\n# skipped 3\n",
    "Tests: 3 skipped, 3 total",
    "Tests 3 skipped (3)",
    "2 skipped, 1 xfailed, 1 xpassed in 0.10s",
    "test result: ok. 0 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out"
  ]) {
    assert.equal(parseTestCount(summary), 0, summary);
    assert.equal(evaluateTestCount(parseTestCount(summary), 0).status, "FAIL");
  }
  for (const summary of ["# tests 3", "Tests: 3 total", "collected 3 items", "Tests  (3)", "Tests: 2 passed, 1 total", "# tests 1\n# pass 2", "# pass 2\n# pass 3", "# pass 1\n# fail nope", "# tests 2\n# pass 2\n# skipped 1", "Tests: 999999999999999999999 passed"]) {
    assert.equal(parseTestCount(summary), null, summary);
  }
});

test("explicit failures survive unknown or conflicting passed counts", () => {
  for (const summary of [
    "# pass 1\n# fail 1", "# pass 1\n# cancelled 1",
    "Tests: 1 passed, 1 failed, 2 total", "Tests 1 passed | 1 failed (2)",
    "1 passed, 1 error in 0.10s", "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out",
    "Tests: 2 passed, 1 failed, 3 total\nTests: 4 passed, 4 total"
  ]) assert.ok(parseTestSummary(summary).failed > 0, summary);
  assert.equal(parseTestCount("\u001b[32mTests: 2 passed, 1 skipped, 3 total\u001b[0m"), 2);
});
