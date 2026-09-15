import type { ReviewTargetId } from "../contracts.js";
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  runVerificationCommand,
  type ProcessFailureClass,
  type VerificationProcessRunner
} from "../verify/spawn.js";
import { redactSecrets } from "../security/redact.js";
import { extractReviewObject } from "./extract.js";
import { buildTargetInvocation } from "./invocation.js";
import {
  reviewReportResults,
  reviewReportStatus,
  validateReviewReport,
  type ReviewReport
} from "./report.js";
import { detectHostTarget, orderChain } from "./roles.js";
import {
  BIND_DEPENDENT_TARGETS,
  detectHostRestriction
} from "./host-sandbox.js";
import {
  buildAdversarialPrompt,
  buildReviewPrompt,
  type ReviewAdversarialOutcome,
  type ReviewAttempt,
  type ReviewExecutionRequest,
  type ReviewExecutionResult,
  type ReviewIndependence,
  type ReviewUnavailableReason
} from "./runner.js";

/**
 * Full repository reviews need far more headroom than the lightweight auth
 * probe. Five minutes was not enough: reviewing a real working tree, codex and
 * claude both exceeded it on this repository, and a timeout costs the whole
 * review while looking like an unavailable target.
 */
export const DEFAULT_REVIEW_TIMEOUT_MS = 900_000;

/**
 * How long a reviewer may produce nothing at all before it is treated as
 * wedged rather than slow. A reviewer the host sandbox has blocked never
 * writes another byte, and waiting out the full review timeout spends 15
 * minutes per target — 45 for a three-target chain — to learn that. Progress
 * output and a growing log file both count, so a reviewer that is merely
 * thinking hard is never cut off.
 */
export const DEFAULT_STALL_IDLE_MS = 90_000;

export interface ReviewExecutorOptions {
  readonly targets: readonly ReviewTargetId[];
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
  readonly timeoutMs?: number;
  readonly outputLimitBytes?: number;
  /** Silence that marks a reviewer as wedged. Tests shrink it. */
  readonly stallIdleMs?: number;
  /** Loopback-bind probe used to detect a restricted host. Tests replace it. */
  readonly probeBind?: () => Promise<boolean>;
  readonly runner?: VerificationProcessRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onProgress?: (message: string) => void;
  readonly signal?: AbortSignal;
}

export class ReviewInterruptedError extends Error {
  readonly signal?: string;

  constructor(signal?: string) {
    super("Independent review was interrupted.");
    this.name = "ReviewInterruptedError";
    this.signal = signal;
  }
}

