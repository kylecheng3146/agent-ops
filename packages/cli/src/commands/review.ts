import type { Harness } from "../../../../runtime/src/contracts.js";
import {
  buildReviewPacket,
  type ReviewCriterion,
  type ReviewEvidenceRequirement
} from "../../../../runtime/src/review/packet.js";
import {
  runIndependentReview,
  type ReviewRunResult
} from "../../../../runtime/src/review/runner.js";
import {
  resolveReviewRole,
  type ReviewRole,
  type ReviewRoleConfig
} from "../../../../runtime/src/review/roles.js";
import type { ParsedArgs } from "../args.js";
import { okEnvelope, type CliEnvelope } from "../output.js";

export interface ReviewCommandOptions {
  readonly args: ParsedArgs;
  readonly authorized: boolean;
  readonly execute?: Parameters<typeof runIndependentReview>[0]["execute"];
  readonly model?: string;
  readonly effort?: string;
  readonly role?: ReviewRole;
  readonly roles?: readonly ReviewRoleConfig[];
}

export interface ReviewCommandData {
  readonly message: string;
  readonly result: ReviewRunResult;
  readonly text: string;
}

function harness(value: Harness | undefined): "codex" | "claude" {
  return value === "claude" ? "claude" : "codex";
}

export async function runReviewCommand(
  options: ReviewCommandOptions
): Promise<CliEnvelope<ReviewCommandData>> {
  const ids = options.args.criteria ?? [];
  const criteria: ReviewCriterion[] = ids.map((id) => ({
    id,
    description: id
  }));
  const evidenceRequirements: ReviewEvidenceRequirement[] = (
    options.args.evidence ?? []
  ).map((value) => {
    const separator = value.indexOf("=");
    return {
      criterionId: separator < 0 ? value : value.slice(0, separator),
      requirement: separator < 0 ? value : value.slice(separator + 1)
    };
  });
  const selectedHarness = harness(options.args.harness);
  const role = resolveReviewRole(
    options.role ?? "independent-review",
    options.roles ?? []
  );
  const result = await runIndependentReview({
    invocation: {
      harness: role?.harness ?? selectedHarness,
      model: role?.model ?? options.model ?? "configured",
      effort: role?.effort ?? options.effort ?? "configured",
      packet: buildReviewPacket({
        request: "Review the requested implementation.",
        criteria,
        artifactRefs: [],
        evidenceRequirements
      })
    },
    authorized: options.authorized,
    execute: options.execute ?? (async () => ({
      status: "NOT_RUN",
      reason: "missing-cli" as const
    }))
  });
  const message =
    result.status === "PASS"
      ? "Independent review passed."
      : result.status === "FAIL"
        ? "Independent review failed."
        : "Independent review was not run.";
  const data = {
    message,
    result,
    text: [
      message,
      `Status: ${result.status}`,
      `Harness: ${result.harness}; model: ${result.model}; effort: ${result.effort}.`,
      ...(result.reason === undefined ? [] : [`Reason: ${result.reason}.`]),
      ...(result.results === undefined
        ? []
        : result.results.map(
            (item) =>
              `${item.criterionId}: ${item.status} [${item.evidence.join(", ")}]`
          )),
      result.prompt,
      ""
    ].join("\n")
  };
  if (result.status === "PASS") {
    return okEnvelope("REVIEW_RESULT", data);
  }
  const code = result.status === "FAIL" ? "REVIEW_FAILED" : "REVIEW_NOT_RUN";
  return {
    code,
    status: "error",
    data,
    errors: [{ code, message }]
  };
}
