import type { ReviewTargetId } from "../contracts.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runVerificationCommand,
  type ProcessFailureClass,
  type VerificationProcessRunner
} from "../verify/spawn.js";
import { extractReviewObject } from "./extract.js";
import { buildTargetInvocation } from "./invocation.js";
import {
  reviewReportResults,
  reviewReportStatus,
  validateReviewReport
} from "./report.js";
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

const EXECUTION_ENV = [
  "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "LANG", "LC_ALL", "TERM", "TMPDIR", "TEMP", "TMP"
] as const;

const AUTH_ENV: Readonly<Record<ReviewTargetId, readonly string[]>> = {
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
  agy: ["AGY_API_KEY"]
};

export function isolatedReviewEnvironment(
  target: ReviewTargetId,
  directory: string,
  source: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [...EXECUTION_ENV, ...AUTH_ENV[target]]) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.HOME = directory;
  env.USERPROFILE = directory;
  env.XDG_CONFIG_HOME = join(directory, "config");
  env.XDG_CACHE_HOME = join(directory, "cache");
  return env;
}

/** Codex and agy currently lack documented instruction/customization isolation. */
export function hasRequiredReviewIsolation(target: ReviewTargetId): boolean {
  return target === "claude";
}

const REQUIRED_HELP_FLAGS: Readonly<Record<ReviewTargetId, readonly string[]>> = {
  claude: [
    "--add-dir", "--permission-mode", "--no-session-persistence",
    "--safe-mode", "--disable-slash-commands", "--json-schema"
  ],
  codex: [],
  agy: []
};

/**
 * Failure classes that mean no review happened, so trying the next target is
 * not review shopping. Everything else — including FAIL — is terminal.
 */
const ADVANCING: ReadonlySet<ProcessFailureClass> = new Set([
  "missing-executable",
  "spawn-failed",
  "timeout"
]);

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
    const repositoryRoot = await realpath(options.cwd);
    let unavailable = false;
    for (const [index, target] of chain.entries()) {
      if (!hasRequiredReviewIsolation(target)) {
        unavailable = true;
        report(`${target}: required context-isolation controls unavailable → skipping`);
        continue;
      }
      const attemptDirectory = await mkdtemp(join(tmpdir(), "agent-ops-review-"));
      try {
      const invocation = buildTargetInvocation({
        target,
        prompt,
        repositoryRoot,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort })
      });
      if (invocation === undefined) {
        unavailable = true;
        report(`${target}: no read-only mode available → skipping`);
        continue;
      }
      if (target === host) {
        report(
          `${target}: reviewer == host; no independent target configured`
        );
      }
      const environment = isolatedReviewEnvironment(
        target,
        attemptDirectory,
        options.env ?? process.env
      );
      const capability = await runVerificationCommand(
        {
          id: `review-capability-${target}-${index}`,
          command: invocation.command,
          args: ["--help"],
          cwd: attemptDirectory,
          required: true,
          evidence: { kind: "exit-code" },
          timeoutMs: Math.min(options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS, 10_000)
        },
        {
          cwd: attemptDirectory,
          ...(options.runner === undefined ? {} : { runner: options.runner }),
          env: environment,
          replaceEnv: true
        }
      );
      if (
        capability.status !== "PASS" ||
        capability.stdoutTruncated ||
        capability.stderrTruncated ||
        REQUIRED_HELP_FLAGS[target].some(
          (flag) => !capability.stdout.includes(flag)
        )
      ) {
        unavailable = true;
        report(`${target}: required CLI capabilities unavailable → skipping`);
        continue;
      }
      const spawned = await runVerificationCommand(
        {
          id: `review-${target}-${index}`,
          command: invocation.command,
          args: [...invocation.args],
          cwd: attemptDirectory,
          required: true,
          evidence: { kind: "exit-code" },
          timeoutMs: options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS
        },
        {
          cwd: attemptDirectory,
          ...(options.runner === undefined ? {} : { runner: options.runner }),
          ...(options.outputLimitBytes === undefined
            ? {}
            : { outputLimitBytes: options.outputLimitBytes }),
          stdin: invocation.stdin,
          env: environment,
          replaceEnv: true
        }
      );
      if (ADVANCING.has(spawned.failureClass)) {
        report(`${target}: ${spawned.failureClass} → trying next target`);
        continue;
      }
      if (spawned.stdoutTruncated || spawned.stderrTruncated) {
        return { status: "NOT_RUN", reason: "output-too-large", harness: target };
      }
      if (spawned.failureClass === "nonzero-exit") {
        return { status: "NOT_RUN", reason: "login-required", harness: target };
      }
      const payload = extractReviewObject(target, spawned.stdout);
      const parsed = payload === undefined
        ? undefined
        : validateReviewReport(
            payload,
            expected,
            request.invocation.scope?.changedFiles
          );
      if (parsed === undefined || !parsed.ok) {
        return {
          status: "NOT_RUN",
          reason: parsed?.errors.some((error) => error.code === "INCOMPLETE_SCOPE")
            ? "incomplete-scope"
            : "unparseable-output",
          harness: target,
          ...(parsed === undefined ? {} : { validationErrors: parsed.errors })
        };
      }
      const reportValue = parsed.value;
      const results = reviewReportResults(reportValue);
      return {
        status: reviewReportStatus(reportValue),
        results,
        report: reportValue,
        harness: target,
        independence: host === undefined
          ? "unknown"
          : host === target
            ? "same-target"
            : "different-target"
      };
      } finally {
        await rm(attemptDirectory, { recursive: true, force: true });
      }
    }
    return {
      status: "NOT_RUN",
      reason: unavailable ? "capability-unavailable" : "missing-cli"
    };
  };
}
