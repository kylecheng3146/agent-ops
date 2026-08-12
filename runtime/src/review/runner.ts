import type { ReviewTargetId } from "../contracts.js";
import type { ReviewCriterion, ReviewPacket } from "./packet.js";
import {
  aggregateReviewResults,
  type ReviewCriterionResult
} from "./result.js";
import { redactSecrets } from "../security/redact.js";
import { safeTaskText } from "../task/render.js";

export interface ReviewInvocation {
  readonly harness: ReviewTargetId;
  readonly model: string;
  readonly effort: string;
  readonly packet: ReviewPacket;
}

export type ReviewUnavailableReason =
  | "missing-cli"
  | "login-required"
  | "no-task-context"
  | "quota-exhausted"
  | "unparseable-output";

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

function criterionLine(criterion: ReviewCriterion): string {
  const verified = criterion.verifierIds ?? [];
  const covered =
    verified.length === 0
      ? ""
      : ` (already machine-verified by: ${verified.join(", ")} —` +
        " do not re-run those checks)";
  return `- ${criterion.id}: ${criterion.description}${covered}`;
}

/**
 * The prompt the reviewing CLI actually receives. It stays short on purpose: it
 * travels through argv, so an embedded diff would risk ARG_MAX and would expose
 * the diff in `ps` output. The target inspects the repository itself instead,
 * which its read-only sandbox permits.
 */
export function buildReviewPrompt(invocation: ReviewInvocation): string {
  const ids = invocation.packet.criteria.map((criterion) => criterion.id);
  const shape = ids
    .map(
      (id) =>
        `{"criterionId":"${id}","status":"PASS|FAIL","evidence":["<reference>"]}`
    )
    .join(",");
  return [
    invocation.packet.request,
    "",
    "You are a read-only reviewer. Inspect this repository yourself " +
      "(git diff, git log, reading files); do not modify anything.",
    `Harness: ${invocation.harness}; model: ${invocation.model}; effort: ${invocation.effort}.`,
    `Artifacts: ${invocation.packet.artifactRefs.join(", ") || "none"}.`,
    "",
    "Criteria:",
    ...(invocation.packet.criteria.length === 0
      ? ["- none"]
      : invocation.packet.criteria.map(criterionLine)),
    ...invocation.packet.evidenceRequirements.map(
      (requirement) =>
        `- evidence for ${requirement.criterionId}: ${requirement.requirement}`
    ),
    "",
    "Reply with exactly one JSON object and nothing else. Name every " +
      "criterion above exactly once, each with at least one non-empty " +
      "evidence reference:",
    `{"results":[${shape}]}`
  ].join("\n");
}

function safeResult(result: ReviewCriterionResult): ReviewCriterionResult {
  return {
    criterionId: safeTaskText(redactSecrets(result.criterionId)),
    status: result.status,
    evidence: result.evidence.map((reference) =>
      safeTaskText(redactSecrets(reference))
    )
  };
}

export async function runIndependentReview(
  options: ReviewRunnerOptions
): Promise<ReviewRunResult> {
  const base = {
    harness: options.invocation.harness,
    model: options.invocation.model,
    effort: options.invocation.effort,
    prompt: buildReviewPrompt(options.invocation)
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
  if (!summary.valid) {
    return { ...base, status: "NOT_RUN", reason: "unparseable-output" };
  }
  return {
    ...base,
    status: summary.status,
    results: summary.results.map(safeResult)
  };
}
