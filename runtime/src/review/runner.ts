import type { ReviewPacket } from "./packet.js";
import {
  aggregateReviewResults,
  type ReviewCriterionResult
} from "./result.js";

export interface ReviewInvocation {
  readonly harness: "codex" | "claude";
  readonly model: string;
  readonly effort: string;
  readonly packet: ReviewPacket;
}

export type ReviewUnavailableReason =
  | "missing-cli"
  | "login-required"
  | "quota-exhausted";

export interface ReviewExecutionRequest {
  readonly invocation: ReviewInvocation;
  readonly readOnly: true;
}

export type ReviewExecutionResult =
  | { readonly status: "PASS"; readonly results: readonly ReviewCriterionResult[] }
  | { readonly status: "FAIL"; readonly results: readonly ReviewCriterionResult[] }
  | { readonly status: "NOT_RUN"; readonly reason: ReviewUnavailableReason };

export interface ReviewRunResult {
  readonly status: "PASS" | "FAIL" | "NOT_RUN";
  readonly harness: ReviewInvocation["harness"];
  readonly model: string;
  readonly effort: string;
  readonly prompt: string;
  readonly reason?: ReviewUnavailableReason | "authorization-required";
  readonly results?: readonly ReviewCriterionResult[];
}

export interface ReviewRunnerOptions {
  readonly invocation: ReviewInvocation;
  readonly authorized: boolean;
  readonly execute: (
    request: ReviewExecutionRequest
  ) => Promise<ReviewExecutionResult>;
}

function promptFor(invocation: ReviewInvocation): string {
  return [
    "Review the requested criteria in read-only mode.",
    `Harness: ${invocation.harness}; model: ${invocation.model}; effort: ${invocation.effort}.`,
    `Artifacts: ${invocation.packet.artifactRefs.join(", ") || "none"}.`,
    `Criteria: ${invocation.packet.criteria.map((criterion) => criterion.id).join(", ") || "none"}.`
  ].join("\n");
}

export async function runIndependentReview(
  options: ReviewRunnerOptions
): Promise<ReviewRunResult> {
  const base = {
    harness: options.invocation.harness,
    model: options.invocation.model,
    effort: options.invocation.effort,
    prompt: promptFor(options.invocation)
  } as const;
  if (!options.authorized) {
    return { ...base, status: "NOT_RUN", reason: "authorization-required" };
  }
  const result = await options.execute({
    invocation: options.invocation,
    readOnly: true
  });
  if (result.status === "NOT_RUN") {
    return { ...base, status: result.status, reason: result.reason };
  }
  if (result.status === "FAIL") {
    return { ...base, status: result.status, results: result.results };
  }
  const summary = aggregateReviewResults(
    options.invocation.packet.criteria.map((criterion) => criterion.id),
    result.results
  );
  return { ...base, status: summary.status, results: summary.results };
}
