import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTestCount,
  parseTestCount
} from "../../runtime/src/verify/test-count.js";

test("parses explicit Node, Jest, Vitest, pytest, and Rust summaries", () => {
  assert.equal(parseTestCount("# tests 12\n# pass 12\n# fail 0\n"), 12);
  assert.equal(
    parseTestCount("Tests: 1 failed, 4 passed, 5 total\n"),
    5
  );
  assert.equal(
    parseTestCount("Tests  1 failed | 4 passed (5)\n"),
    5
  );
  assert.equal(
    parseTestCount("5 passed, 2 skipped in 0.10s\n"),
    7
  );
  assert.equal(
    parseTestCount(
      "test result: ok. 5 passed; 1 failed; 2 ignored; 0 measured; 0 filtered out\n"
    ),
    6
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
