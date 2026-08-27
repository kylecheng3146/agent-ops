import assert from "node:assert/strict";
import test from "node:test";

import type { ReviewTargetId } from "../../runtime/src/contracts.js";
import {
  createReviewExecutor,
  DEFAULT_REVIEW_TIMEOUT_MS,
  isolatedReviewEnvironment
} from "../../runtime/src/review/execute.js";
import { buildTargetInvocation } from "../../runtime/src/review/invocation.js";
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
  readonly cwd: string;
  readonly stdin?: string;
}

test("full reviews default to a fifteen-minute target timeout", () => {
  // A real working-tree review outruns five minutes on both codex and claude.
  assert.equal(DEFAULT_REVIEW_TIMEOUT_MS, 900_000);
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
    "--output-schema", "--log-file"
  ].join(" ");
  const runner: VerificationProcessRunner = {
    start(request: ProcessRequest): RunningVerificationProcess {
      const isHelp = request.args.includes("--help");
      const isSnapshot = request.command === "git" && request.args[0] === "clone";
      if (isHelp && request.command === "codex") {
        assert.deepEqual(request.args, ["exec", "--help"]);
      }
      if (!isHelp && !isSnapshot) {
        attempts.push({
          command: request.command,
          args: [...request.args],
          cwd: request.cwd,
          ...(request.stdin === undefined ? {} : { stdin: request.stdin })
        });
      }
      const step = isSnapshot
        ? {}
        : isHelp
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
      { stdout: failing("agy") }
    ]
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.command),
    ["codex", "agy"]
  );
  assert.equal(result.status, "FAIL");
  // Every NOT_RUN attempt explains itself; none carries only its reason code.
  assert.deepEqual(result.attempts, [
    {
      target: "codex",
      status: "NOT_RUN",
      reason: "missing-executable",
      diagnostic: "the process did not complete: missing-executable"
    },
    { target: "agy", status: "FAIL" }
  ]);
  assert.equal(progress.length, 1);
  assert.match(progress[0] ?? "", /codex/);
});

test("a FAIL verdict is terminal and never re-rolled on another target", async () => {
  const { result, attempts } = await run(
    ["claude", "codex"],
    [{ stdout: failing("claude") }, { stdout: passing("codex") }]
  );
  assert.equal(result.status, "FAIL");
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["claude"]);
});

test("a PASS verdict stops the primary chain", async () => {
  const { result, attempts } = await run(
    ["claude", "codex"],
    [{ stdout: passing("claude") }, { stdout: passing("codex") }]
  );
  assert.equal(result.status, "PASS");
  // The second attempt is the adversarial re-check, not a chain continuation.
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["claude", "codex"]);
  assert.deepEqual(result.attempts, [{ target: "claude", status: "PASS" }]);
});

test("a single configured target passes without an adversarial re-check", async () => {
  const { result, attempts } = await run(["claude"], [{ stdout: passing("claude") }]);
  assert.equal(result.status, "PASS");
  assert.equal(attempts.length, 1);
  assert.equal(result.status === "PASS" ? result.adversarial : "unset", undefined);
});

test("a second target re-checks a PASS and can uphold it", async () => {
  const { result, attempts, progress } = await run(
    ["claude", "codex"],
    [{ stdout: passing("claude") }, { stdout: passing("codex") }]
  );
  assert.equal(result.status, "PASS");
  const adversarial = result.status === "PASS" ? result.adversarial : undefined;
  assert.equal(adversarial?.target, "codex");
  assert.equal(adversarial?.refuted, false);
  assert.equal(adversarial?.report.summary, "Review complete.");
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["claude", "codex"]);
  assert.match(attempts[1]?.stdin ?? "", /BEGIN_PRIOR_REVIEW/);
  assert.match(attempts[1]?.stdin ?? "", /refute/i);
  assert.ok(progress.some((line) => /upheld the PASS/.test(line)));
});

test("a refuted PASS becomes FAIL and keeps both reports", async () => {
  const { result, progress } = await run(
    ["claude", "codex"],
    [{ stdout: passing("claude") }, { stdout: failing("codex") }]
  );
  assert.equal(result.status, "FAIL");
  const adversarial = result.status === "FAIL" ? result.adversarial : undefined;
  assert.equal(adversarial?.refuted, true);
  assert.ok(adversarial?.report.findings.some((finding) => finding.blocking));
  // The primary report survives untouched: its criteria still read PASS.
  assert.deepEqual(
    result.status === "FAIL"
      ? result.report?.results.map((item) => item.status)
      : undefined,
    ["PASS"]
  );
  assert.ok(progress.some((line) => /refuted the PASS/.test(line)));
});

test("a target that already failed the chain is not asked to refute", async () => {
  const { result, attempts } = await run(
    ["claude", "codex"],
    [{ errorCode: "ENOENT" }, { stdout: passing("codex") }]
  );
  assert.equal(result.status, "PASS");
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["claude", "codex"]);
  assert.equal(result.status === "PASS" ? result.adversarial : "unset", undefined);
});

