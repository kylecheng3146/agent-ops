import assert from "node:assert/strict";
import test from "node:test";

import {
  reviewReportStatus,
  validateReviewReport
} from "../../runtime/src/review/report.js";
import { reportFor } from "./report-fixture.js";

const criteria = [{ id: "tests" }];

test("validates a complete report and derives the verdict outside the model", () => {
  const valid = validateReviewReport(reportFor(criteria), ["tests"]);
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(reviewReportStatus(valid.value), "PASS");
  }
  const failed = validateReviewReport(reportFor(criteria, "FAIL"), ["tests"]);
  assert.equal(failed.ok, true);
  if (failed.ok) {
    assert.equal(reviewReportStatus(failed.value), "FAIL");
  }
});

test("rejects duplicate criteria, unlinked failures, and invalid finding severity rules", () => {
  const duplicate = reportFor(criteria) as unknown as Record<string, unknown>;
  duplicate.results = [...(duplicate.results as unknown[]), (duplicate.results as unknown[])[0]];
  assert.equal(validateReviewReport(duplicate, ["tests"]).ok, false);

  const unlinked = reportFor(criteria, "FAIL") as unknown as Record<string, unknown>;
  unlinked.findings = [];
  assert.equal(validateReviewReport(unlinked, ["tests"]).ok, false);

  const critical = reportFor(criteria) as unknown as Record<string, unknown>;
  critical.findings = [{
    severity: "critical",
    blocking: false,
    title: "Critical.",
    details: "Critical issue.",
    locations: [],
    evidence: ["source"],
    recommendation: "Fix.",
    criterionIds: []
  }];
  assert.equal(validateReviewReport(critical, ["tests"]).ok, false);
});
