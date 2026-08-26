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
  type ReviewAttempt,
  type ReviewExecutionRequest,
  type ReviewExecutionResult,
  type ReviewUnavailableReason
} from "./runner.js";

/** Full repository reviews need more headroom than the lightweight auth probe. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 300_000;

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
  if (target === "agy") {
    env.HOME = source.HOME ?? directory;
    env.USERPROFILE = source.USERPROFILE ?? env.HOME;
    env.XDG_CONFIG_HOME = source.XDG_CONFIG_HOME ?? join(env.HOME, ".config");
    env.XDG_CACHE_HOME = source.XDG_CACHE_HOME ?? join(env.HOME, ".cache");
  } else {
    env.HOME = directory;
    env.USERPROFILE = directory;
    env.XDG_CONFIG_HOME = join(directory, "config");
    env.XDG_CACHE_HOME = join(directory, "cache");
  }
  if (target === "codex") {
    const codexHome = source.CODEX_HOME ??
      (source.HOME === undefined ? undefined : join(source.HOME, ".codex"));
    if (codexHome !== undefined) {
      env.CODEX_HOME = codexHome;
    }
  }
  return env;
}

const REQUIRED_HELP_FLAGS: Readonly<Record<ReviewTargetId, readonly string[]>> = {
  claude: [
    "--add-dir", "--permission-mode", "--no-session-persistence",
    "--safe-mode", "--disable-slash-commands", "--json-schema"
  ],
  codex: [
    "--cd", "--ephemeral", "--ignore-user-config", "--ignore-rules"
  ],
  agy: [
    "--add-dir", "--sandbox", "--mode", "--disable-slash-commands",
    "--json-schema"
  ]
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
    const repositoryRoot = await realpath(options.cwd);
    const attempts: ReviewAttempt[] = [];
    let lastReason: ReviewUnavailableReason = "missing-cli";
    for (const [index, target] of chain.entries()) {
      const attemptDirectory = await mkdtemp(join(tmpdir(), "agent-ops-review-"));
      try {
      const invocation = buildTargetInvocation({
        target,
        prompt: buildReviewPrompt({ ...request.invocation, harness: target }),
        repositoryRoot,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.effort === undefined ? {} : { effort: options.effort })
      });
      if (invocation === undefined) {
        lastReason = "capability-unavailable";
        attempts.push({ target, status: "NOT_RUN", reason: lastReason });
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
          args: target === "codex" ? ["exec", "--help"] : ["--help"],
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
          (flag) => !`${capability.stdout}\n${capability.stderr}`.includes(flag)
        )
      ) {
        lastReason = "capability-unavailable";
        attempts.push({ target, status: "NOT_RUN", reason: lastReason });
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
        lastReason = "missing-cli";
        attempts.push({
          target,
          status: "NOT_RUN",
          reason: spawned.failureClass ?? lastReason
        });
        report(`${target}: ${spawned.failureClass} → trying next target`);
        continue;
      }
      if (spawned.stdoutTruncated ||
          (spawned.stderrTruncated && target !== "codex")) {
        lastReason = "output-too-large";
        attempts.push({ target, status: "NOT_RUN", reason: lastReason });
        report(`${target}: ${lastReason} → trying next target`);
        continue;
      }
      if (spawned.failureClass === "nonzero-exit") {
        lastReason = "login-required";
        attempts.push({ target, status: "NOT_RUN", reason: lastReason });
        report(`${target}: ${lastReason} → trying next target`);
        continue;
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
        lastReason = parsed?.errors.some(
          (error) => error.code === "INCOMPLETE_SCOPE"
        ) ? "incomplete-scope" : "unparseable-output";
        attempts.push({ target, status: "NOT_RUN", reason: lastReason });
        report(`${target}: ${lastReason} → trying next target`);
        continue;
      }
      const reportValue = parsed.value;
      const results = reviewReportResults(reportValue);
      const status = reviewReportStatus(reportValue);
      attempts.push({ target, status });
      return {
        status,
        results,
        report: reportValue,
        harness: target,
        attempts,
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
      reason: lastReason,
      ...(attempts.length === 0 ? {} : { harness: attempts.at(-1)?.target }),
      attempts
    };
  };
}
