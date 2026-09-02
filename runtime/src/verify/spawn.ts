import {
  execFile as execFileCallback,
  spawn
} from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

import type { VerificationCommand } from "../contracts.js";

export type VerificationStatus = "PASS" | "FAIL" | "UNKNOWN";

export type ProcessFailureClass =
  | "aborted"
  | "missing-executable"
  | "none"
  | "nonzero-exit"
  | "output-read-failed"
  | "shell-risk-unacknowledged"
  | "signal-exit"
  | "spawn-failed"
  | "termination-failed"
  | "timeout";

export interface ProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: boolean;
  readonly env?: Readonly<Record<string, string>>;
  readonly replaceEnv?: boolean;
  readonly stdin?: string;
}

export interface ProcessCompletion {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly errorCode?: string;
}

export interface RunningVerificationProcess {
  readonly pid: number | null;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly completion: Promise<ProcessCompletion>;
  terminateTree(graceMs: number): Promise<void>;
}

export interface VerificationProcessRunner {
  start(request: ProcessRequest): RunningVerificationProcess;
}

export interface NodeVerificationProcessRunnerOptions {
  readonly platform?: NodeJS.Platform;
  readonly terminateWindowsTree?: (
    processId: number,
    graceMs: number
  ) => Promise<void>;
}

export interface RunVerificationCommandOptions {
  readonly cwd: string;
  readonly runner?: VerificationProcessRunner;
  readonly env?: Readonly<Record<string, string>>;
  /** Use exactly `env` instead of inheriting the parent process environment. */
  readonly replaceEnv?: boolean;
  readonly stdin?: string;
  readonly now?: () => number;
  readonly outputLimitBytes?: number;
  readonly terminationGraceMs?: number;
  readonly signal?: AbortSignal;
}

export interface SpawnResult {
  readonly commandId: string;
  readonly status: VerificationStatus;
  readonly failureClass: ProcessFailureClass;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

interface CapturedOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly failed: boolean;
}

interface CompletionOutcome {
  readonly kind: "completion";
  readonly completion: ProcessCompletion;
}

interface TimeoutOutcome {
  readonly kind: "timeout";
}

interface AbortOutcome {
  readonly kind: "abort";
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const MAX_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 500;
const MAX_TERMINATION_GRACE_MS = 5_000;
const execFile = promisify(execFileCallback);

function boundedPositiveInteger(
  value: number,
  maximum: number,
  name: string
): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new RangeError(
      `${name} must be a positive integer no greater than ${maximum}.`
    );
  }
  return value;
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "UNKNOWN";
}

async function* readableBytes(
  stream: Readable | null
): AsyncIterable<Uint8Array> {
  if (stream === null) {
    return;
  }
  for await (const value of stream as AsyncIterable<unknown>) {
    if (typeof value === "string") {
      yield Buffer.from(value);
      continue;
    }
    if (value instanceof Uint8Array) {
      yield value;
      continue;
    }
    throw new TypeError("Process output contained an unsupported chunk.");
  }
}

/**
 * Retains the last `limit` bytes rather than the first. Every reporter this
 * runtime parses — node:test, pytest, jest, vitest — prints its summary line
 * last, and its failure list just before it, so head-truncating a large run
 * discards exactly the part that carries the evidence.
 */
async function captureOutput(
  stream: AsyncIterable<Uint8Array>,
  limit: number
): Promise<CapturedOutput> {
  const chunks: Buffer[] = [];
  let storedBytes = 0;
  let truncated = false;
  const retain = (chunk: Buffer): void => {
    chunks.push(chunk);
    storedBytes += chunk.length;
    while (storedBytes > limit) {
      const oldest = chunks[0];
      if (oldest === undefined) {
        break;
      }
      truncated = true;
      const excess = storedBytes - limit;
      if (oldest.length <= excess) {
        chunks.shift();
        storedBytes -= oldest.length;
      } else {
        chunks[0] = oldest.subarray(excess);
        storedBytes -= excess;
      }
    }
  };
  try {
    for await (const value of stream) {
      retain(Buffer.from(value));
    }
  } catch {
    return {
      text: Buffer.concat(chunks, storedBytes).toString("utf8"),
      truncated,
      failed: true
    };
  }
  return {
    text: Buffer.concat(chunks, storedBytes).toString("utf8"),
    truncated,
    failed: false
  };
}

