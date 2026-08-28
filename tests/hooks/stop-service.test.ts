import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentOpsConfig,
  VerificationCommand
} from "../../runtime/src/contracts.js";
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import {
  StopVerificationService
} from "../../runtime/src/hooks/stop-service.js";
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

async function* output(value = ""): AsyncIterable<Uint8Array> {
  if (value.length > 0) {
    yield Buffer.from(value);
  }
}

class FixtureGitRunner implements GitRunner {
  readonly #paths: readonly string[];

  constructor(paths: readonly string[]) {
    this.#paths = paths;
  }

  async run(args: readonly string[]): Promise<GitRunResult> {
    return {
      exitCode: 0,
      stdout:
        args[0] === "diff" && args[1] === "--cached"
          ? Buffer.from(this.#paths.map((path) => `${path}\0`).join(""))
          : new Uint8Array()
    };
  }
}

class FixtureProcessRunner implements VerificationProcessRunner {
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
      pid: 321,
      stdout: output(this.#stdout),
      stderr: output(),
      completion: Promise.resolve(this.#completion),
      terminateTree: async () => undefined
    };
  }
}

class TimeoutProcessRunner implements VerificationProcessRunner {
  start(_request: ProcessRequest): RunningVerificationProcess {
    let finish: (completion: ProcessCompletion) => void = () => undefined;
    const completion = new Promise<ProcessCompletion>((resolve) => {
      finish = resolve;
    });
    return {
      pid: 654,
      stdout: output(),
      stderr: output(),
      completion,
      terminateTree: async () => {
        finish({ exitCode: null, signal: "SIGTERM" });
      }
    };
  }
}

function command(
  id = "unit",
  overrides: Partial<VerificationCommand> = {}
): VerificationCommand {
  return {
    id,
    command: `${id}-tool`,
    args: ["--check"],
    cwd: ".",
    required: true,
    evidence: { kind: "exit-code" },
    ...overrides
  } as VerificationCommand;
}

function config(
  enabled = true,
  commands: readonly VerificationCommand[] = [command()]
): AgentOpsConfig {
  return {
    schemaVersion: 3,
    profiles: ["core"],
    verification: { commands: [...commands] },
    features: {
      completionGate: { enabled: false },
      stopVerification: { enabled }
    },
    pathMappings: [{ path: "src", verifierIds: ["unit"] }],
    securityExceptions: []
  };
}

test("executes trusted selected commands with a private recursion marker", async () => {
  const value = config();
  const processRunner = new FixtureProcessRunner({
    exitCode: 0,
    signal: null
  });
  const verification = new StopVerificationService({
    root: "/workspace",
    config: value,
    trusted: true,
    gitRunner: new FixtureGitRunner(["src/example.ts"]),
    processRunner,
    recursionActive: false,
    configHash: calculateConfigHash(value)
  });

  const report = await verification.verify();

  assert.equal(report.status, "PASS");
  assert.deepEqual(report.results, [
    { commandId: "unit", exitCode: 0, testCount: null }
  ]);
  assert.deepEqual(processRunner.calls[0]?.env, {
    AGENT_OPS_STOP_VERIFY_ACTIVE: "1"
  });
});

test("uses the fallback required-command set when there are no changed paths", async () => {
  const value = config(true, [
    command("required"),
    command("optional", { required: false })
  ]);
  const processRunner = new FixtureProcessRunner({
    exitCode: 0,
    signal: null
  });
  const verification = new StopVerificationService({
    root: "/workspace",
    config: value,
    trusted: true,
    gitRunner: new FixtureGitRunner([]),
    processRunner,
    recursionActive: false,
    configHash: calculateConfigHash(value)
  });

  const report = await verification.verify();

  assert.equal(report.status, "PASS");
  assert.deepEqual(
    processRunner.calls.map(({ command }) => command),
    ["required-tool"]
  );
});

test("aggregates nonzero, missing-executable, zero-test, and timeout outcomes", async (t) => {
  const cases = [
    {
      name: "nonzero exit",
      value: config(true, [command("unit", { evidence: { kind: "exit-code" } })]),
      runner: new FixtureProcessRunner({ exitCode: 2, signal: null }),
      status: "FAIL"
    },
    {
      name: "missing executable",
      value: config(true, [command("unit", { evidence: { kind: "exit-code" } })]),
      runner: new FixtureProcessRunner({
        exitCode: null,
        signal: null,
        errorCode: "ENOENT"
      }),
      status: "UNKNOWN"
    },
    {
      name: "zero tests",
      value: config(true, [
        command("unit", { evidence: { kind: "test-count", minimum: 1 } })
      ]),
      runner: new FixtureProcessRunner(
        { exitCode: 0, signal: null },
        "# tests 0\n"
      ),
      status: "FAIL"
    },
    {
      name: "timeout",
      value: config(true, [
        command("unit", { timeoutMs: 5, evidence: { kind: "exit-code" } })
      ]),
      runner: new TimeoutProcessRunner(),
      status: "FAIL"
    }
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const service = new StopVerificationService({
        root: "/workspace",
        config: fixture.value,
        trusted: true,
        gitRunner: new FixtureGitRunner(["src/example.ts"]),
        processRunner: fixture.runner,
        recursionActive: false,
        configHash: calculateConfigHash(fixture.value)
      });

      const report = await service.verify();

      assert.equal(report.status, fixture.status);
      assert.equal(report.results[0]?.commandId, "unit");
    });
  }
});

test("requires configured commands when Stop is enabled", async () => {
  const value = config(true, []);
  const service = new StopVerificationService({
    root: "/workspace",
    config: value,
    trusted: true,
    gitRunner: new FixtureGitRunner([]),
    processRunner: new FixtureProcessRunner({ exitCode: 0, signal: null }),
    recursionActive: false,
    configHash: calculateConfigHash(value)
  });

  await assert.rejects(
    service.verify(),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "STOP_VERIFICATION_COMMANDS_REQUIRED"
  );
});

test("does not execute when Stop is disabled, untrusted, recursive, or stale", async (t) => {
  const cases = [
    {
      name: "disabled",
      value: config(false),
      trusted: true,
      recursionActive: false,
      configHash: calculateConfigHash(config(false)),
      code: "STOP_VERIFICATION_DISABLED"
    },
    {
      name: "untrusted",
      value: config(),
      trusted: false,
      recursionActive: false,
      configHash: calculateConfigHash(config()),
      code: "STOP_VERIFICATION_UNTRUSTED"
    },
    {
      name: "recursive",
      value: config(),
      trusted: true,
      recursionActive: true,
      configHash: calculateConfigHash(config()),
      code: "STOP_VERIFICATION_RECURSION"
    },
    {
      name: "stale hash",
      value: config(),
      trusted: true,
      recursionActive: false,
      configHash: "b".repeat(64),
      code: "STOP_VERIFICATION_UNCONFIRMED"
    }
  ] as const;

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const runner = new FixtureProcessRunner({
        exitCode: 0,
        signal: null
      });
      const current = new StopVerificationService({
        root: "/workspace",
        config: fixture.value,
        trusted: fixture.trusted,
        gitRunner: new FixtureGitRunner(["src/example.ts"]),
        processRunner: runner,
        recursionActive: fixture.recursionActive,
        configHash:
          fixture.code === "STOP_VERIFICATION_UNCONFIRMED"
            ? fixture.configHash
            : "a".repeat(64)
      });

      await assert.rejects(
        current.verify(),
        (error: unknown) =>
          error instanceof AgentOpsError && error.code === fixture.code
      );
      assert.equal(runner.calls.length, 0);
    });
  }
});
