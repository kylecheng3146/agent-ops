import type { ReviewPacket } from "./packet.js";

export interface ReviewCriterionResult {
  readonly criterionId: string;
  readonly status: "PASS" | "FAIL";
  readonly evidence: readonly string[];
}

export interface ReviewSummary {
  readonly status: "PASS" | "FAIL";
  readonly results: readonly ReviewCriterionResult[];
  /**
   * False when the response broke the protocol — a missing, duplicated or
   * unrequested criterion, or blank evidence. Kept separate from `status` so
   * FAIL keeps meaning "the reviewer looked and judged it inadequate"; a
   * sloppy response must not be recorded as a failed review.
   */
  readonly valid: boolean;
}

export function aggregateReviewResults(
  requestedCriterionIds: readonly string[],
  results: readonly ReviewCriterionResult[]
): ReviewSummary {
  const expected = new Set(requestedCriterionIds);
  const seen = new Set<string>();
  let valid = requestedCriterionIds.length === expected.size;
  for (const result of results) {
    if (
      !expected.has(result.criterionId) ||
      seen.has(result.criterionId) ||
      result.evidence.length === 0 ||
      result.evidence.some((reference) => reference.trim().length === 0)
    ) {
      valid = false;
    }
    seen.add(result.criterionId);
  }
  if (seen.size !== expected.size) {
    valid = false;
  }
  const status = results.every((result) => result.status === "PASS")
    ? "PASS"
    : "FAIL";
  return { status, results: [...results], valid };
}

export interface ReviewRequest {
  readonly packet: ReviewPacket;
  readonly criterionResults: readonly ReviewCriterionResult[];
}

export function summarizeReview(request: ReviewRequest): ReviewSummary {
  return aggregateReviewResults(
    request.packet.criteria.map((criterion) => criterion.id),
    request.criterionResults
  );
}
