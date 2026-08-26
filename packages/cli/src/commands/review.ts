import type {
  Harness,
  ReviewTargetId,
  AgentOpsConfig,
  VerificationEvidence
} from "../../../../runtime/src/contracts.js";
import {
  buildReviewPacket,
  type ReviewCriterion,
  type ReviewEvidenceRequirement
} from "../../../../runtime/src/review/packet.js";
import {
  runIndependentReview,
  type ReviewRunResult,
  type ReviewVerificationCommandSummary,
  type ReviewVerificationSummary
} from "../../../../runtime/src/review/runner.js";
import { renderReviewResult } from "../../../../runtime/src/review/render.js";
import { saveReviewAttestation } from "../../../../runtime/src/review/attestation.js";
import {
  resolveReviewRole,
  type ReviewRole,
  type ReviewRoleConfig
} from "../../../../runtime/src/review/roles.js";
import type { TaskService } from "../../../../runtime/src/task/service.js";
import { AgentOpsError } from "../../../../runtime/src/fs/paths.js";
import type { GitRunner } from "../../../../runtime/src/verify/change-surface.js";
import {
  assertSafeSupportingPaths,
  isReviewerPolicyPath,
  resolveReviewScope,
  reviewScopeSignature,
  type ReviewScope
} from "../../../../runtime/src/review/scope.js";
import { calculateSourceFingerprint } from "../../../../runtime/src/verify/source-fingerprint.js";
import {
  calculateConfigHash,
  FileEvidenceStore,
  isPassingVerificationEvidence
} from "../../../../runtime/src/verify/evidence.js";
import { validateEvidence } from "../../../../runtime/src/schema/validate.js";
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
  readonly root?: string;
  readonly gitRunner?: GitRunner;
  readonly policyConfigHash?: string;
  readonly currentPolicyConfigHash?: () => Promise<string>;
  readonly config?: AgentOpsConfig;
  readonly evidenceStore?: FileEvidenceStore;
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
  readonly title: string;
  readonly active: boolean;
  readonly policyConfigHash: string | null;
  readonly evidence: Readonly<Record<string, readonly string[]>>;
  readonly failureFingerprint: { readonly value: string } | null;
  readonly criteria: readonly ReviewCriterion[];
}

const GENERIC_REQUEST = "Review the current Git change surface.";
const GENERIC_CRITERIA: readonly ReviewCriterion[] = [{
  id: "change-quality",
  description:
    "The change is correct, safe, backward compatible, focused, and verified in proportion to its risk; report every material defect as a finding."
}];

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
  } catch (error) {
    if (
      options.taskId === undefined &&
      error instanceof AgentOpsError &&
      error.code === "TASK_SESSION_UNATTACHED"
    ) {
      return undefined;
    }
    throw error;
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
    throw new AgentOpsError(
      "REVIEW_CRITERIA_NOT_FOUND",
      "Every requested review criterion must exist on the selected task."
    );
  }
  return {
    taskId: record.task.id,
    title: record.task.title,
    active: record.status === "active",
    policyConfigHash: record.policyConfigHash,
    evidence: record.evidence,
    failureFingerprint: record.failureFingerprint,
    criteria
  };
}

type ReviewPreflight =
  | { readonly ok: true; readonly summary: ReviewVerificationSummary }
  | { readonly ok: false; readonly reason: ReviewRunResult["reason"] };

interface CurrentEvidence {
  readonly reference: string;
  readonly evidence: VerificationEvidence;
}

function newestEvidence(
  values: readonly CurrentEvidence[]
): CurrentEvidence | undefined {
  return [...values].sort((left, right) => {
    const leftTime = Date.parse(left.evidence.finishedAt);
    const rightTime = Date.parse(right.evidence.finishedAt);
    return rightTime - leftTime || left.reference.localeCompare(right.reference);
  })[0];
}

async function currentEvidence(
  options: ReviewCommandOptions,
  context: TaskContext,
  criterionId: string,
  commandId: string,
  configHash: string,
  sourceFingerprint: string
): Promise<{
  readonly current: readonly CurrentEvidence[];
  readonly hasReference: boolean;
  readonly unreadable: boolean;
  readonly stale: boolean;
}> {
  const current: CurrentEvidence[] = [];
  let hasReference = false;
  let unreadable = false;
  let stale = false;
  for (const reference of context.evidence[criterionId] ?? []) {
    if (reference.startsWith("review:")) {
      continue;
    }
    hasReference = true;
    let stored: unknown | null;
    try {
      stored = await options.evidenceStore?.load(reference) ?? null;
    } catch {
      unreadable = true;
      continue;
    }
    const validation = validateEvidence(stored);
    if (!validation.ok) {
      unreadable = true;
      continue;
    }
    const evidence = validation.value;
    if (
      evidence.schemaVersion !== 2 ||
      evidence.taskId !== context.taskId ||
      evidence.criterionId !== criterionId ||
      evidence.commandId !== commandId ||
      evidence.configHash !== configHash ||
      evidence.sourceFingerprint !== sourceFingerprint
    ) {
      stale = true;
      continue;
    }
    current.push({ reference, evidence });
  }
  return { current, hasReference, unreadable, stale };
}

