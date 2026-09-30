import {
  runVerificationCommand,
  type VerificationProcessRunner
} from "../verify/spawn.js";
import type { ReviewTargetId } from "../contracts.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFinalMessage } from "./extract.js";
import {
  firstComplaint,
  isolatedReviewEnvironment
} from "./execute.js";
import {
  isLoginFailure,
  isNetworkFailure,
  probeHostReachable,
  TARGET_API_HOST
} from "./host-sandbox.js";
import { buildProbeInvocation } from "./invocation.js";

export type ReviewTargetProbeResult =
  | "ineligible"
  | "missing-executable"
  | "ok"
  | "timeout"
  | "unauthenticated"
  | "network-unreachable"
  | "capability-unavailable"
  | "probe-failed";

/** A probe answer plus the target's own first line when it did not answer. */
export interface ReviewTargetProbeOutcome {
  readonly result: ReviewTargetProbeResult;
  readonly diagnostic?: string | undefined;
}

/** A log's last non-empty line: where a CLI that logs to a file puts its error. */
async function lastLogLine(path: string): Promise<string> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split(/\r?\n/u).filter((line) => line.trim().length > 0).at(-1) ?? "";
}

export interface ReviewTargetProbeOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly runner?: VerificationProcessRunner;
  /**
   * When false (the default) the probe only proves the executable exists, via
   * `--version`: no tokens, no network. Authentication cannot be established
   * that cheaply, so `ok` here means "present", not "usable".
   */
  readonly deep?: boolean;
  /** Resolves true when the target's API host accepts a TCP connection. */
  readonly reachable?: (host: string) => Promise<boolean>;
}

const PROBE_PROMPT = "Reply with the single word OK and nothing else.";
/**
 * Matches the review timeout rather than being "quick": codex at high
 * reasoning effort answers a trivial prompt in ~20s, and a probe that times out
 * would otherwise be reported as an authentication failure.
 */
const PROBE_TIMEOUT_MS = 120_000;

/**
 * A caller may shorten the probe — a chain with little budget left does — but
 * never lengthen it: a hung probe must still stop at its own ceiling rather
 * than spend whatever budget it was handed.
 */
export function probeTimeoutMs(requested?: number): number {
  return requested === undefined
    ? PROBE_TIMEOUT_MS
    : Math.max(1, Math.min(requested, PROBE_TIMEOUT_MS));
}

/**
 * The only check that actually proves a target is usable: ask it something
 * trivial and see whether an answer comes back. A credential-file check can
 * pass while the token is expired, and self-declaration ("already logged in?")
 * is not evidence at all.
 */
export async function probeReviewTarget(
  target: ReviewTargetId,
  options: ReviewTargetProbeOptions
): Promise<ReviewTargetProbeResult> {
  return (await probeReviewTargetDetailed(target, options)).result;
}

export async function probeReviewTargetDetailed(
  target: ReviewTargetId,
  options: ReviewTargetProbeOptions
): Promise<ReviewTargetProbeOutcome> {
  const deep = options.deep === true;
  const directory = deep
    ? await mkdtemp(join(tmpdir(), "agent-ops-review-probe-"))
    : options.cwd;
  try {
  // agy's sandbox only answers inside a project-shaped directory: an empty
  // temp dir hangs or denies file access, which this probe then misreads as
  // unauthenticated. Cloning first matches the review attempt, which already
  // runs inside a disposable clone; a failed clone falls back to the plain
  // temp dir, which is exactly today's behavior.
  let invocationCwd = directory;
  if (deep && target === "agy") {
    const clone = join(directory, "repository");
    const cloned = await runVerificationCommand(
      {
        id: "review-probe-clone",
        command: "git",
        args: ["clone", "--no-hardlinks", "--quiet", "--", options.cwd, clone],
        cwd: directory,
        required: true,
        evidence: { kind: "exit-code" },
        timeoutMs: Math.min(probeTimeoutMs(options.timeoutMs), 30_000)
      },
      {
        cwd: directory,
        ...(options.runner === undefined ? {} : { runner: options.runner })
      }
    );
    if (cloned.status === "PASS") {
      invocationCwd = clone;
    }
  }
  const invocation = buildProbeInvocation({
    target,
    prompt: PROBE_PROMPT,
    ...(deep && target === "agy"
      ? { logFile: join(directory, "agy.log") }
      : {})
  });
  if (invocation === undefined) {
    return { result: "ineligible" };
  }
  const spawned = await runVerificationCommand(
    {
      id: `review-probe-${target}`,
      command: invocation.command,
      args: deep ? [...invocation.args] : ["--version"],
      cwd: invocationCwd,
      required: true,
      evidence: { kind: "exit-code" },
      timeoutMs: probeTimeoutMs(options.timeoutMs)
    },
    {
      cwd: invocationCwd,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...(deep
        ? {
            stdin: invocation.stdin,
            env: isolatedReviewEnvironment(target, directory, process.env),
            replaceEnv: true
          }
        : {})
    }
  );
  if (spawned.failureClass === "missing-executable") {
    return { result: "missing-executable" };
  }
  if (spawned.timedOut) {
    return { result: "timeout" };
  }
  const output = `${spawned.stderr}\n${spawned.stdout}`;
  // The target's own words, so a failure is never reduced to a guess. agy
  // writes its errors to the log file the probe hands it, not to stderr.
  const complaint = async (): Promise<string | undefined> =>
    firstComplaint(spawned.stderr, spawned.stdout) ??
    (deep && target === "agy"
      ? firstComplaint(await lastLogLine(join(directory, "agy.log")))
      : undefined);
  if (
    /(?:operation not permitted|permission denied|bind(?:ing)?[^\n]*(?:failed|denied))/iu.test(
      output
    )
  ) {
    return { result: "capability-unavailable", diagnostic: await complaint() };
  }
  if (!deep) {
    return spawned.status === "PASS"
      ? { result: "ok" }
      : { result: "probe-failed", diagnostic: await complaint() };
  }
  if (
    spawned.status === "PASS" &&
    extractFinalMessage(target, spawned.stdout) !== undefined
  ) {
    return { result: "ok" };
  }
  // An unreachable API host outranks whatever the CLI printed: a sandbox that
  // withholds the network makes an authenticated CLI say "not logged in".
  if (isNetworkFailure(output)) {
    return { result: "network-unreachable", diagnostic: await complaint() };
  }
  if (!await (options.reachable ?? probeHostReachable)(TARGET_API_HOST[target])) {
    return { result: "network-unreachable", diagnostic: await complaint() };
  }
  const diagnostic = await complaint();
  // Login is what the output says it is; anything else is a probe that could
  // not run, and the diagnostic is all the evidence there is.
  return isLoginFailure(`${output}\n${diagnostic ?? ""}`)
    ? { result: "unauthenticated", diagnostic }
    : { result: "probe-failed", diagnostic };
  } finally {
    if (deep) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