function settleCapturedOutput(
  capture: Promise<CapturedOutput>,
  graceMs: number
): Promise<CapturedOutput> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CapturedOutput>((resolve) => {
    timer = setTimeout(() => resolve({
      text: "",
      truncated: true,
      failed: true
    }), graceMs);
  });
  return Promise.race([capture, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function isMissingProcess(errorCodeValue: string | undefined): boolean {
  return errorCodeValue === "ENOENT";
}

function waitForCompletion(
  completion: Promise<ProcessCompletion>,
  timeoutMs: number
): Promise<ProcessCompletion | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  return Promise.race([completion, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

async function terminatePosixTree(
  processId: number,
  completion: Promise<ProcessCompletion>,
  graceMs: number
): Promise<void> {
  try {
    process.kill(-processId, "SIGTERM");
  } catch (error) {
    if (errorCode(error) === "ESRCH") {
      return;
    }
    throw error;
  }
  await waitForCompletion(completion, graceMs);
  try {
    process.kill(-processId, "SIGKILL");
  } catch (error) {
    if (errorCode(error) !== "ESRCH") {
      throw error;
    }
  }
}

async function defaultTerminateWindowsTree(
  processId: number,
  graceMs: number
): Promise<void> {
  await execFile(
    "taskkill",
    ["/pid", String(processId), "/T", "/F"],
    {
      encoding: "utf8",
      timeout: graceMs,
      windowsHide: true
    }
  );
}

export class NodeVerificationProcessRunner
implements VerificationProcessRunner {
  readonly #platform: NodeJS.Platform;
  readonly #terminateWindowsTree: (
    processId: number,
    graceMs: number
  ) => Promise<void>;

  constructor(options: NodeVerificationProcessRunnerOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#terminateWindowsTree =
      options.terminateWindowsTree ?? defaultTerminateWindowsTree;
  }

  start(request: ProcessRequest): RunningVerificationProcess {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      detached: this.#platform !== "win32",
      env: {
        ...(request.replaceEnv === true ? {} : process.env),
        ...(request.env ?? {})
      },
      shell: request.shell,
      stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true
    });
    if (request.stdin !== undefined && child.stdin !== null) {
      child.stdin.on("error", () => {});
      child.stdin.end(request.stdin);
    }
    let settled = false;
    const completion = new Promise<ProcessCompletion>((resolve) => {
      child.once("error", (error: Error & { code?: string }) => {
        if (!settled) {
          settled = true;
          resolve({
            exitCode: null,
            signal: null,
            errorCode: error.code ?? "UNKNOWN"
          });
        }
      });
      child.once("close", (exitCode, signal) => {
        if (!settled) {
          settled = true;
          resolve({
            exitCode,
            signal
          });
        }
      });
    });
    const processId = child.pid ?? null;

    return {
      pid: processId,
      stdout: readableBytes(child.stdout),
      stderr: readableBytes(child.stderr),
      completion,
      terminateTree: async (graceMs) => {
        if (processId === null) {
          throw new Error("Cannot terminate a process without an ID.");
        }
        if (this.#platform === "win32") {
          await this.#terminateWindowsTree(processId, graceMs);
          return;
        }
        await terminatePosixTree(processId, completion, graceMs);
      }
    };
  }
}

function emptyResult(
  commandId: string,
  failureClass: ProcessFailureClass,
  durationMs: number
): SpawnResult {
  return {
    commandId,
    status: "UNKNOWN",
    failureClass,
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false
  };
}

function classifyCompletion(
  completion: ProcessCompletion,
  outputFailed: boolean
): Pick<SpawnResult, "failureClass" | "status"> {
  if (outputFailed) {
    return {
      status: "UNKNOWN",
      failureClass: "output-read-failed"
    };
  }
  if (isMissingProcess(completion.errorCode)) {
    return {
      status: "UNKNOWN",
      failureClass: "missing-executable"
    };
  }
  if (completion.errorCode !== undefined) {
    return {
      status: "UNKNOWN",
      failureClass: "spawn-failed"
    };
  }
  if (completion.signal !== null) {
    return {
      status: "FAIL",
      failureClass: "signal-exit"
    };
  }
  if (completion.exitCode === 0) {
    return {
      status: "PASS",
      failureClass: "none"
    };
  }
  return {
    status: "FAIL",
    failureClass: "nonzero-exit"
  };
}

function elapsedMilliseconds(startedAt: number, finishedAt: number): number {
  const elapsed = Math.max(0, finishedAt - startedAt);
  return Number.isFinite(elapsed) ? Math.round(elapsed) : 0;
}

function hasAcknowledgedShell(command: VerificationCommand): boolean {
  const value = command as unknown as Record<string, unknown>;
  return value.shell !== true || value.acknowledgeRisk === true;
}

export async function runVerificationCommand(
  command: VerificationCommand,
  options: RunVerificationCommandOptions
): Promise<SpawnResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  if (options.signal?.aborted === true) {
    return emptyResult(
      command.id,
      "aborted",
      elapsedMilliseconds(startedAt, now())
    );
  }
  if (!hasAcknowledgedShell(command)) {
    return emptyResult(
      command.id,
      "shell-risk-unacknowledged",
      elapsedMilliseconds(startedAt, now())
    );
  }

  const outputLimit = boundedPositiveInteger(
    options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
    MAX_OUTPUT_LIMIT_BYTES,
    "outputLimitBytes"
  );
  const terminationGrace = boundedPositiveInteger(
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    MAX_TERMINATION_GRACE_MS,
    "terminationGraceMs"
  );
  const timeoutMs = boundedPositiveInteger(
    command.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    2_147_483_647,
    "timeoutMs"
  );
  const runner = options.runner ?? new NodeVerificationProcessRunner();
  let running: RunningVerificationProcess;
  try {
    running = runner.start({
      command: command.command,
      args: [...command.args],
      cwd: options.cwd,
      shell: command.shell === true,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.replaceEnv === true ? { replaceEnv: true } : {}),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin })
    });
  } catch {
    return emptyResult(
      command.id,
      "spawn-failed",
      elapsedMilliseconds(startedAt, now())
    );
  }

  const stdout = captureOutput(running.stdout, outputLimit);
  const stderr = captureOutput(running.stderr, outputLimit);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimeoutOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  let removeAbortListener = (): void => {};
  const aborted = new Promise<AbortOutcome>((resolve) => {
    const signal = options.signal;
    if (signal === undefined) {
      return;
    }
    const onAbort = (): void => resolve({ kind: "abort" });
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  const outcome = await Promise.race<
    CompletionOutcome | TimeoutOutcome | AbortOutcome
  >([
    running.completion.then((completion) => ({
      kind: "completion",
      completion
    })),
    timeout,
    aborted
  ]);
  removeAbortListener();
  if (timer !== undefined) {
    clearTimeout(timer);
  }

  let completion: ProcessCompletion;
  let timedOut = false;
  let wasAborted = false;
  let terminationFailed = false;
  if (outcome.kind === "timeout" || outcome.kind === "abort") {
    timedOut = outcome.kind === "timeout";
    wasAborted = outcome.kind === "abort";
    try {
      await running.terminateTree(terminationGrace);
    } catch {
      terminationFailed = true;
    }
    completion =
      await waitForCompletion(running.completion, terminationGrace) ??
      { exitCode: null, signal: null };
  } else {
    completion = outcome.completion;
  }

  const [capturedStdout, capturedStderr] = await Promise.all([
    settleCapturedOutput(stdout, terminationGrace),
    settleCapturedOutput(stderr, terminationGrace)
  ]);
  const classified = wasAborted
    ? {
        status: terminationFailed ? "UNKNOWN" : "FAIL",
        failureClass: "aborted"
      } as const
    : timedOut
    ? {
        status: terminationFailed ? "UNKNOWN" : "FAIL",
        failureClass: terminationFailed
          ? "termination-failed"
          : "timeout"
      } as const
    : classifyCompletion(
        completion,
        capturedStdout.failed || capturedStderr.failed
      );

  return {
    commandId: command.id,
    status: classified.status,
    failureClass: classified.failureClass,
    exitCode: completion.exitCode,
    signal: completion.signal,
    timedOut,
    durationMs: elapsedMilliseconds(startedAt, now()),
    stdout: capturedStdout.text,
    stderr: capturedStderr.text,
    stdoutTruncated: capturedStdout.truncated,
    stderrTruncated: capturedStderr.truncated
  };
}
