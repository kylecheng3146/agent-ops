import assert from "node:assert/strict";
import test from "node:test";

import type { ReviewTargetId } from "../../runtime/src/contracts.js";
import {
  createReviewExecutor,
  DEFAULT_REVIEW_TIMEOUT_MS,
  isolatedReviewEnvironment
} from "../../runtime/src/review/execute.js";
import type { ReviewExecutionRequest } from "../../runtime/src/review/runner.js";
import type {
  ProcessRequest,
  RunningVerificationProcess,
  VerificationProcessRunner
} from "../../runtime/src/verify/spawn.js";

interface Scripted {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly errorCode?: string;
  /** Never settles, so the executor's timeout fires. */
  readonly hang?: true;
}

interface Attempt {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin?: string;
}

test("full reviews default to a five-minute target timeout", () => {
  assert.equal(DEFAULT_REVIEW_TIMEOUT_MS, 300_000);
});

function bytes(value: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      if (value.length > 0) {
        yield Buffer.from(value);
      }
    }
  };
}

function fakeRunner(script: readonly Scripted[]): {
  readonly runner: VerificationProcessRunner;
  readonly attempts: Attempt[];
} {
  const attempts: Attempt[] = [];
  let index = 0;
  const help = [
    "--add-dir", "--permission-mode", "--no-session-persistence",
    "--safe-mode", "--disable-slash-commands", "--json-schema", "--sandbox",
    "--mode", "--cd", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--output-schema"
  ].join(" ");
  const runner: VerificationProcessRunner = {
    start(request: ProcessRequest): RunningVerificationProcess {
      const isHelp = request.args.includes("--help");
      if (isHelp && request.command === "codex") {
        assert.deepEqual(request.args, ["exec", "--help"]);
      }
      if (!isHelp) {
        attempts.push({ command: request.command, args: [...request.args], ...(request.stdin === undefined ? {} : { stdin: request.stdin }) });
      }
      const step = isHelp
        ? request.command === "agy" ? { stderr: help } : { stdout: help }
        : script[index++] ?? {};
      const completion = step.hang === true
        ? new Promise<never>(() => {})
        : Promise.resolve({
            exitCode: step.exitCode ?? 0,
            signal: null,
            ...(step.errorCode === undefined
              ? {}
              : { errorCode: step.errorCode })
          });
      return {
        pid: 4242,
        stdout: bytes(step.stdout ?? ""),
        stderr: bytes(step.stderr ?? ""),
        completion,
        terminateTree: async () => {}
      };
    }
  };
  return { runner, attempts };
}

/**
 * Each target's real transport shape: claude nests the answer under
 * `structured_output`, agy under `response`, codex prints it bare. Sharing one shape across targets
 * would make these tests pass for the wrong reason.
 */
function envelope(results: unknown, target: ReviewTargetId = "agy"): string {
  const failed = Array.isArray(results) && results.some(
    (item) => typeof item === "object" && item !== null &&
      (item as Record<string, unknown>).status === "FAIL"
  );
  const payload = JSON.stringify({
    summary: "Review complete.",
    results,
    findings: failed ? [{
      severity: "important",
      blocking: true,
      title: "Failed criterion.",
      details: "The criterion failed.",
      locations: [],
      evidence: ["reviewed source"],
      recommendation: "Fix it.",
      criterionIds: ["tests"]
    }] : [],
    residualRisks: [],
    changedFilesInspected: [],
    supportingFilesInspected: []
  });
  if (target === "codex") {
    return payload;
  }
  return JSON.stringify(
    target === "claude" ? { structured_output: JSON.parse(payload) } : { response: payload }
  );
}

function passing(target: ReviewTargetId = "agy"): string {
  return envelope(
    [{ criterionId: "tests", status: "PASS", summary: "Tests pass.", evidence: ["npm test"] }],
    target
  );
}

function failing(target: ReviewTargetId = "agy"): string {
  return envelope(
    [{ criterionId: "tests", status: "FAIL", summary: "Tests fail.", evidence: ["npm test"] }],
    target
  );
}

function request(): ReviewExecutionRequest {
  return {
    readOnly: true,
    invocation: {
      harness: "codex",
      model: "configured",
      effort: "configured",
      packet: {
        request: "Review the requested implementation.",
        criteria: [{ id: "tests", description: "The test suite passes." }],
        artifactRefs: [],
        evidenceRequirements: []
      }
    }
  };
}

