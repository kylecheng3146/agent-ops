import type { VerificationCommand } from "../contracts.js";
import {
  runVerificationCommand,
  type RunVerificationCommandOptions,
  type SpawnResult,
  type VerificationProcessRunner,
  type VerificationStatus
} from "./spawn.js";
import {
  evaluateTestCount,
  parseTestCount,
  type TestCountCode
} from "./test-count.js";

export interface ConfiguredCommandExecution {
  readonly commandId: string;
  readonly required: boolean;
  readonly status: VerificationStatus;
  readonly failureClass: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly testCount: number | null;
  readonly diagnostic: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ExecuteConfiguredCommandOptions {
  readonly cwd: string;
  readonly trusted: boolean;
  readonly runner?: VerificationProcessRunner;
  readonly env?: Readonly<Record<string, string>>;
  readonly now?: () => number;
  readonly outputLimitBytes?: number;
  readonly terminationGraceMs?: number;
}

interface ClassifiedCommand {
  readonly status: VerificationStatus;
  readonly failureClass: string;
  readonly testCount: number | null;
}

type SpawnedCommand = Omit<SpawnResult, "failureClass"> & {
  readonly failureClass: string;
};

function classifyTestCountCode(code: TestCountCode): string {
  const classes: Record<TestCountCode, string> = {
    TEST_COUNT_BELOW_MINIMUM: "test-count-below-minimum",
    TEST_COUNT_INVALID: "test-count-invalid",
    TEST_COUNT_OK: "none",
    TEST_COUNT_REQUIREMENT_INVALID:
      "test-count-requirement-invalid",
    TEST_COUNT_UNPARSEABLE: "test-count-unparseable",
    ZERO_TESTS: "zero-tests"
  };
  return classes[code];
}

function untrustedResult(commandId: string): SpawnedCommand {
  return {
    commandId,
    status: "UNKNOWN",
    failureClass: "repository-untrusted",
    exitCode: null,
    signal: null,
    timedOut: false,
    durationMs: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false
  };
}

function classifyCommand(
  command: VerificationCommand,
  spawned: SpawnedCommand
): ClassifiedCommand {
  if (command.evidence.kind === "file") {
    return {
      status:
        spawned.status === "PASS" ? "UNKNOWN" : spawned.status,
      failureClass:
        spawned.status === "PASS"
          ? "file-evidence-unsupported"
          : spawned.failureClass,
      testCount: null
    };
  }
  if (command.evidence.kind !== "test-count") {
    return {
      status: spawned.status,
      failureClass: spawned.failureClass,
      testCount: null
    };
  }
  const testCount = parseTestCount(
    `${spawned.stdout}\n${spawned.stderr}`
  );
  if (spawned.status !== "PASS") {
    return {
      status: spawned.status,
      failureClass: spawned.failureClass,
      testCount
    };
  }
  const evaluation = evaluateTestCount(
    testCount,
    command.evidence.minimum
  );
  return {
    status: evaluation.status,
    failureClass: classifyTestCountCode(evaluation.code),
    testCount: evaluation.testCount
  };
}

function diagnostic(spawned: SpawnedCommand): string {
  return spawned.stderr || spawned.stdout || spawned.failureClass;
}

export async function executeConfiguredCommand(
  command: VerificationCommand,
  options: ExecuteConfiguredCommandOptions
): Promise<ConfiguredCommandExecution> {
  let spawned: SpawnedCommand;
  if (!options.trusted) {
    spawned = untrustedResult(command.id);
  } else {
    const runOptions: RunVerificationCommandOptions = {
      cwd: options.cwd,
      ...(options.runner === undefined
        ? {}
        : { runner: options.runner }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.outputLimitBytes === undefined
        ? {}
        : { outputLimitBytes: options.outputLimitBytes }),
      ...(options.terminationGraceMs === undefined
        ? {}
        : { terminationGraceMs: options.terminationGraceMs })
    };
    spawned = await runVerificationCommand(command, runOptions);
  }
  const classified = classifyCommand(command, spawned);
  return {
    commandId: command.id,
    required: command.required,
    status: classified.status,
    failureClass: classified.failureClass,
    exitCode: spawned.exitCode,
    signal: spawned.signal,
    timedOut: spawned.timedOut,
    testCount: classified.testCount,
    diagnostic: diagnostic(spawned),
    stdout: spawned.stdout,
    stderr: spawned.stderr,
    stdoutTruncated: spawned.stdoutTruncated,
    stderrTruncated: spawned.stderrTruncated
  };
}

export function aggregateVerificationStatus(
  results: readonly Pick<ConfiguredCommandExecution, "required" | "status">[]
): VerificationStatus {
  const required = results.filter((result) => result.required);
  const gating = required.length > 0 ? required : results;
  if (gating.some((result) => result.status === "FAIL")) {
    return "FAIL";
  }
  if (gating.some((result) => result.status === "UNKNOWN")) {
    return "UNKNOWN";
  }
  return "PASS";
}