test("the host is never used as the adversarial reviewer", async () => {
  const { runner, attempts } = fakeRunner([
    { stdout: passing("codex") },
    { stdout: failing("claude") }
  ]);
  const execute = createReviewExecutor({
    targets: ["codex", "claude"],
    cwd: process.cwd(),
    runner,
    env: { CLAUDECODE: "1" }
  });
  const result = await execute(request());
  assert.equal(result.status, "PASS");
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["codex"]);
});

test("unparseable output advances to the next target", async () => {
  for (const stdout of [
    "",
    "{\"result\":",
    JSON.stringify({ result: "I could not comply." }),
    JSON.stringify({ response: JSON.stringify({ results: [] }) })
  ]) {
    const { result, attempts } = await run(
      ["claude", "codex"],
      [{ stdout }, { stdout: passing("codex") }]
    );
    assert.equal(result.status, "PASS");
    assert.equal(attempts.length, 2);
    const [skipped, verdict] = result.attempts ?? [];
    assert.equal(skipped?.target, "claude");
    assert.equal(skipped?.status, "NOT_RUN");
    assert.equal(skipped?.reason, "unparseable-output");
    // Whatever came back instead of a report is named, so a target that runs
    // but never answers the contract is debuggable from structured output.
    if (stdout.length > 0) {
      assert.notEqual(skipped?.diagnostic, undefined, stdout);
    }
    assert.deepEqual(verdict, { target: "codex", status: "PASS" });
  }
});

test("a rejected call surfaces the target's own complaint, redacted", async () => {
  const secret = ["Author", "ization: Bearer abcdef123456"].join("");
  const { result, progress } = await run(
    ["claude", "codex"],
    [
      { exitCode: 1, stderr: `Error: -p took "--output-format" as its prompt.\n${secret}` },
      { stdout: passing("codex") }
    ]
  );
  const line = progress.find((value) => value.startsWith("claude:")) ?? "";
  assert.match(line, /login-required/);
  assert.match(line, /-p took "--output-format" as its prompt/);
  assert.doesNotMatch(line, /abcdef123456/);

  // Progress is suppressed under --json, so the complaint has to survive on the
  // attempt itself or a machine consumer is left with the bare guess.
  const attempt = result.attempts?.find((item) => item.target === "claude");
  assert.equal(attempt?.reason, "login-required");
  assert.match(attempt?.diagnostic ?? "", /-p took "--output-format" as its prompt/);
  assert.doesNotMatch(JSON.stringify(result), /abcdef123456/);
});

test("a missing help flag is named, not flattened into a bare skip", async () => {
  const { runner, attempts } = fakeRunner([{ stdout: passing("codex") }]);
  const stale: VerificationProcessRunner = {
    start(request: ProcessRequest): RunningVerificationProcess {
      if (request.args.includes("--help") && request.command === "claude") {
        return {
          pid: 1,
          // A released CLI that renamed the flag: help succeeds, flag is gone.
          stdout: bytes("--add-dir --permission-mode --json-schema"),
          stderr: bytes(""),
          completion: Promise.resolve({ exitCode: 0, signal: null }),
          terminateTree: async () => {}
        };
      }
      return runner.start(request);
    }
  };
  const execute = createReviewExecutor({
    targets: ["claude", "codex"],
    cwd: process.cwd(),
    runner: stale,
    env: {}
  });
  const result = await execute(request());

  assert.equal(result.status, "PASS");
  const skipped = result.attempts?.find((item) => item.target === "claude");
  assert.equal(skipped?.reason, "capability-unavailable");
  assert.match(skipped?.diagnostic ?? "", /help output is missing/);
  assert.match(skipped?.diagnostic ?? "", /--safe-mode/);
  assert.equal(attempts.length, 1);
});

test("an unavailable challenger is recorded, not merely reported", async () => {
  const { result, progress } = await run(
    ["claude", "codex"],
    [{ stdout: passing("claude") }, { exitCode: 1, stderr: "Error: quota exhausted." }]
  );

  assert.equal(result.status, "PASS");
  // A PASS with no adversarial field must stay distinguishable from a PASS that
  // had no challenger available at all, and progress is absent under --json.
  assert.equal(result.status === "PASS" ? result.adversarial : "unset", undefined);
  const challenger = result.attempts?.find((item) => item.target === "codex");
  assert.equal(challenger?.status, "NOT_RUN");
  assert.equal(challenger?.reason, "login-required");
  assert.match(challenger?.diagnostic ?? "", /quota exhausted/);
  assert.ok(progress.some((line) => /adversarial re-check unavailable/.test(line)));
});