async function run(
  targets: readonly ReviewTargetId[],
  script: readonly Scripted[],
  options: { readonly timeoutMs?: number } = {}
): Promise<{
  readonly result: Awaited<ReturnType<ReturnType<typeof createReviewExecutor>>>;
  readonly attempts: Attempt[];
  readonly progress: string[];
}> {
  const { runner, attempts } = fakeRunner(script);
  const progress: string[] = [];
  const execute = createReviewExecutor({
    targets,
    cwd: process.cwd(),
    runner,
    env: {},
    timeoutMs: options.timeoutMs ?? 120_000,
    onProgress: (line) => progress.push(line)
  });
  return { result: await execute(request()), attempts, progress };
}

test("configured read-only targets run in order until one returns a verdict", async () => {
  const { result, attempts, progress } = await run(
    ["codex", "agy", "claude"],
    [
      { errorCode: "ENOENT" },
      { exitCode: 1 },
      { stdout: failing("claude") }
    ]
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.command),
    ["codex", "agy", "claude"]
  );
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.attempts, [
    { target: "codex", status: "NOT_RUN", reason: "missing-executable" },
    { target: "agy", status: "NOT_RUN", reason: "login-required" },
    { target: "claude", status: "FAIL" }
  ]);
  assert.equal(progress.length, 2);
  assert.match(progress[0] ?? "", /codex/);
  assert.match(progress[1] ?? "", /agy/);
});

test("a FAIL verdict is terminal and never re-rolled on another target", async () => {
  const { result, attempts } = await run(
    ["claude", "agy"],
    [{ stdout: failing("claude") }, { stdout: passing("claude") }]
  );
  assert.equal(result.status, "FAIL");
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["claude"]);
});

test("a PASS verdict stops the chain", async () => {
  const { result, attempts } = await run(
    ["claude", "agy"],
    [{ stdout: passing("claude") }, { stdout: failing("claude") }]
  );
  assert.equal(result.status, "PASS");
  assert.equal(attempts.length, 1);
});

test("unparseable output advances to the next target", async () => {
  for (const stdout of [
    "",
    "{\"result\":",
    JSON.stringify({ result: "I could not comply." }),
    JSON.stringify({ response: JSON.stringify({ results: [] }) })
  ]) {
    const { result, attempts } = await run(
      ["claude", "agy"],
      [{ stdout }, { stdout: passing("agy") }]
    );
    assert.equal(result.status, "PASS");
    assert.equal(attempts.length, 2);
    assert.deepEqual(result.attempts, [
      { target: "claude", status: "NOT_RUN", reason: "unparseable-output" },
      { target: "agy", status: "PASS" }
    ]);
  }
});

test("a nonzero reviewer exit falls back after reporting missing authentication", async () => {
  const { result, attempts } = await run(
    ["claude", "agy"],
    [{ exitCode: 1 }, { stdout: passing("agy") }]
  );
  assert.equal(result.status, "PASS");
  assert.equal(attempts.length, 2);
  assert.deepEqual(result.attempts, [
    { target: "claude", status: "NOT_RUN", reason: "login-required" },
    { target: "agy", status: "PASS" }
  ]);
});

test("protocol violations report unparseable-output rather than FAIL", async () => {
  const violations: readonly unknown[] = [
    [],
    [{ criterionId: "other", status: "PASS", evidence: ["x"] }],
    [
      { criterionId: "tests", status: "PASS", evidence: ["x"] },
      { criterionId: "tests", status: "PASS", evidence: ["x"] }
    ],
    [{ criterionId: "tests", status: "PASS", evidence: [] }],
    [{ criterionId: "tests", status: "PASS", evidence: ["  "] }],
    [{ criterionId: "tests", status: "MAYBE", evidence: ["x"] }]
  ];
  for (const results of violations) {
    const { result } = await run(["claude"], [{ stdout: envelope(results, "claude") }]);
    assert.equal(result.status, "NOT_RUN");
    assert.equal(
      result.status === "NOT_RUN" ? result.reason : undefined,
      "unparseable-output"
    );
  }
});

test("an exhausted chain reports missing-cli", async () => {
  const { result, attempts } = await run(
    ["claude"],
    [{ errorCode: "ENOENT" }]
  );
  assert.equal(result.status, "NOT_RUN");
  assert.equal(
    result.status === "NOT_RUN" ? result.reason : undefined,
    "missing-cli"
  );
  assert.equal(attempts.length, 1);
});

