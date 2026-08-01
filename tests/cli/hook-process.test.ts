import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import type {
  AgentOpsConfig,
  VerificationCommand
} from "../../runtime/src/contracts.js";
import type {
  GitRunResult,
  GitRunner
} from "../../runtime/src/verify/change-surface.js";
import type {
  ProcessCompletion,
  ProcessRequest,
  RunningVerificationProcess,
  VerificationProcessRunner
} from "../../runtime/src/verify/spawn.js";
import { runHookProcess, type HookProcessIo } from "../../packages/cli/src/hook-process.js";

async function* output(value = "# tests 1\n"): AsyncIterable<Uint8Array> {
  if (value.length > 0) {
    yield Buffer.from(value);
  }
}

class FixtureProcessRunner implements VerificationProcessRunner {
  readonly calls: ProcessRequest[] = [];

  start(request: ProcessRequest): RunningVerificationProcess {
    this.calls.push(request);
    const completion: ProcessCompletion = { exitCode: 0, signal: null };
    return {
      pid: 456,
      stdout: output(),
      stderr: output(""),
      completion: Promise.resolve(completion),
      terminateTree: async () => undefined
    };
  }
}

class FixtureGitRunner implements GitRunner {
  async run(args: readonly string[]): Promise<GitRunResult> {
    return {
      exitCode: 0,
      stdout:
        args[0] === "diff" && args[1] === "--cached"
          ? Buffer.from("src/example.ts\0")
          : new Uint8Array()
    };
  }
}

function command(): VerificationCommand {
  return {
    id: "unit",
    command: "unit-tool",
    args: [],
    cwd: ".",
    required: true,
    evidence: { kind: "test-count", minimum: 1 }
  };
}

function config(
  profiles: AgentOpsConfig["profiles"],
  stopEnabled = false
): AgentOpsConfig {
  return {
    schemaVersion: 2,
    profiles,
    verification: { commands: stopEnabled ? [command()] : [] },
    features: { stopVerification: { enabled: stopEnabled } },
    pathMappings: [],
    securityExceptions: []
  };
}

function io(stdin: string): {
  io: HookProcessIo;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdin: Readable.from([stdin]),
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value)
    },
    stdout,
    stderr
  };
}

test("real hook process reaches advisory implementation", async () => {
  const streams = io(JSON.stringify({
    hook_event_name: "SessionStart",
    cwd: "/workspace"
  }));
  let advisoryCalls = 0;

  const exitCode = await runHookProcess(
    ["claude", "SessionStart"],
    streams.io,
    "0.2.0",
    {
      root: "/workspace",
      loadConfig: async () => config(["advisory"]),
      trust: async () => "TRUSTED",
      advisory: async () => {
        advisoryCalls += 1;
      },
      gitRunner: new FixtureGitRunner(),
      processRunner: new FixtureProcessRunner()
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(advisoryCalls, 1);
  assert.deepEqual(streams.stdout, []);
  assert.deepEqual(streams.stderr, []);
});

test("real Claude Stop hook executes report-only verification", async () => {
  const streams = io(JSON.stringify({
    hook_event_name: "Stop",
    cwd: "/workspace"
  }));
  const processRunner = new FixtureProcessRunner();

  await runHookProcess(
    ["claude", "Stop"],
    streams.io,
    "0.2.0",
    {
      root: "/workspace",
      loadConfig: async () => config(["core"], true),
      trust: async () => "TRUSTED",
      advisory: async () => undefined,
      gitRunner: new FixtureGitRunner(),
      processRunner
    }
  );

  assert.equal(processRunner.calls.length, 1);
  assert.deepEqual(processRunner.calls[0]?.env, {
    AGENT_OPS_STOP_VERIFY_ACTIVE: "1"
  });
  assert.match(streams.stdout.join(""), /STOP_VERIFICATION_FINISHED/);
});

test("native Claude recursion metadata prevents Stop execution", async () => {
  const streams = io(JSON.stringify({
    hook_event_name: "Stop",
    cwd: "/workspace",
    stop_hook_active: true
  }));
  const processRunner = new FixtureProcessRunner();

  await runHookProcess(
    ["claude", "Stop"],
    streams.io,
    "0.2.0",
    {
      root: "/workspace",
      loadConfig: async () => config(["core"], true),
      trust: async () => "TRUSTED",
      gitRunner: new FixtureGitRunner(),
      processRunner
    }
  );

  assert.equal(processRunner.calls.length, 0);
  assert.match(streams.stdout.join(""), /STOP_VERIFICATION_RECURSION/);
});

test("unsupported Codex Stop remains report-only and does not execute", async () => {
  const streams = io(JSON.stringify({
    hook_event_name: "Stop",
    cwd: "/workspace"
  }));
  const processRunner = new FixtureProcessRunner();

  await runHookProcess(
    ["codex", "Stop"],
    streams.io,
    "0.2.0",
    {
      root: "/workspace",
      loadConfig: async () => config(["core"], true),
      trust: async () => "TRUSTED",
      gitRunner: new FixtureGitRunner(),
      processRunner
    }
  );

  assert.equal(processRunner.calls.length, 0);
  assert.match(streams.stdout.join(""), /STOP_VERIFICATION_UNAVAILABLE/);
});

test("degraded OpenCode idle mapping still reports Stop evidence", async () => {
  const streams = io(JSON.stringify({
    event: "Stop",
    projectRoot: "/workspace"
  }));
  const processRunner = new FixtureProcessRunner();

  await runHookProcess(
    ["opencode", "Stop"],
    streams.io,
    "0.2.0",
    {
      root: "/workspace",
      loadConfig: async () => config(["core"], true),
      trust: async () => "TRUSTED",
      gitRunner: new FixtureGitRunner(),
      processRunner
    }
  );

  assert.equal(processRunner.calls.length, 1);
  assert.match(streams.stdout.join(""), /STOP_VERIFICATION_FINISHED/);
});