async function preflightReview(
  options: ReviewCommandOptions,
  context: TaskContext,
  sourceFingerprint: string
): Promise<ReviewPreflight> {
  if (
    options.config === undefined ||
    options.evidenceStore === undefined ||
    options.root === undefined ||
    options.gitRunner === undefined ||
    context.failureFingerprint !== null
  ) {
    return { ok: false, reason: "stale-verification" };
  }
  const configHash = calculateConfigHash(options.config);
  const commands: ReviewVerificationCommandSummary[] = [];
  for (const criterion of context.criteria) {
    for (const commandId of criterion.verifierIds ?? []) {
      const command = options.config.verification.commands.find(
        (candidate) => candidate.id === commandId
      );
      if (command === undefined) {
        return { ok: false, reason: "missing-verification-evidence" };
      }
      const found = await currentEvidence(
        options,
        context,
        criterion.id,
        commandId,
        configHash,
        sourceFingerprint
      );
      const selected = newestEvidence(found.current);
      if (command.required !== true) {
        if (selected !== undefined) {
          commands.push({
            criterionId: criterion.id,
            commandId,
            required: false,
            status: selected.evidence.status,
            evidenceReference: selected.reference
          });
        }
        continue;
      }
      if (selected === undefined) {
        return {
          ok: false,
          reason: found.unreadable
            ? "unreadable-verification-evidence"
            : found.stale
              ? "stale-verification"
              : found.hasReference
                ? "missing-verification-evidence"
                : "missing-verification-evidence"
        };
      }
      if (!isPassingVerificationEvidence(command, selected.evidence)) {
        return { ok: false, reason: "verification-not-passed" };
      }
      commands.push({
        criterionId: criterion.id,
        commandId,
        required: true,
        status: "PASS",
        evidenceReference: selected.reference
      });
    }
  }
  return {
    ok: true,
    summary: { status: "PASS", sourceFingerprint, commands }
  };
}

function scopeReason(error: unknown): ReviewRunResult["reason"] | undefined {
  if (!(error instanceof AgentOpsError)) {
    return undefined;
  }
  return {
    REVIEW_UNSAFE_PATH: "unsafe-review-path",
    REVIEW_NO_CHANGE_SURFACE: "no-change-surface",
    REVIEW_DIRTY_WORKTREE: "dirty-worktree",
    REVIEW_INVALID_BASE: "invalid-base"
  }[error.code] as ReviewRunResult["reason"] | undefined;
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
      text: renderReviewResult(result)
    },
    errors: [{ code: "REVIEW_NOT_RUN", message }]
  };
}