test("every attempt carries its read-only flag and the prompt", async () => {
  const { attempts } = await run(
    ["codex", "agy", "claude"],
    [{ errorCode: "ENOENT" }, { errorCode: "ENOENT" }, { stdout: passing("claude") }]
  );
  const [codex, agy, claude] = attempts;
  assert.deepEqual(codex?.args.slice(0, 2), ["exec", "-"]);
  assert.deepEqual(agy?.args.slice(0, 1), ["-p"]);
  assert.deepEqual(claude?.args.slice(0, 1), ["-p"]);
  assert.ok(claude?.args.includes("--safe-mode"));
  for (const attempt of attempts) {
    const prompt = attempt.stdin ?? "";
    assert.match(prompt, /read-only/i);
    assert.match(prompt, /The test suite passes\./);
    assert.match(prompt, /BEGIN_TASK_DATA/);
    assert.doesNotMatch(prompt, /diff --git/);
    assert.doesNotMatch(prompt, /BEGIN [A-Z ]*PRIVATE KEY/);
  }
});

test("stderr is never fed to the extraction pipeline", async () => {
  const { result } = await run(
    ["claude"],
    [{ stdout: passing("claude"), stderr: `sandbox: read-only\n${failing("claude")}` }]
  );
  assert.equal(result.status, "PASS");
});

test("truncated Codex progress does not discard a complete stdout verdict", async () => {
  const { runner } = fakeRunner([{
    stdout: passing("codex"),
    stderr: "progress\n".repeat(1_000)
  }]);
  const execute = createReviewExecutor({
    targets: ["codex"],
    cwd: process.cwd(),
    runner,
    env: {},
    outputLimitBytes: 4_096
  });

  assert.equal((await execute(request())).status, "PASS");
});

test("truncated stdout advances and records every attempt", async () => {
  const { runner, attempts } = fakeRunner([
    { stdout: passing("claude") },
    { stdout: passing("claude") }
  ]);
  const execute = createReviewExecutor({
    targets: ["claude", "agy"],
    cwd: process.cwd(),
    runner,
    env: {},
    outputLimitBytes: 8
  });
  const result = await execute(request());
  assert.equal(result.status, "NOT_RUN");
  assert.equal(
    result.status === "NOT_RUN" ? result.reason : undefined,
    "output-too-large"
  );
  assert.equal(attempts.length, 2);
  assert.equal(result.attempts?.length, 2);
});

test("the detected host is tried last and warned about when it is alone", async () => {
  const { runner, attempts } = fakeRunner([
    { errorCode: "ENOENT" },
    { stdout: passing("claude") }
  ]);
  const progress: string[] = [];
  const ordered = createReviewExecutor({
    targets: ["codex", "claude"],
    cwd: process.cwd(),
    runner,
    env: { CLAUDECODE: "1" },
    onProgress: (line) => progress.push(line)
  });
  await ordered(request());
  assert.deepEqual(
    attempts.map((attempt) => attempt.command),
    ["codex", "claude"]
  );
  assert.equal(progress.length, 2);

  const alone = fakeRunner([{ stdout: passing("claude") }]);
  const warnings: string[] = [];
  const selfReview = createReviewExecutor({
    targets: ["claude"],
    cwd: process.cwd(),
    runner: alone.runner,
    env: { CLAUDECODE: "1" },
    onProgress: (line) => warnings.push(line)
  });
  const result = await selfReview(request());
  assert.equal(result.status, "PASS");
  assert.deepEqual(alone.attempts.map((attempt) => attempt.command), ["claude"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /reviewer == host/);
});

test("an ineligible target is skipped instead of run unsandboxed", async () => {
  const { result, attempts } = await run(
    ["opencode" as ReviewTargetId, "agy", "claude"],
    [{ stdout: passing("agy") }]
  );
  assert.equal(result.status, "PASS");
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["agy"]);
});

test("target environments preserve login state without sharing the review cwd", () => {
  const source = {
    HOME: "/home/user",
    USERPROFILE: "/users/user",
    XDG_CONFIG_HOME: "/home/user/config",
    XDG_CACHE_HOME: "/home/user/cache",
    CODEX_HOME: "/home/user/codex"
  };
  const codex = isolatedReviewEnvironment("codex", "/tmp/review", source);
  const agy = isolatedReviewEnvironment("agy", "/tmp/review", source);
  const claude = isolatedReviewEnvironment("claude", "/tmp/review", source);

  assert.equal(codex.CODEX_HOME, source.CODEX_HOME);
  assert.equal(codex.HOME, "/tmp/review");
  assert.equal(agy.HOME, source.HOME);
  assert.equal(agy.XDG_CONFIG_HOME, source.XDG_CONFIG_HOME);
  assert.equal(claude.HOME, "/tmp/review");
});

test("no targets configured reports missing-cli without spawning", async () => {
  const { result, attempts } = await run([], []);
  assert.equal(result.status, "NOT_RUN");
  assert.equal(
    result.status === "NOT_RUN" ? result.reason : undefined,
    "missing-cli"
  );
  assert.equal(attempts.length, 0);
});
