import type { ReviewTargetId } from "../contracts.js";
import {
  runVerificationCommand,
  type ProcessFailureClass,
  type VerificationProcessRunner
} from "../verify/spawn.js";
import { extractFinalMessage, extractJsonObject } from "./extract.js";
import { buildTargetInvocation } from "./invocation.js";
import type { ReviewCriterionResult } from "./result.js";
import { detectHostTarget, orderChain } from "./roles.js";
import {
  buildReviewPrompt,
  type ReviewExecutionRequest,
  type ReviewExecutionResult
} from "./runner.js";

/**
 * Deliberately below the five-minute `spawn.ts` default: a timeout advances the
 * chain, so the worst case is targets x timeout.
 */
export const DEFAULT_REVIEW_TIMEOUT_MS = 120_000;

export interface ReviewExecutorOptions {
  readonly targets: readonly ReviewTargetId[];
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
  readonly runner?: VerificationProcessRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onProgress?: (message: string) => void;
}

/**
 * Failure classes that mean no review happened, so trying the next target is
 * not review shopping. Everything else — including FAIL — is terminal.
 */
const ADVANCING: ReadonlySet<ProcessFailureClass> = new Set([
  "missing-executable",
  "spawn-failed",
  "timeout"
]);

function statusOf(value: unknown): "FAIL" | "PASS" | undefined {
  return value === "PASS" || value === "FAIL" ? value : undefined;
}

/**
 * The response must name every requested criterion exactly once, with at least
 * one non-blank evidence reference. A response that breaks the contract is
 * unparseable output, never a FAIL verdict: FAIL has to keep meaning "the
 * reviewer looked and judged it inadequate".
 */
function parseResults(
  payload: Record<string, unknown>,
  expected: readonly string[]
): readonly ReviewCriterionResult[] | undefined {
  const raw = payload.results;
  if (!Array.isArray(raw) || raw.length !== expected.length) {
    return undefined;
  }
  const results: ReviewCriterionResult[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const item = entry as Record<string, unknown>;
    const criterionId = item.criterionId;
    const status = statusOf(item.status);
    if (
      typeof criterionId !== "string" ||
      status === undefined ||
      !expected.includes(criterionId) ||
      seen.has(criterionId) ||
      !Array.isArray(item.evidence) ||
      item.evidence.length === 0 ||
      !item.evidence.every(
        (reference) =>
          typeof reference === "string" && reference.trim().length > 0
      )
    ) {
      return undefined;
    }
    seen.add(criterionId);
    results.push({
      criterionId,
      status,
      evidence: item.evidence.map((reference) => String(reference))
    });
  }
  return results;
}

/**
 * Builds the `execute` callback `runIndependentReview` expects: walk the
 * configured targets in order and return the first real verdict.
 */
export function createReviewExecutor(
  options: ReviewExecutorOptions
): (request: ReviewExecutionRequest) => Promise<ReviewExecutionResult> {
  const report = options.onProgress ?? (() => {});
  const host = detectHostTarget(options.env ?? process.env);
  const chain = orderChain(options.targets, host);

  return async (request) => {
    const expected = request.invocation.packet.criteria.map(
      (criterion) => criterion.id
    );
    const prompt = buildReviewPrompt(request.invocation);
    for (const [index, target] of chain.entries()) {
      const invocation = buildTargetInvocation({
        target,
        prompt,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort })
      });
      if (invocation === undefined) {
        report(`${target}: no read-only mode available → skipping`);
        continue;
      }
      if (target === host) {
        report(
          `${target}: reviewer == host; no independent target configured`
        );
      }
      const spawned = await runVerificationCommand(
        {
          id: `review-${target}-${index}`,
          command: invocation.command,
          args: [...invocation.args],
          cwd: options.cwd,
          required: true,
          evidence: { kind: "exit-code" },
          timeoutMs: options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS
        },
        {
          cwd: options.cwd,
          ...(options.runner === undefined ? {} : { runner: options.runner }),
          ...(options.outputLimitBytes === undefined
            ? {}
            : { outputLimitBytes: options.outputLimitBytes })
        }
      );
      if (ADVANCING.has(spawned.failureClass)) {
        report(`${target}: ${spawned.failureClass} → trying next target`);
        continue;
      }
      if (spawned.stdoutTruncated) {
        return { status: "NOT_RUN", reason: "unparseable-output" };
      }
      const message = extractFinalMessage(target, spawned.stdout);
      const payload =
        message === undefined ? undefined : extractJsonObject(message);
      const results =
        payload === undefined ? undefined : parseResults(payload, expected);
      if (results === undefined) {
        return { status: "NOT_RUN", reason: "unparseable-output" };
      }
      return results.every((result) => result.status === "PASS")
        ? { status: "PASS", results }
        : { status: "FAIL", results };
    }
    return { status: "NOT_RUN", reason: "missing-cli" };
  };
}