function sourceChangedResult(result: ReviewRunResult): ReviewRunResult {
  return {
    status: "NOT_RUN",
    reason: "source-changed-during-review",
    harness: result.harness,
    model: result.model,
    effort: result.effort,
    prompt: result.prompt,
    ...(result.scope === undefined ? {} : { scope: result.scope }),
    ...(result.independence === undefined
      ? {}
      : { independence: result.independence }),
    ...(result.verification === undefined
      ? {}
      : { verification: result.verification })
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
  let scope: ReviewScope | undefined;
  let sourceFingerprint: string | undefined;
  let verification: ReviewVerificationSummary | undefined;
  if (options.root !== undefined && options.gitRunner !== undefined) {
    try {
      scope = await resolveReviewScope({
        root: options.root,
        runner: options.gitRunner,
        ...(options.args.base === undefined ? {} : { base: options.args.base })
      });
    } catch (error) {
      const reason = scopeReason(error);
      if (reason !== undefined) {
        return notRunEnvelope({
          status: "NOT_RUN",
          reason,
          harness: target,
          model: role?.model ?? options.model ?? "configured",
          effort: role?.effort ?? options.effort ?? "configured",
          prompt: ""
        });
      }
      throw error;
    }
    if (scope.changedFiles.some(isReviewerPolicyPath)) {
      return notRunEnvelope({
        status: "NOT_RUN",
        reason: "reviewer-policy-changed",
        harness: target,
        model: role?.model ?? options.model ?? "configured",
        effort: role?.effort ?? options.effort ?? "configured",
        prompt: "",
        scope
      });
    }
    sourceFingerprint = await calculateSourceFingerprint(
      options.root,
      scope,
      options.gitRunner
    );
    if (context !== undefined && options.policyConfigHash !== undefined) {
      if (context.policyConfigHash === null) {
        return notRunEnvelope({
          status: "NOT_RUN", reason: "reviewer-policy-baseline-missing",
          harness: target, model: role?.model ?? options.model ?? "configured",
          effort: role?.effort ?? options.effort ?? "configured", prompt: "", scope
        });
      }
      if (context.policyConfigHash !== options.policyConfigHash) {
        return notRunEnvelope({
          status: "NOT_RUN", reason: "reviewer-policy-changed",
          harness: target, model: role?.model ?? options.model ?? "configured",
          effort: role?.effort ?? options.effort ?? "configured", prompt: "", scope
        });
      }
    }
    if (context !== undefined) {
      const preflight = await preflightReview(
        options,
        context,
        sourceFingerprint
      );
      if (!preflight.ok) {
        return notRunEnvelope({
          status: "NOT_RUN", reason: preflight.reason,
          harness: target, model: role?.model ?? options.model ?? "configured",
          effort: role?.effort ?? options.effort ?? "configured", prompt: "", scope
        });
      }
      verification = preflight.summary;
    }
  }
  const criteria: ReviewCriterion[] = [
    ...(context?.criteria ?? GENERIC_CRITERIA)
  ];
  let packet;
  try {
    packet = buildReviewPacket({
      request: context?.title ?? GENERIC_REQUEST,
      criteria,
      artifactRefs: scope?.changedFiles ?? [],
      evidenceRequirements
    });
  } catch (error) {
    if (error instanceof AgentOpsError) {
      const reason = error.code === "REVIEW_SENSITIVE_INPUT"
        ? "sensitive-review-input"
        : error.code === "REVIEW_SCOPE_TOO_LARGE"
          ? "scope-too-large"
          : undefined;
      if (reason !== undefined) {
        return notRunEnvelope({
          status: "NOT_RUN",
          reason,
          harness: target,
          model: role?.model ?? options.model ?? "configured",
          effort: role?.effort ?? options.effort ?? "configured",
          prompt: ""
        });
      }
    }
    throw error;
  }
  const result = await runIndependentReview({
    invocation: {
      harness: target,
      model: role?.model ?? options.model ?? "configured",
      effort: role?.effort ?? options.effort ?? "configured",
      packet,
      ...(scope === undefined ? {} : { scope }),
      ...(verification === undefined ? {} : { verification })
    },
    authorized: options.authorized,
    execute: options.execute ?? (async () => ({
      status: "NOT_RUN",
      reason: "missing-cli" as const
    }))
  });
  if (scope !== undefined && result.report !== undefined && options.root !== undefined) {
    try {
      if (
        result.report.changedFilesInspected.length !== scope.changedFiles.length ||
        result.report.changedFilesInspected.some(
          (path) => !scope?.changedFiles.includes(path)
        )
      ) {
        return notRunEnvelope({
          ...result,
          status: "NOT_RUN",
          reason: "incomplete-scope"
        });
      }
      try {
        await assertSafeSupportingPaths(options.root, result.report.supportingFilesInspected);
      } catch (error) {
        if (scopeReason(error) === "unsafe-review-path") {
          return notRunEnvelope({
            ...result,
            status: "NOT_RUN",
            reason: "unsafe-review-path"
          });
        }
        throw error;
      }
      const postflight = await resolveReviewScope({
        root: options.root,
        runner: options.gitRunner as GitRunner,
        ...(options.args.base === undefined ? {} : { base: options.args.base })
      });
      const currentHash = options.currentPolicyConfigHash === undefined
        ? options.policyConfigHash
        : await options.currentPolicyConfigHash();
      const postflightFingerprint = await calculateSourceFingerprint(
          options.root,
          postflight,
          options.gitRunner as GitRunner
        );
      if (
        reviewScopeSignature(scope) !== reviewScopeSignature(postflight) ||
        (options.policyConfigHash !== undefined && currentHash !== options.policyConfigHash) ||
        postflightFingerprint !== sourceFingerprint
      ) {
        return notRunEnvelope(sourceChangedResult(result));
      }
    } catch {
      return notRunEnvelope(sourceChangedResult(result));
    }
  }
  // Evidence is only appended while the task is active: a completed record
  // must stay exactly as it was verified.
  if (
    context !== undefined &&
    options.tasks !== undefined &&
    result.status === "PASS" &&
    context.active &&
    result.results !== undefined
  ) {
    await options.tasks.recordEvidence(
      context.taskId,
      Object.fromEntries(
        result.results.map((item) => [
          item.criterionId,
          item.evidence.map((reference) => `review:${result.harness}:${reference}`)
        ])
      )
    );
  }
  // The attestation is what a Stop gate reads. It is keyed by the verified
  // source fingerprint, so it stops satisfying the gate the moment the tree
  // changes again.
  if (
    options.root !== undefined &&
    result.status === "PASS" &&
    sourceFingerprint !== undefined
  ) {
    await saveReviewAttestation(options.root, {
      schemaVersion: 1,
      ...(context === undefined ? {} : { taskId: context.taskId }),
      harness: result.harness,
      status: "PASS",
      sourceFingerprint,
      createdAt: new Date().toISOString()
    });
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
    text: renderReviewResult(result)
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
