import type { ReviewCriterion } from "../../runtime/src/review/packet.js";
import type { ReviewReport } from "../../runtime/src/review/report.js";

export function reportFor(
  criteria: readonly Pick<ReviewCriterion, "id">[],
  status: "PASS" | "FAIL" = "PASS",
  changedFilesInspected: readonly string[] = []
): ReviewReport {
  const results = criteria.map((criterion) => ({
    criterionId: criterion.id,
    status,
    summary: `Reviewed ${criterion.id}.`,
    evidence: [`inspected ${criterion.id}`]
  })) as ReviewReport["results"];
  return {
    summary: "Review complete.",
    results,
    findings: status === "FAIL"
      ? [{
          severity: "important",
          blocking: true,
          title: "Criterion failed.",
          details: "The requested condition is not met.",
          locations: [],
          evidence: ["reviewed source"],
          recommendation: "Fix the criterion.",
          criterionIds: criteria.map((criterion) => criterion.id)
        }]
      : [],
    residualRisks: [],
    changedFilesInspected,
    supportingFilesInspected: []
  };
}
