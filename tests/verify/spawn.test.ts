import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { VerificationCommand } from "../../runtime/src/contracts.js";
import { parseTestCount } from "../../runtime/src/verify/test-count.js";
import {
  NodeVerificationProcessRunner,
  runVerificationCommand,
  type ProcessCompletion,
  type ProcessRequest,
  type RunningVerificationProcess,
  type VerificationProcessRunner
} from "../../runtime/src/verify/spawn.js";

async function* chunks(...values: string[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield Buffer.from(value);
  }
}

function command(
  overrides: Partial<VerificationCommand> = {}
): VerificationCommand {
  return {
    id: "test",
    command: "node",
    args: ["--test", "tests/example.test.js"],
    cwd: ".",
    required: true,
    evidence: { kind: "exit-code" },
    ...overrides
  } as VerificationCommand;
}

function completedProcess(
  completion: ProcessCompletion,
  stdout: AsyncIterable<Uint8Array> = chunks(),
  stderr: AsyncIterable<Uint8Array> = chunks()
): RunningVerificationProcess {
  return {
    pid: 123,
    stdout,
    stderr,
    completion: Promise.resolve(completion),
    terminateTree: async () => undefined
  };
}

function runnerWith(
  start: (request: ProcessRequest) => RunningVerificationProcess
): VerificationProcessRunner {
  return { start };
}

test("executes argv directly with shell false by default", async () => {
  const requests: ProcessRequest[] = [];
  const runner = runnerWith((request) => {
    requests.push(request);
    return completedProcess({
      exitCode: 0,
      signal: null
    }, chunks("passing output"));
  });

  const result = await runVerificationCommand(command(), {
    cwd: "/workspace",
    runner,
    now: () => 10
  });

  assert.deepEqual(requests, [{
    command: "node",
    args: ["--test", "tests/example.test.js"],
    cwd: "/workspace",
    shell: false
  }]);
  assert.equal(result.status, "PASS");
  assert.equal(result.failureClass, "none");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "passing output");
});

test("forwards explicit child environment overrides without adding env to the result", async () => {
  const result = await runVerificationCommand(command({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(process.env.AGENT_OPS_TEST_ENV ?? '')"
    ]
  }), {
    cwd: process.cwd(),
    env: { AGENT_OPS_TEST_ENV: "child-only-value" }
  });

  assert.equal(result.status, "PASS");
  assert.equal(result.stdout, "child-only-value");
  assert.equal("env" in result, false);
});

test("forwards bounded stdin only when a caller explicitly supplies it", async () => {
  const result = await runVerificationCommand(command({
    command: process.execPath,
    args: ["-e", "process.stdin.on('data', value => process.stdout.write(value))"]
  }), {
    cwd: process.cwd(),
    stdin: "review packet"
  });
  assert.equal(result.status, "PASS");
  assert.equal(result.stdout, "review packet");
});

test("allows acknowledged shell commands and rejects forged unacknowledged ones", async () => {
  const requests: ProcessRequest[] = [];
  const runner = runnerWith((request) => {
    requests.push(request);
    return completedProcess({ exitCode: 0, signal: null });
  });
  const acknowledged: VerificationCommand = {
    id: "shell-check",
    command: "printf",
    args: ["ok"],
    cwd: ".",
    required: true,
    shell: true,
    acknowledgeRisk: true,
    evidence: { kind: "exit-code" }
  };

  const accepted = await runVerificationCommand(acknowledged, {
    cwd: "/workspace",
    runner
  });
  const rejected = await runVerificationCommand({
    id: "unsafe-shell",
    command: "printf",
    args: ["no"],
    cwd: ".",
    required: true,
    shell: true,
    evidence: { kind: "exit-code" }
  } as unknown as VerificationCommand, {
    cwd: "/workspace",
    runner
  });

  assert.equal(accepted.status, "PASS");
  assert.equal(requests[0]?.shell, true);
  assert.equal(rejected.status, "UNKNOWN");
  assert.equal(rejected.failureClass, "shell-risk-unacknowledged");
  assert.equal(requests.length, 1);
});

