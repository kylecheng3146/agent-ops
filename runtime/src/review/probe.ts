import {
  runVerificationCommand,
  type VerificationProcessRunner
} from "../verify/spawn.js";
import type { ReviewTargetId } from "../contracts.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFinalMessage } from "./extract.js";
import {
  isolatedReviewEnvironment
} from "./execute.js";
import { buildProbeInvocation } from "./invocation.js";

export type ReviewTargetProbeResult =
  | "ineligible"
  | "missing-executable"
  | "ok"
  | "timeout"
  | "unauthenticated";

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
}

const PROBE_PROMPT = "Reply with the single word OK and nothing else.";
/**
 * Matches the review timeout rather than being "quick": codex at high
 * reasoning effort answers a trivial prompt in ~20s, and a probe that times out
 * would otherwise be reported as an authentication failure.
 */
const PROBE_TIMEOUT_MS = 120_000;

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
  const deep = options.deep === true;
  const directory = deep
    ? await mkdtemp(join(tmpdir(), "agent-ops-review-probe-"))
    : options.cwd;
  try {
  const invocation = buildProbeInvocation({
    target,
    prompt: PROBE_PROMPT,
    ...(deep && target === "agy"
      ? { logFile: join(directory, "agy.log") }
      : {})
  });
  if (invocation === undefined) {
    return "ineligible";
  }
  const spawned = await runVerificationCommand(
    {
      id: `review-probe-${target}`,
      command: invocation.command,
      args: deep ? [...invocation.args] : ["--version"],
      cwd: directory,
      required: true,
      evidence: { kind: "exit-code" },
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS
    },
    {
      cwd: directory,
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
    return "missing-executable";
  }
  if (spawned.timedOut) {
    return "timeout";
  }
  if (!deep) {
    return spawned.status === "PASS" ? "ok" : "unauthenticated";
  }
  return spawned.status === "PASS" &&
    extractFinalMessage(target, spawned.stdout) !== undefined
    ? "ok"
    : "unauthenticated";
  } finally {
    if (deep) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
