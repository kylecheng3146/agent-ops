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

test("accepts reviewed paths with spaces or non-ASCII letters", () => {
  const files = ["docs/src/Short URL API/redirect-short-url.md", "文件/說明 v2.md"];
  const report = reportFor(criteria, "PASS", files) as unknown as Record<string, unknown>;
  report.supportingFilesInspected = ["notes/read me.txt"];
  assert.equal(validateReviewReport(report, ["tests"]).ok, true);

  const located = reportFor(criteria, "FAIL", ["docs/Short URL API/a b.md"]) as unknown as
    { findings: { locations: unknown[] }[] };
  located.findings[0]!.locations = [{ path: "docs/Short URL API/a b.md", line: 3 }];
  assert.equal(validateReviewReport(located, ["tests"]).ok, true);
});

test("still rejects unsafe reviewed paths", () => {
  const unsafe = ["/abs/path.md", "a/../b.md", "../b.md", "a\\b.md", "a//b.md", "a/./b.md", "a\nb.md", "a\0b.md", "a\tb.md", ""];
  for (const path of unsafe) {
    assert.equal(validateReviewReport(reportFor(criteria, "PASS", [path]), ["tests"]).ok, false, JSON.stringify(path));
    const supporting = {...reportFor(criteria), supportingFilesInspected: [path]};
    assert.equal(validateReviewReport(supporting, ["tests"]).ok, false, JSON.stringify(path));
    const located = reportFor(criteria, "FAIL") as unknown as { findings: { locations: unknown[] }[] };
    located.findings[0]!.locations = [{path}];
    assert.equal(validateReviewReport(located, ["tests"]).ok, false, JSON.stringify(path));
  }
});

test("external design references are evidence text, not inspected paths", () => {
  const external = "/private/tmp/agent-ops-a-f-design.md";
  const report = reportFor(criteria);
  const evidence = {...report, results: report.results.map(result => ({...result, evidence: [external]}))};
  assert.equal(validateReviewReport(evidence, ["tests"]).ok, true);
  assert.equal(validateReviewReport({...evidence, supportingFilesInspected: [external]}, ["tests"]).ok, false);
});
