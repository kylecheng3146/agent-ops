import type {
  Harness,
  ReviewTargetId
} from "../../../../runtime/src/contracts.js";
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
import type { TaskService } from "../../../../runtime/src/task/service.js";
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
  readonly tasks?: TaskService;
  readonly sessionId?: string;
  readonly taskId?: string;
}

export interface ReviewCommandData {
  readonly message: string;
  readonly result: ReviewRunResult;
  readonly text: string;
}

/**
 * Review runs against one target. Argument parsing already rejects a
 * multi-harness selection here, so the first entry is the whole selection.
 * `opencode` is not a review target — it has no read-only flag — so selecting
 * it leaves the target unresolved and the configured chain decides.
 */
function harness(value: Harness | undefined): ReviewTargetId | undefined {
  const selected = value?.[0];
  return selected === undefined || selected === "opencode"
    ? undefined
    : selected;
}

interface TaskContext {
  readonly taskId: string;
  readonly active: boolean;
  readonly criteria: readonly ReviewCriterion[];
}

/**
 * Criterion descriptions come from the task store, never from the id. A
 * reviewer handed `criterion: tests` cannot review anything, so a review with
 * no task context is reported as not run rather than run meaninglessly.
 */
async function taskContext(
  options: ReviewCommandOptions
): Promise<TaskContext | undefined> {
  const tasks = options.tasks;
  if (tasks === undefined) {
    return undefined;
  }
  const query = options.taskId !== undefined
    ? { taskId: options.taskId }
    : options.sessionId === undefined
      ? undefined
      : { sessionId: options.sessionId };
  if (query === undefined) {
    return undefined;
  }
  let record;
  try {
    record = await tasks.status(query);
  } catch {
    return undefined;
  }
  const requested = options.args.criteria ?? [];
  const criteria = record.task.criteria
    .filter(
      (criterion) =>
        requested.length === 0 || requested.includes(criterion.id)
    )
    .map((criterion) => ({
      id: criterion.id,
      description: criterion.description,
      verifierIds: [...criterion.verifierIds]
    }));
  if (
    criteria.length === 0 ||
    (requested.length > 0 && criteria.length !== requested.length)
  ) {
    return undefined;
  }
  return {
    taskId: record.task.id,
    active: record.status === "active",
    criteria
  };
}

function notRunEnvelope(
  result: ReviewRunResult
): CliEnvelope<ReviewCommandData> {
  const message = "Independent review was not run.";
  return {
    code: "REVIEW_NOT_RUN",
    status: "error",
    data: {
      message,
      result,
      text: [message, `Reason: ${result.reason ?? "unknown"}.`, ""].join("\n")
    },
    errors: [{ code: "REVIEW_NOT_RUN", message }]
  };
}

export async function runReviewCommand(
  options: ReviewCommandOptions
): Promise<CliEnvelope<ReviewCommandData>> {
  const role = resolveReviewRole(
    options.role ?? "independent-review",
    options.roles ?? []
  );
  const selectedHarness = harness(options.args.harness);
  const target = role?.targets[0] ?? selectedHarness ?? "codex";
  const context = await taskContext(options);
  const evidenceRequirements: ReviewEvidenceRequirement[] = (
    options.args.evidence ?? []
  ).map((value) => {
    const separator = value.indexOf("=");
    return {
      criterionId: separator < 0 ? value : value.slice(0, separator),
      requirement: separator < 0 ? value : value.slice(separator + 1)
    };
  });
  if (options.tasks !== undefined && context === undefined) {
    return notRunEnvelope({
      status: "NOT_RUN",
      reason: "no-task-context",
      harness: target,
      model: role?.model ?? options.model ?? "configured",
      effort: role?.effort ?? options.effort ?? "configured",
      prompt: ""
    });
  }
  const criteria: ReviewCriterion[] = context?.criteria !== undefined
    ? [...context.criteria]
    : (options.args.criteria ?? []).map((id) => ({ id, description: id }));
  const result = await runIndependentReview({
    invocation: {
      harness: target,
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
  // Evidence is only appended while the task is active: a completed record
  // must stay exactly as it was verified.
  if (
    options.tasks !== undefined &&
    context !== undefined &&
    context.active &&
    result.results !== undefined
  ) {
    await options.tasks.recordEvidence(
      context.taskId,
      Object.fromEntries(
        result.results.map((item) => [
          item.criterionId,
          item.evidence.map((reference) => `review:${target}:${reference}`)
        ])
      )
    );
  }
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
      ...(result.status === "NOT_RUN"
        ? [
            "Run: agent-ops doctor --check-auth to verify target authentication."
          ]
        : []),
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