test("classifies missing executables as UNKNOWN without raw errors", async () => {
  const runner = runnerWith(() => completedProcess({
    exitCode: null,
    signal: null,
    errorCode: "ENOENT"
  }));

  const result = await runVerificationCommand(command({
    command: "missing-tool"
  }), {
    cwd: "/workspace",
    runner
  });

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.failureClass, "missing-executable");
  assert.equal(result.exitCode, null);
  assert.equal("error" in result, false);
});

test("classifies non-zero and signalled exits as stable failures", async () => {
  const nonZero = await runVerificationCommand(command(), {
    cwd: "/workspace",
    runner: runnerWith(() => completedProcess({
      exitCode: 2,
      signal: null
    }))
  });
  const signalled = await runVerificationCommand(command(), {
    cwd: "/workspace",
    runner: runnerWith(() => completedProcess({
      exitCode: null,
      signal: "SIGTERM"
    }))
  });

  assert.equal(nonZero.status, "FAIL");
  assert.equal(nonZero.failureClass, "nonzero-exit");
  assert.equal(signalled.status, "FAIL");
  assert.equal(signalled.failureClass, "signal-exit");
});

test("bounds stdout and stderr independently", async () => {
  const result = await runVerificationCommand(command(), {
    cwd: "/workspace",
    outputLimitBytes: 5,
    runner: runnerWith(() => completedProcess(
      { exitCode: 0, signal: null },
      chunks("abc", "def"),
      chunks("123456")
    ))
  });

  // Truncation keeps the tail: test reporters print their summary and failure
  // list last, so the head is the disposable end of a large run.
  assert.equal(result.stdout, "bcdef");
  assert.equal(result.stderr, "23456");
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});

test("a truncated run still yields the trailing test-count summary", async () => {
  const result = await runVerificationCommand(command(), {
    cwd: "/workspace",
    outputLimitBytes: 64,
    runner: runnerWith(() => completedProcess(
      { exitCode: 0, signal: null },
      chunks("noise\n".repeat(200), "# tests 674\n# pass 674\n# fail 0\n"),
      chunks("")
    ))
  });

  assert.equal(result.stdoutTruncated, true);
  assert.equal(parseTestCount(result.stdout), 674);
});

test("times out by terminating the complete process tree with bounded grace", async () => {
  let finish = (_completion: ProcessCompletion): void => {
    throw new Error("completion resolver is unavailable");
  };
  const completion = new Promise<ProcessCompletion>((resolve) => {
    finish = resolve;
  });
  const graceValues: number[] = [];
  const running: RunningVerificationProcess = {
    pid: 456,
    stdout: chunks(),
    stderr: chunks(),
    completion,
    terminateTree: async (graceMs) => {
      graceValues.push(graceMs);
      finish({ exitCode: null, signal: "SIGKILL" });
    }
  };

  const result = await runVerificationCommand(command({ timeoutMs: 5 }), {
    cwd: "/workspace",
    runner: runnerWith(() => running),
    terminationGraceMs: 25
  });

  assert.deepEqual(graceValues, [25]);
  assert.equal(result.status, "FAIL");
  assert.equal(result.failureClass, "timeout");
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
});

test("an abort terminates the process tree without reporting a timeout", async () => {
  const controller = new AbortController();
  let finish: (completion: ProcessCompletion) => void = () => {};
  const completion = new Promise<ProcessCompletion>((resolve) => {
    finish = resolve;
  });
  let terminated = 0;
  const pending = runVerificationCommand(command(), {
    cwd: "/workspace",
    signal: controller.signal,
    runner: runnerWith(() => ({
      pid: 456,
      stdout: chunks(),
      stderr: chunks(),
      completion,
      terminateTree: async () => {
        terminated += 1;
        finish({ exitCode: null, signal: "SIGTERM" });
      }
    }))
  });
  controller.abort("SIGINT");

  const result = await pending;
  assert.equal(result.failureClass, "aborted");
  assert.equal(result.timedOut, false);
  assert.equal(terminated, 1);
});

