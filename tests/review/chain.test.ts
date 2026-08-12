import assert from "node:assert/strict";
import test from "node:test";

import type { ReviewTargetId } from "../../runtime/src/contracts.js";
import { createReviewExecutor } from "../../runtime/src/review/execute.js";
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
}

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
  const runner: VerificationProcessRunner = {
    start(request: ProcessRequest): RunningVerificationProcess {
      attempts.push({ command: request.command, args: [...request.args] });
      const step = script[index] ?? {};
      index += 1;
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
 * Each target's real transport shape: claude nests the answer under `result`,
 * agy under `response`, codex prints it bare. Sharing one shape across targets
 * would make these tests pass for the wrong reason.
 */
function envelope(results: unknown, target: ReviewTargetId = "agy"): string {
  const payload = JSON.stringify({ results });
  if (target === "codex") {
    return payload;
  }
  return JSON.stringify(
    target === "claude" ? { result: payload } : { response: payload }
  );
}

function passing(target: ReviewTargetId = "agy"): string {
  return envelope(
    [{ criterionId: "tests", status: "PASS", evidence: ["npm test"] }],
    target
  );
}

function failing(target: ReviewTargetId = "agy"): string {
  return envelope(
    [{ criterionId: "tests", status: "FAIL", evidence: ["npm test"] }],
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

test("a missing executable and a timeout both advance the chain", async () => {
  const { result, attempts, progress } = await run(
    ["codex", "agy", "claude"],
    [{ errorCode: "ENOENT" }, { hang: true }, { stdout: failing("claude") }],
    { timeoutMs: 30 }
  );
  assert.deepEqual(attempts.map((attempt) => attempt.command), [
    "codex",
    "agy",
    "claude"
  ]);
  assert.equal(result.status, "FAIL");
  assert.equal(progress.length, 2);
  assert.match(progress[0] ?? "", /codex/);
  assert.match(progress[1] ?? "", /agy/);
});

test("a FAIL verdict is terminal and never re-rolled on another target", async () => {
  const { result, attempts } = await run(
    ["codex", "agy", "claude"],
    [{ errorCode: "ENOENT" }, { stdout: failing("agy") }, { stdout: passing("claude") }]
  );
  assert.equal(result.status, "FAIL");
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["codex", "agy"]);
});

test("a PASS verdict stops the chain", async () => {
  const { result, attempts } = await run(
    ["agy", "claude"],
    [{ stdout: passing("agy") }, { stdout: failing("claude") }]
  );
  assert.equal(result.status, "PASS");
  assert.equal(attempts.length, 1);
});

test("unparseable output is terminal, not a reason to try another target", async () => {
  for (const stdout of [
    "",
    "{\"result\":",
    JSON.stringify({ result: "I could not comply." }),
    JSON.stringify({ response: JSON.stringify({ results: [] }) })
  ]) {
    const { result, attempts } = await run(
      ["agy", "claude"],
      [{ stdout }, { stdout: passing("claude") }]
    );
    assert.equal(result.status, "NOT_RUN");
    assert.equal(
      result.status === "NOT_RUN" ? result.reason : undefined,
      "unparseable-output"
    );
    assert.equal(attempts.length, 1);
  }
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
    const { result } = await run(["agy"], [{ stdout: envelope(results) }]);
    assert.equal(result.status, "NOT_RUN");
    assert.equal(
      result.status === "NOT_RUN" ? result.reason : undefined,
      "unparseable-output"
    );
  }
});

test("an exhausted chain reports missing-cli", async () => {
  const { result, attempts } = await run(
    ["codex", "agy"],
    [{ errorCode: "ENOENT" }, { errorCode: "ENOENT" }]
  );
  assert.equal(result.status, "NOT_RUN");
  assert.equal(
    result.status === "NOT_RUN" ? result.reason : undefined,
    "missing-cli"
  );
  assert.equal(attempts.length, 2);
});

test("every attempt carries its read-only flag and the prompt", async () => {
  const { attempts } = await run(
    ["codex", "agy", "claude"],
    [{ errorCode: "ENOENT" }, { errorCode: "ENOENT" }, { stdout: passing("claude") }]
  );
  const [codex, agy, claude] = attempts;
  assert.ok(codex?.args.includes("read-only"));
  assert.ok(agy?.args.includes("--sandbox"));
  assert.deepEqual(claude?.args.slice(0, 1), ["-p"]);
  for (const attempt of attempts) {
    const prompt = attempt.args[1] ?? "";
    assert.match(prompt, /read-only/i);
    assert.match(prompt, /The test suite passes\./);
    assert.match(prompt, /criterionId/);
    assert.doesNotMatch(prompt, /diff --git/);
    assert.doesNotMatch(prompt, /BEGIN [A-Z ]*PRIVATE KEY/);
  }
});

test("stderr is never fed to the extraction pipeline", async () => {
  const { result } = await run(
    ["agy"],
    [{ stdout: passing("agy"), stderr: `sandbox: read-only\n${failing("agy")}` }]
  );
  assert.equal(result.status, "PASS");
});

test("truncated stdout yields unparseable-output without advancing", async () => {
  const { runner, attempts } = fakeRunner([
    { stdout: passing("agy") },
    { stdout: passing("claude") }
  ]);
  const execute = createReviewExecutor({
    targets: ["agy", "claude"],
    cwd: process.cwd(),
    runner,
    env: {},
    outputLimitBytes: 8
  });
  const result = await execute(request());
  assert.equal(result.status, "NOT_RUN");
  assert.equal(
    result.status === "NOT_RUN" ? result.reason : undefined,
    "unparseable-output"
  );
  assert.equal(attempts.length, 1);
});

test("the detected host is tried last and warned about when it is alone", async () => {
  const { runner, attempts } = fakeRunner([{ stdout: passing("codex") }]);
  const progress: string[] = [];
  const ordered = createReviewExecutor({
    targets: ["claude", "codex"],
    cwd: process.cwd(),
    runner,
    env: { CLAUDECODE: "1" },
    onProgress: (line) => progress.push(line)
  });
  await ordered(request());
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["codex"]);
  assert.equal(progress.length, 0);

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
    ["opencode" as ReviewTargetId, "agy"],
    [{ stdout: passing("agy") }]
  );
  assert.equal(result.status, "PASS");
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["agy"]);
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
