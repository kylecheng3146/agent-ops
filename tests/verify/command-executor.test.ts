import assert from "node:assert/strict";
import test from "node:test";

import type { VerificationCommand } from "../../runtime/src/contracts.js";
import {
  aggregateVerificationStatus,
  executeConfiguredCommand,
  type ConfiguredCommandExecution
} from "../../runtime/src/verify/command-executor.js";
import type {
  ProcessCompletion,
  ProcessRequest,
  RunningVerificationProcess,
  VerificationProcessRunner
} from "../../runtime/src/verify/spawn.js";

async function* output(value = ""): AsyncIterable<Uint8Array> {
  if (value.length > 0) {
    yield Buffer.from(value);
  }
}

class FixtureRunner implements VerificationProcessRunner {
  readonly calls: ProcessRequest[] = [];
  readonly #completion: ProcessCompletion;
  readonly #stdout: string;

  constructor(
    completion: ProcessCompletion,
    stdout = ""
  ) {
    this.#completion = completion;
    this.#stdout = stdout;
  }

  start(request: ProcessRequest): RunningVerificationProcess {
    this.calls.push(request);
    return {
      pid: 123,
      stdout: output(this.#stdout),
      stderr: output(),
      completion: Promise.resolve(this.#completion),
      terminateTree: async () => undefined
    };
  }
}

function command(
  overrides: Partial<VerificationCommand> = {}
): VerificationCommand {
  return {
    id: "unit",
    command: "unit-tool",
    args: ["--check"],
    cwd: ".",
    required: true,
    evidence: { kind: "test-count", minimum: 1 },
    ...overrides
  } as VerificationCommand;
}

test("executes and classifies a configured test-count command", async () => {
  const runner = new FixtureRunner(
    { exitCode: 0, signal: null },
    "# tests 2\n"
  );

  const result = await executeConfiguredCommand(command(), {
    cwd: "/workspace",
    runner,
    trusted: true
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.failureClass, "none");
  assert.equal(result.testCount, 2);
  assert.deepEqual(runner.calls, [
    {
      command: "unit-tool",
      args: ["--check"],
      cwd: "/workspace",
      shell: false
    }
  ]);
});

test("classifies file evidence as UNKNOWN without inventing an artifact", async () => {
  const result = await executeConfiguredCommand(
    command({ evidence: { kind: "file" } }),
    {
      cwd: "/workspace",
      runner: new FixtureRunner({ exitCode: 0, signal: null }),
      trusted: true
    }
  );

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.failureClass, "file-evidence-unsupported");
  assert.equal(result.testCount, null);
});

test("untrusted execution returns UNKNOWN without starting a process", async () => {
  const runner = new FixtureRunner({ exitCode: 0, signal: null });

  const result = await executeConfiguredCommand(command(), {
    cwd: "/workspace",
    runner,
    trusted: false
  });

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.failureClass, "repository-untrusted");
  assert.equal(runner.calls.length, 0);
});

test("required commands gate aggregate status while optional commands do not", () => {
  const results: ConfiguredCommandExecution[] = [
    {
      commandId: "required",
      required: true,
      status: "PASS",
      failureClass: "none",
      exitCode: 0,
      signal: null,
      timedOut: false,
      testCount: null,
      diagnostic: "",
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false
    },
    {
      commandId: "optional",
      required: false,
      status: "FAIL",
      failureClass: "nonzero-exit",
      exitCode: 1,
      signal: null,
      timedOut: false,
      testCount: null,
      diagnostic: "failed",
      stdout: "",
      stderr: "failed",
      stdoutTruncated: false,
      stderrTruncated: false
    }
  ];

  assert.equal(aggregateVerificationStatus(results), "PASS");
  assert.equal(
    aggregateVerificationStatus([
      { ...results[0]!, status: "UNKNOWN" },
      results[1]!
    ]),
    "UNKNOWN"
  );
  assert.equal(
    aggregateVerificationStatus([
      { ...results[0]!, status: "FAIL" },
      results[1]!
    ]),
    "FAIL"
  );
});