test("a rejected call with nothing to say still explains itself", async () => {
  const { result } = await run(
    ["claude", "codex"],
    [{ exitCode: 1 }, { stdout: passing("codex") }]
  );
  const attempt = result.attempts?.find((item) => item.target === "claude");
  assert.equal(attempt?.reason, "login-required");
  // Silence is itself the finding: a bare reason code would leave a JSON
  // consumer unable to tell a missing login from a target that said nothing.
  assert.match(attempt?.diagnostic ?? "", /rejected with exit 1 and no output/);
});

test("every skipped attempt carries a diagnostic, whatever the cause", async () => {
  const causes: readonly [string, Scripted, RegExp][] = [
    ["missing executable", { errorCode: "ENOENT" }, /did not complete: missing-executable/],
    ["silent rejection", { exitCode: 1 }, /rejected with exit 1 and no output/],
    ["empty answer", { stdout: "" }, /carried no review report/],
    ["contract violation", { stdout: envelope([], "claude") }, /INVALID_REPORT/]
  ];
  for (const [label, step, expected] of causes) {
    const { result } = await run(
      ["claude", "codex"],
      [step, { stdout: passing("codex") }]
    );
    const attempt = result.attempts?.find((item) => item.target === "claude");
    assert.equal(attempt?.status, "NOT_RUN", label);
    assert.match(attempt?.diagnostic ?? "", expected, label);
  }
});

test("truncated output names the stream that overflowed", async () => {
  const { runner } = fakeRunner([{ stdout: passing("claude") }, { stdout: passing("codex") }]);
  const execute = createReviewExecutor({
    targets: ["claude", "codex"],
    cwd: process.cwd(),
    runner,
    env: {},
    outputLimitBytes: 8
  });
  const result = await execute(request());
  const attempt = result.attempts?.find((item) => item.target === "claude");
  assert.equal(attempt?.reason, "output-too-large");
  assert.match(attempt?.diagnostic ?? "", /stdout exceeded the capture limit/);
});

test("a nonzero reviewer exit falls back after reporting missing authentication", async () => {
  const { result, attempts } = await run(
    ["claude", "codex"],
    [{ exitCode: 1 }, { stdout: passing("codex") }]
  );
  assert.equal(result.status, "PASS");
  assert.equal(attempts.length, 2);
  const [rejected, verdict] = result.attempts ?? [];
  assert.equal(rejected?.target, "claude");
  assert.equal(rejected?.reason, "login-required");
  assert.notEqual(rejected?.diagnostic, undefined);
  assert.deepEqual(verdict, { target: "codex", status: "PASS" });
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
    ["codex", "claude"],
    [{ errorCode: "ENOENT" }, { stdout: passing("claude") }]
  );
  const [codex, claude] = attempts;
  assert.deepEqual(codex?.args.slice(0, 2), ["exec", "-"]);
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
    targets: ["claude", "codex"],
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

test("an ineligible target is skipped before agy runs sandboxed", async () => {
  const { result, attempts } = await run(
    ["opencode" as ReviewTargetId, "agy"],
    [{ stdout: passing("agy") }]
  );
  assert.equal(result.status, "PASS");
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["agy"]);
  assert.match(attempts[0]?.cwd ?? "", /\/repository$/);
  assert.equal(
    attempts[0]?.args[attempts[0].args.indexOf("--add-dir") + 1],
    attempts[0]?.cwd
  );
  assert.match(attempts[0]?.args[1] ?? "", /Repository root: .*\/repository/);
});

test("agy also challenges a PASS from inside its disposable clone", async () => {
  const { result, attempts } = await run(
    ["codex", "agy"],
    [{ stdout: passing("codex") }, { stdout: passing("agy") }]
  );
  assert.equal(result.status, "PASS");
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["codex", "agy"]);
  assert.match(attempts[1]?.cwd ?? "", /\/repository$/);
  assert.equal(
    attempts[1]?.args[attempts[1].args.indexOf("--add-dir") + 1],
    attempts[1]?.cwd
  );
  assert.match(attempts[1]?.args[1] ?? "", /Repository root: .*\/repository/);
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
  // claude reads its credentials from the real home; --safe-mode, not a
  // replaced HOME, is what keeps the reviewer clear of user customizations.
  assert.equal(claude.HOME, source.HOME);
  assert.equal(claude.XDG_CONFIG_HOME, source.XDG_CONFIG_HOME);
});

test("the account name reaches every target's credential store", () => {
  const source = { HOME: "/home/user", USER: "user", PATH: "/usr/bin" };
  for (const target of ["claude", "codex", "agy"] as const) {
    assert.equal(
      isolatedReviewEnvironment(target, "/tmp/review", source).USER,
      "user",
      `${target} needs USER to open a keychain keyed by account name`
    );
  }
});

test("the claude reviewer keeps the flags that stand in for a replaced home", () => {
  const args = buildTargetInvocation({ target: "claude", prompt: "review" })?.args ?? [];
  for (const flag of [
    "--safe-mode", "--disable-slash-commands", "--no-session-persistence",
    "--permission-mode", "plan"
  ]) {
    assert.ok(args.includes(flag), `claude args must include ${flag}`);
  }
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