// USER is load-bearing, not cosmetic: a credential store keyed by account name
// — the macOS keychain claude reads — cannot be opened without it, and its
// absence surfaces as "Not logged in" on an install that is logged in.
const EXECUTION_ENV = [
  "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "LANG", "LC_ALL", "TERM", "TMPDIR", "TEMP", "TMP", "USER"
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
  // claude and agy read their credentials out of the invoking user's home, so
  // replacing it does not isolate them — it only makes them report "not logged
  // in" on an install that is logged in. claude is isolated by its own flags
  // instead: `--safe-mode` disables CLAUDE.md, skills, plugins, hooks, MCP
  // servers and custom agents while explicitly keeping auth. codex keeps a
  // replaced home because CODEX_HOME carries its credentials separately, so
  // the isolation costs it nothing. agy uses its native sandbox and plan mode,
  // but keeps its home because that is where its OAuth session lives.
  if (target === "agy" || target === "claude") {
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

/** Only eligible targets appear: an ineligible one never reaches this gate. */
const REQUIRED_HELP_FLAGS: Readonly<
  Partial<Record<ReviewTargetId, readonly string[]>>
> = {
  claude: [
    "--add-dir", "--permission-mode", "--no-session-persistence",
    "--safe-mode", "--disable-slash-commands", "--json-schema"
  ],
  agy: ["--add-dir", "--sandbox", "--mode", "--json-schema", "--log-file"],
  codex: [
    "--cd", "--ephemeral", "--ignore-user-config", "--ignore-rules"
  ]
};

/**
 * Failure classes that mean no review happened, so trying the next target is
 * not review shopping. Everything else — including FAIL — is terminal.
 */
const ADVANCING: ReadonlySet<ProcessFailureClass> = new Set([
  "missing-executable",
  "spawn-failed"
]);

const DIAGNOSTIC_MAX_CHARS = 200;

/**
 * The target's first line of complaint, redacted and clipped. It travels on the
 * attempt record rather than only in a progress line, because progress is
 * suppressed under `--json`: a machine consumer would otherwise be left with
 * the bare authentication guess this exists to qualify. Never evidence.
 */
function firstComplaint(...streams: readonly string[]): string | undefined {
  for (const stream of streams) {
    const line = redactSecrets(stream)
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .find((value) => value.length > 0);
    if (line !== undefined) {
      return line.slice(0, DIAGNOSTIC_MAX_CHARS);
    }
  }
  return undefined;
}

function rejectedCallReason(output: string): ReviewUnavailableReason {
  if (/\b(?:quota|rate limit|usage limit|too many requests)\b/iu.test(output)) {
    return "quota-exhausted";
  }
  if (
    /\b(?:not logged in|login required|log in to|authentication required|unauthenticated|unauthorized)\b/iu.test(output) ||
    /\b(?:invalid|expired)\s+(?:api key|token|credential)/iu.test(output) ||
    /\b401\b/u.test(output)
  ) {
    return "login-required";
  }
  return "capability-unavailable";
}

interface StallWatch {
  /** Passed to the child: aborts on a stall or on the caller's own signal. */
  readonly signal: AbortSignal;
  readonly stalled: () => boolean;
  readonly beat: () => void;
  readonly stop: () => void;
}

/**
 * Watches one reviewer for silence. Two things count as a sign of life: a byte
 * on either stream, reported through `beat`, and growth of the target's own log
 * file, polled here because a target that buffers stdout until it answers has
 * no other observable heartbeat.
 */
function watchForStall(
  logFile: string | undefined,
  parent: AbortSignal | undefined,
  idleMs: number
): StallWatch {
  const controller = new AbortController();
  const pollMs = Math.max(20, Math.min(5_000, Math.floor(idleMs / 3)));
  let lastBeat = Date.now();
  let logSize = -1;
  let stalled = false;
  const beat = (): void => {
    lastBeat = Date.now();
  };
  const check = async (): Promise<void> => {
    if (logFile !== undefined) {
      try {
        const info = await stat(logFile);
        if (info.size > logSize) {
          logSize = info.size;
          beat();
        }
      } catch {
        // The target has not created its log yet, which is not a heartbeat.
      }
    }
    if (!stalled && Date.now() - lastBeat >= idleMs) {
      stalled = true;
      controller.abort("stalled");
    }
  };
  const timer = setInterval(() => {
    void check();
  }, pollMs);
  timer.unref();
  return {
    signal: parent === undefined
      ? controller.signal
      : AbortSignal.any([parent, controller.signal]),
    stalled: () => stalled,
    beat,
    stop: () => {
      clearInterval(timer);
    }
  };
}

function throwIfInterrupted(
  target: ReviewTargetId,
  options: ReviewExecutorOptions,
  failureClass?: ProcessFailureClass
): void {
  if (failureClass !== "aborted" && options.signal?.aborted !== true) {
    return;
  }
  const signal = typeof options.signal?.reason === "string"
    ? options.signal.reason
    : undefined;
  options.onProgress?.(
    `${target}: review interrupted${signal === undefined ? "" : ` by ${signal}`}`
  );
  throw new ReviewInterruptedError(signal);
}

type TargetAttemptOutcome =
  | { readonly kind: "verdict"; readonly report: ReviewReport }
  | {
      readonly kind: "skip";
      readonly reason: ReviewUnavailableReason;
      /** Recorded on the attempt when it is more specific than `reason`. */
      readonly attemptReason?: string;
      /**
       * Why this attempt produced nothing, in the target's words where it
       * offered any and synthesized from the runtime's own knowledge where it
       * did not. Required, so no skip path can quietly reach structured output
       * carrying only its coarse `reason`.
       */
      readonly diagnostic: string;
      readonly message: string;
    };

interface TargetAttemptRequest {
  readonly target: ReviewTargetId;
  /** Distinguishes the spawned command IDs of concurrent-safe attempts. */
  readonly label: string;
  readonly prompt: string;
  readonly repositoryRoot: string;
  readonly expectedCriterionIds: readonly string[];
  readonly changedFiles?: readonly string[];
}

async function snapshotRepository(
  request: TargetAttemptRequest,
  destination: string,
  options: ReviewExecutorOptions
): Promise<string | undefined> {
  const cloned = await runVerificationCommand(
    {
      id: `review-snapshot-${request.label}`,
      command: "git",
      args: ["clone", "--no-hardlinks", "--quiet", "--", request.repositoryRoot, destination],
      cwd: dirname(destination),
      required: true,
      evidence: { kind: "exit-code" },
      timeoutMs: Math.min(options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS, 60_000)
    },
    {
      cwd: dirname(destination),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...(options.signal === undefined ? {} : { signal: options.signal })
    }
  );
  throwIfInterrupted(request.target, options, cloned.failureClass);
  if (cloned.status !== "PASS") {
    return firstComplaint(cloned.stderr, cloned.stdout) ??
      `git clone failed (${cloned.failureClass})`;
  }
  for (const path of request.changedFiles ?? []) {
    const source = join(request.repositoryRoot, path);
    const target = join(destination, path);
    try {
      const stat = await lstat(source);
      if (!stat.isFile()) {
        return `changed path is not a regular file: ${path}`;
      }
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
      await chmod(target, stat.mode & 0o777);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        await rm(target, { recursive: true, force: true });
        continue;
      }
      throw error;
    }
  }
  return undefined;
}

/**
 * One target's attempt at one prompt, in a throwaway home directory. Returns a
 * validated report or the reason this target produced no usable verdict; the
 * caller decides whether that reason is worth advancing past.
 */
async function attemptTarget(
  request: TargetAttemptRequest,
  options: ReviewExecutorOptions
): Promise<TargetAttemptOutcome> {
  const { target } = request;
  const skip = (
    reason: ReviewUnavailableReason,
    diagnostic: string,
    verb = "trying next target"
  ): TargetAttemptOutcome => ({
    kind: "skip",
    reason,
    diagnostic,
    message: `${target}: ${reason} → ${verb} (${diagnostic})`
  });
  const attemptDirectory = await mkdtemp(join(tmpdir(), "agent-ops-review-"));
  try {
    const agyLog = target === "agy"
      ? join(attemptDirectory, "agy.log")
      : undefined;
    const invocationRequest = {
      target,
      prompt: request.prompt,
      repositoryRoot: request.repositoryRoot,
      ...(agyLog === undefined ? {} : { logFile: agyLog }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.effort === undefined ? {} : { effort: options.effort })
    } as const;
    let invocation = buildTargetInvocation(invocationRequest);
    let executionDirectory = attemptDirectory;
    if (invocation === undefined) {
      return skip(
        "capability-unavailable",
        "no read-only mode is available for this target",
        "skipping"
      );
    }
    const environment = isolatedReviewEnvironment(
      target,
      attemptDirectory,
      options.env ?? process.env
    );
    throwIfInterrupted(target, options);
    options.onProgress?.(`${target}: checking reviewer capability`);
    const capability = await runVerificationCommand(
      {
        id: `review-capability-${request.label}`,
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
        replaceEnv: true,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      }
    );
    throwIfInterrupted(target, options, capability.failureClass);
    const help = `${capability.stdout}\n${capability.stderr}`;
    const missingFlags = (REQUIRED_HELP_FLAGS[target] ?? []).filter(
      (flag) => !help.includes(flag)
    );
    if (
      capability.status !== "PASS" ||
      capability.stdoutTruncated ||
      capability.stderrTruncated ||
      missingFlags.length > 0
    ) {
      // This gate is the one a renamed upstream flag trips, so it names the
      // flags it could not find. Without them the skip is indistinguishable
      // from an uninstalled CLI, in the human line and in the attempt record.
      return skip(
        "capability-unavailable",
        missingFlags.length > 0
          ? `help output is missing ${missingFlags.join(", ")}`
          : capability.stdoutTruncated || capability.stderrTruncated
            ? "help output exceeded the capture limit"
            : firstComplaint(capability.stderr, capability.stdout) ??
              `help probe failed (${capability.failureClass})`,
        "skipping"
      );
    }
    // agy takes its log file unconditionally; claude's equivalent is passed
    // only when this install advertises it, so an older CLI keeps reviewing
    // and merely loses the file heartbeat.
    const heartbeatLog = target === "agy"
      ? agyLog
      : target === "claude" && help.includes("--debug-file")
        ? join(attemptDirectory, "claude-debug.log")
        : undefined;
    const snapshotRoot = join(attemptDirectory, "repository");
    const snapshotError = await snapshotRepository(
      request,
      snapshotRoot,
      options
    );
    if (snapshotError !== undefined) {
      return skip("capability-unavailable", snapshotError, "skipping");
    }
    invocation = buildTargetInvocation({
      ...invocationRequest,
      ...(target === "agy"
        ? {
            prompt: [
              `Repository root: ${snapshotRoot}`,
              "Run every repository-relative inspection in that directory.",
              "For terminal commands, use only git status, git diff, git log, or git show; " +
                "read specific files with file-reading tools instead of ls, find, cat, or rg.",
              // agy's only read-only mode is plan mode, and plan mode's default
              // job is to author an implementation plan and then ask the caller
              // whether to proceed. Under `--print` that question ends the one
              // turn it gets, so the review comes back empty after minutes of
              // work. Saying what the turn is for is what keeps it answering.
              "You are answering a review question, not planning work. Do not write " +
                "an implementation plan. Do not create or edit any file. Do not ask " +
                "the user anything. Reply with the JSON object the schema requires " +
                "and nothing else.",
              request.prompt
            ].join("\n")
          }
        : {}),
      ...(heartbeatLog === undefined ? {} : { logFile: heartbeatLog }),
      repositoryRoot: snapshotRoot
    });
    executionDirectory = snapshotRoot;
    if (invocation === undefined) {
      return skip("capability-unavailable", "review invocation disappeared", "skipping");
    }
    throwIfInterrupted(target, options);
    options.onProgress?.(
      `${target}: review started (timeout: ${Math.ceil((options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS) / 1_000)}s)`
    );
    const stallIdleMs = options.stallIdleMs ?? DEFAULT_STALL_IDLE_MS;
    const stallWatch = watchForStall(
      heartbeatLog,
      options.signal,
      stallIdleMs
    );
    let spawned;
    try {
      spawned = await runVerificationCommand(
        {
          id: `review-${request.label}`,
          command: invocation.command,
          args: [...invocation.args],
          cwd: executionDirectory,
          required: true,
          evidence: { kind: "exit-code" },
          timeoutMs: options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS
        },
        {
          cwd: executionDirectory,
          ...(options.runner === undefined ? {} : { runner: options.runner }),
          ...(options.outputLimitBytes === undefined
            ? {}
            : { outputLimitBytes: options.outputLimitBytes }),
          stdin: invocation.stdin,
          env: environment,
          replaceEnv: true,
          signal: stallWatch.signal,
          onActivity: stallWatch.beat
        }
      );
    } finally {
      stallWatch.stop();
    }
    // Ahead of `throwIfInterrupted`, which reads the same `aborted` failure
    // class as a user interrupt. A stall is this executor's own abort, and
    // ends one target rather than the whole review.
    if (stallWatch.stalled() && options.signal?.aborted !== true) {
      return skip(
        "stalled",
        `no output for ${Math.max(1, Math.round(stallIdleMs / 1_000))}s; the reviewer is ` +
          "probably blocked by the host sandbox, and retrying with more " +
          "permission will not help"
      );
    }
    throwIfInterrupted(target, options, spawned.failureClass);
    if (spawned.failureClass === "timeout") {
      return skip("timeout", "the reviewer exceeded its timeout");
    }
    if (ADVANCING.has(spawned.failureClass)) {
      return {
        ...skip("missing-cli", `the process did not complete: ${spawned.failureClass}`),
        ...(spawned.failureClass === undefined
          ? {}
          : { attemptReason: spawned.failureClass })
      };
    }
    if (spawned.stdoutTruncated ||
        (spawned.stderrTruncated && target !== "codex")) {
      return skip(
        "output-too-large",
        `${spawned.stdoutTruncated ? "stdout" : "stderr"} exceeded the capture limit`
      );
    }
    if (spawned.failureClass === "nonzero-exit") {
      const output = `${spawned.stderr}\n${spawned.stdout}`;
      return skip(
        rejectedCallReason(output),
        firstComplaint(spawned.stderr, spawned.stdout) ??
          `the call was rejected with exit ${spawned.exitCode ?? "unknown"} and no output`
      );
    }
    if (spawned.failureClass === "signal-exit") {
      return skip(
        "capability-unavailable",
        `the reviewer exited after ${spawned.signal ?? "an unknown signal"}`
      );
    }
    const payload = extractReviewObject(target, spawned.stdout);
    const parsed = payload === undefined
      ? undefined
      : validateReviewReport(
          payload,
          request.expectedCriterionIds,
          request.changedFiles
        );
    if (parsed === undefined || !parsed.ok) {
      const reason: ReviewUnavailableReason = parsed?.errors.some(
        (error) => error.code === "INCOMPLETE_SCOPE"
      ) ? "incomplete-scope" : "unparseable-output";
      // Which contract the answer broke, or what the target said instead of
      // answering. Without this the skip names only the classification, and a
      // target that runs but never returns a usable report is undebuggable.
      const errors = parsed === undefined
        ? ""
        : parsed.errors
            .slice(0, 3)
            .map((error) => `${error.path}: ${error.code}`)
            .join("; ");
      const fields = parsed?.errors.some((error) => error.code === "INVALID_FIELDS") &&
        payload !== undefined
        ? ` (fields: ${Object.keys(payload).sort().join(", ")})`
        : "";
      return skip(
        reason,
        errors.length > 0
          ? `${errors}${fields}`
          : firstComplaint(spawned.stdout, spawned.stderr) ??
            "the answer carried no review report"
      );
    }
    return { kind: "verdict", report: parsed.value };
  } finally {
    await rm(attemptDirectory, { recursive: true, force: true });
  }
}

/**
 * Builds the `execute` callback `runIndependentReview` expects: walk the
 * configured targets in order and return the first real verdict. A PASS is then
 * handed to a different target to refute, so a single agreeable reviewer cannot
 * wave a change through on its own.
 */
export function createReviewExecutor(
  options: ReviewExecutorOptions
): (request: ReviewExecutionRequest) => Promise<ReviewExecutionResult> {
  const report = options.onProgress ?? (() => {});
  const host = detectHostTarget(options.env ?? process.env);
  const ordered = orderChain(options.targets, host);

  return async (request) => {
    // Asked before anything is spent. A reviewer inherits this process's
    // sandbox, so a restriction found here is a restriction every target in
    // the chain would hit — one at a time, minutes apart.
    const restriction = await detectHostRestriction({
      env: options.env ?? process.env,
      ...(options.probeBind === undefined ? {} : { probeBind: options.probeBind })
    });
    if (restriction === "network-blocked") {
      report(
        "host: the sandbox around this process blocks network access, so no " +
        "reviewer can answer → not running the chain"
      );
      return {
        status: "NOT_RUN",
        reason: "host-sandboxed",
        ...(host === undefined ? {} : { harness: host }),
        attempts: []
      };
    }
    // Only agy needs a loopback listener, so a bind-blocked host is not a dead
    // end — it is a reason to spend the other targets first rather than
    // discovering the same failure at the head of the chain every time.
    const chain = restriction === "bind-blocked"
      ? [
          ...ordered.filter(
            (target) => !BIND_DEPENDENT_TARGETS.includes(target)
          ),
          ...ordered.filter((target) => BIND_DEPENDENT_TARGETS.includes(target))
        ]
      : ordered;
    if (restriction === "bind-blocked" && chain.join() !== ordered.join()) {
      report(
        "host: this process cannot open a loopback listener, so targets that " +
        `need one run last (chain: ${chain.join(" → ")})`
      );
    }
    const expectedCriterionIds = request.invocation.packet.criteria.map(
      (criterion) => criterion.id
    );
    const repositoryRoot = await realpath(options.cwd);
    const shared = {
      repositoryRoot,
      expectedCriterionIds,
      ...(request.invocation.scope?.changedFiles === undefined
        ? {}
        : { changedFiles: request.invocation.scope.changedFiles })
    } as const;
    const attempts: ReviewAttempt[] = [];
    let lastReason: ReviewUnavailableReason = "missing-cli";

    /**
     * Ask a target other than the one that passed — and other than the host —
     * to refute the verdict. Returns undefined when no such target produced a
     * report, which leaves the primary PASS standing unchallenged. Targets the
     * primary pass already walked past are excluded: a CLI that could not
     * answer the review prompt will not answer this one either.
     */
    const refute = async (
      primary: ReviewReport,
      primaryTarget: ReviewTargetId
    ): Promise<ReviewAdversarialOutcome | undefined> => {
      const walked = new Set(attempts.map((attempt) => attempt.target));
      const candidates = chain.filter(
        (target) =>
          target !== primaryTarget && target !== host && !walked.has(target)
      );
      for (const [index, target] of candidates.entries()) {
        const outcome = await attemptTarget(
          {
            ...shared,
            target,
            label: `adversarial-${target}-${index}`,
            prompt: buildAdversarialPrompt(
              { ...request.invocation, harness: target },
              primary
            )
          },
          options
        );
        if (outcome.kind === "skip") {
          // Recorded, not just reported: stderr progress is transient, and
          // without this a PASS with no `adversarial` field cannot be told
          // apart from a PASS that had no second target to challenge it.
          attempts.push({
            target,
            status: "NOT_RUN",
            reason: outcome.attemptReason ?? outcome.reason,
            diagnostic: outcome.diagnostic
          });
          report(`${target}: adversarial re-check unavailable (${outcome.reason})`);
          continue;
        }
        const refuted = reviewReportStatus(outcome.report) === "FAIL";
        report(
          `${target}: adversarial re-check ${refuted ? "refuted the PASS" : "upheld the PASS"}`
        );
        return { target, refuted, report: outcome.report };
      }
      if (candidates.length > 0) {
        report("no independent target completed an adversarial re-check");
      }
      return undefined;
    };

    for (const [index, target] of chain.entries()) {
      if (target === host) {
        report(`${target}: no other usable CLI remained; running isolated self-review`);
      }
      const outcome = await attemptTarget(
        {
          ...shared,
          target,
          label: `${target}-${index}`,
          prompt: buildReviewPrompt({ ...request.invocation, harness: target })
        },
        options
      );
      if (outcome.kind === "skip") {
        lastReason = outcome.reason;
        attempts.push({
          target,
          status: "NOT_RUN",
          reason: outcome.attemptReason ?? outcome.reason,
          diagnostic: outcome.diagnostic
        });
        report(outcome.message);
        continue;
      }
      const reportValue = outcome.report;
      const status = reviewReportStatus(reportValue);
      attempts.push({ target, status });
      const independence: ReviewIndependence = host === undefined
        ? "unknown"
        : host === target
          ? "same-target"
          : "different-target";
      const verdict = {
        results: reviewReportResults(reportValue),
        report: reportValue,
        harness: target,
        attempts,
        independence,
        sessionIsolation: "fresh" as const
      };
      if (status === "FAIL") {
        return { status, ...verdict };
      }
      const adversarial = await refute(reportValue, target);
      return {
        status: adversarial?.refuted === true ? "FAIL" : "PASS",
        ...verdict,
        ...(adversarial === undefined ? {} : { adversarial })
      };
    }
    return {
      status: "NOT_RUN",
      reason: lastReason,
      ...(attempts.length === 0 ? {} : { harness: attempts.at(-1)?.target }),
      attempts
    };
  };
}