test("does not wait forever when termination and output draining both fail", async () => {
  async function* stalledOutput(): AsyncIterable<Uint8Array> {
    await new Promise<void>(() => undefined);
    yield Buffer.from("unreachable");
  }
  const running: RunningVerificationProcess = {
    pid: 789,
    stdout: stalledOutput(),
    stderr: stalledOutput(),
    completion: new Promise<ProcessCompletion>(() => undefined),
    terminateTree: async () => {
      throw new Error("tree termination failed");
    }
  };

  const outcome = await Promise.race([
    runVerificationCommand(command({ timeoutMs: 5 }), {
      cwd: "/workspace",
      runner: runnerWith(() => running),
      terminationGraceMs: 5
    }),
    new Promise<"still-running">((resolve) => {
      setTimeout(() => resolve("still-running"), 80);
    })
  ]);

  assert.notEqual(outcome, "still-running");
  if (outcome === "still-running") {
    return;
  }
  assert.equal(outcome.status, "UNKNOWN");
  assert.equal(outcome.failureClass, "termination-failed");
  assert.equal(outcome.timedOut, true);
});

test("POSIX timeout kills descendants after the group leader exits", {
  skip: process.platform === "win32"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-tree-"));
  const pidPath = join(root, "descendant.pid");
  const heartbeatPath = join(root, "heartbeat");
  let descendantPid: number | null = null;
  const descendantSource = [
    'const { writeFileSync } = require("node:fs");',
    'process.on("SIGTERM", () => {});',
    "setInterval(() => {",
    "  writeFileSync(process.argv[1], String(Date.now()));",
    "}, 20);"
  ].join("\n");
  const leaderSource = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    `const descendantSource = ${JSON.stringify(descendantSource)};`,
    "const child = spawn(",
    "  process.execPath,",
    '  ["-e", descendantSource, process.argv[2]],',
    '  { stdio: "ignore" }',
    ");",
    "writeFileSync(process.argv[1], String(child.pid));",
    'process.on("SIGTERM", () => process.exit(0));',
    "setInterval(() => {}, 1_000);"
  ].join("\n");

  try {
    const result = await runVerificationCommand(command({
      command: process.execPath,
      args: ["-e", leaderSource, pidPath, heartbeatPath],
      timeoutMs: 300
    }), {
      cwd: root,
      terminationGraceMs: 100
    });
    descendantPid = Number(await readFile(pidPath, "utf8"));
    const firstHeartbeat = await readFile(heartbeatPath, "utf8");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    const secondHeartbeat = await readFile(heartbeatPath, "utf8");

    assert.equal(result.timedOut, true);
    assert.equal(secondHeartbeat, firstHeartbeat);
  } finally {
    if (
      descendantPid !== null &&
      Number.isSafeInteger(descendantPid) &&
      descendantPid > 0
    ) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ESRCH"
        ) {
          throw error;
        }
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows tree termination runs even after the group leader exits", async () => {
  const calls: Array<{ processId: number; graceMs: number }> = [];
  const runner = new NodeVerificationProcessRunner({
    platform: "win32",
    terminateWindowsTree: async (processId, graceMs) => {
      calls.push({ processId, graceMs });
    }
  });
  const running = runner.start({
    command: process.execPath,
    args: ["-e", ""],
    cwd: process.cwd(),
    shell: false
  });
  await running.completion;
  const processId = running.pid;

  await running.terminateTree(25);

  assert.notEqual(processId, null);
  if (processId !== null) {
    assert.deepEqual(calls, [{ processId, graceMs: 25 }]);
  }
});
