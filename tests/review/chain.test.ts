import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";

import type { ReviewTargetId } from "../../runtime/src/contracts.js";
import {
  createReviewExecutor,
  DEFAULT_REVIEW_TIMEOUT_MS,
  DEFAULT_STALL_IDLE_MS,
  isolatedReviewEnvironment,
  ReviewInterruptedError
} from "../../runtime/src/review/execute.js";
import { buildTargetInvocation } from "../../runtime/src/review/invocation.js";
import { renderReviewResult } from "../../runtime/src/review/render.js";
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
  /**
   * Emit this many signs of life, one every `beatMs`, then complete normally.
   * `beatVia` picks which channel: the target's own log file, named by its
   * `--log-file`/`--debug-file` argument, or a stderr chunk.
   */
  readonly beats?: number;
  readonly beatMs?: number;
  readonly beatVia?: "log" | "stderr";
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

/** Where the target was told to write its own log, when it was told at all. */
function logFileArgument(args: readonly string[]): string | undefined {
  for (const flag of ["--log-file", "--debug-file"]) {
    const index = args.indexOf(flag);
    if (index >= 0) {
      return args[index + 1];
    }
  }
  return undefined;
}

/** Stderr that arrives in chunks over time, the way progress output does. */
function heartbeatBytes(
  count: number,
  everyMs: number
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < count; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, everyMs));
        yield Buffer.from(`beat ${index}\n`);
      }
    }
  };
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
      let finish: ((completion: {
        exitCode: number | null;
        signal: string | null;
      }) => void) | undefined;
      const completion = step.hang === true
        ? new Promise<{ exitCode: number | null; signal: string | null }>(
            (resolve) => { finish = resolve; }
          )
        : Promise.resolve({
            exitCode: step.exitCode ?? 0,
            signal: null,
            ...(step.errorCode === undefined
              ? {}
              : { errorCode: step.errorCode })
          });
      const beats = step.beats ?? 0;
      const beatMs = step.beatMs ?? 10;
      const logPath = logFileArgument(request.args);
      const beating = beats === 0
        ? completion
        : new Promise<{ exitCode: number | null; signal: string | null }>(
            (resolve) => {
              let sent = 0;
              const timer = setInterval(() => {
                sent += 1;
                if (step.beatVia === "log" && logPath !== undefined) {
                  appendFileSync(logPath, `beat ${sent}\n`);
                }
                if (sent >= beats) {
                  clearInterval(timer);
                  resolve({ exitCode: step.exitCode ?? 0, signal: null });
                }
              }, beatMs);
              finish = (value) => {
                clearInterval(timer);
                resolve(value);
              };
            }
          );
      return {
        pid: 4242,
        stdout: bytes(step.stdout ?? ""),
        stderr: beats > 0 && step.beatVia === "stderr"
          ? heartbeatBytes(beats, beatMs)
          : bytes(step.stderr ?? ""),
        completion: beating,
        terminateTree: async () => {
          finish?.({ exitCode: null, signal: "SIGTERM" });
        }
      };
    }
  };
  return { runner, attempts };
}

/**
 * Each target's real transport shape: claude nests the answer under
 * `structured_output`, while codex prints it bare. Sharing one shape across
 * envelope and bare-output targets would make these tests pass for the wrong reason.
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
  return JSON.stringify({ structured_output: JSON.parse(payload) });
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
  options: {
    readonly timeoutMs?: number;
    readonly stallIdleMs?: number;
    readonly chainTimeoutMs?: number;
  } = {}
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
    env: targets.length >= 3 ? { AGENT_OPS_HOST: "claude" } : {},
    // These cases assert chain behavior, not the machine's loopback policy.
    probeBind: async () => true,
    timeoutMs: options.timeoutMs ?? 120_000,
    ...(options.chainTimeoutMs === undefined
      ? {}
      : { chainTimeoutMs: options.chainTimeoutMs }),
    ...(options.stallIdleMs === undefined
      ? {}
      : { stallIdleMs: options.stallIdleMs }),
    onProgress: (line) => progress.push(line)
  });
  return { result: await execute(request()), attempts, progress };
}

test("three configured targets choose the two non-host reviewers", async () => {
  const { result, attempts, progress } = await run(
    ["codex", "agy", "claude"],
    [
      { stdout: passing("agy") },
      { stdout: failing("codex") }
    ]
  );
  assert.deepEqual(
    attempts.map((attempt) => attempt.command),
    ["agy", "codex"]
  );
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.attempts?.map(({ target, status }) => ({ target, status })), [
    { target: "agy", status: "PASS" },
    { target: "codex", status: "FAIL" }
  ]);
  assert.ok(progress.some((line) => /agy: checking reviewer capability/.test(line)));
  assert.ok(progress.some((line) => /codex: review started \(timeout: 120s\)/.test(line)));
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
  assert.deepEqual(result.attempts?.map(({ target, status }) => ({ target, status })), [
    { target: "claude", status: "PASS" },
    { target: "codex", status: "PASS" }
  ]);
});

test("a single configured target is invoked twice in fresh sessions", async () => {
  const { result, attempts } = await run(
    ["claude"],
    [{ stdout: passing("claude") }, { stdout: passing("claude") }]
  );
  assert.equal(result.status, "PASS");
  assert.equal(attempts.length, 2);
  assert.equal(result.status === "PASS" ? result.adversarial?.target : undefined, "claude");
  assert.deepEqual(result.attempts?.map(({ target, status }) => ({ target, status })), [
    { target: "claude", status: "PASS" },
    { target: "claude", status: "PASS" }
  ]);
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

test("a target that cannot produce the necessary verdict stops the review", async () => {
  const { result, attempts } = await run(
    ["claude", "codex"],
    [{ errorCode: "ENOENT" }, { stdout: passing("codex") }]
  );
  assert.equal(result.status, "NOT_RUN");
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["claude"]);
  assert.equal(result.status === "NOT_RUN" ? result.reason : undefined, "missing-cli");
});

test("a two-target pair keeps configured order when one target is the host", async () => {
  const { runner, attempts } = fakeRunner([
    { stdout: passing("codex") },
    { stdout: failing("claude") }
  ]);
  const execute = createReviewExecutor({
    targets: ["codex", "claude"],
    cwd: process.cwd(),
    runner,
    env: { AGENT_OPS_HOST: "claude" },
    probeBind: async () => true
  });
  const result = await execute(request());
  assert.equal(result.status, "FAIL");
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["codex", "claude"]);
  assert.equal(result.status === "FAIL" ? result.adversarial?.target : undefined, "claude");
});

test("unparseable output stops before the adversarial session", async () => {
  for (const stdout of [
    "",
    "{\"result\":",
    JSON.stringify({ result: "I could not comply." }),
    JSON.stringify({ response: JSON.stringify({ results: [] }) })
  ]) {
    const { result, attempts } = await run(
      ["claude", "codex"],
      [{ stdout }]
    );
    assert.equal(result.status, "NOT_RUN");
    assert.equal(attempts.length, 1);
    const [skipped] = result.attempts ?? [];
    assert.equal(skipped?.target, "claude");
    assert.equal(skipped?.status, "NOT_RUN");
    assert.equal(skipped?.reason, "unparseable-output");
    // Whatever came back instead of a report is named, so a target that runs
    // but never answers the contract is debuggable from structured output.
    if (stdout.length > 0) {
      assert.notEqual(skipped?.diagnostic, undefined, stdout);
    }
  }
});

test("a non-auth rejection surfaces the target's own complaint, redacted", async () => {
  const secret = ["Author", "ization: Bearer abcdef123456"].join("");
  const { result, progress } = await run(
    ["claude", "codex"],
    [
      { exitCode: 1, stderr: `Error: -p took "--output-format" as its prompt.\n${secret}` }
    ]
  );
  const line = progress.find((value) => /claude: capability-unavailable/.test(value)) ?? "";
  assert.match(line, /capability-unavailable/);
  assert.match(line, /-p took "--output-format" as its prompt/);
  assert.doesNotMatch(line, /abcdef123456/);

  // Stderr progress is transient, so the complaint has to survive on the
  // attempt itself for machine consumers.
  const attempt = result.attempts?.find((item) => item.target === "claude");
  assert.equal(attempt?.reason, "capability-unavailable");
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
    env: {},
    probeBind: async () => true
  });
  const result = await execute(request());

  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.status === "NOT_RUN" ? result.reason : undefined, "capability-unavailable");
  const skipped = result.attempts?.find((item) => item.target === "claude");
  assert.equal(skipped?.reason, "capability-unavailable");
  assert.match(skipped?.diagnostic ?? "", /help output is missing/);
  assert.match(skipped?.diagnostic ?? "", /--safe-mode/);
  assert.equal(attempts.length, 0);
});

test("an unavailable challenger keeps the final status NOT_RUN", async () => {
  const { result, progress } = await run(
    ["claude", "codex"],
    [{ stdout: passing("claude") }, { exitCode: 1, stderr: "Error: quota exhausted." }]
  );

  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.status === "NOT_RUN" ? result.reason : undefined, "quota-exhausted");
  const challenger = result.attempts?.find((item) => item.target === "codex");
  assert.equal(challenger?.status, "NOT_RUN");
  assert.equal(challenger?.reason, "quota-exhausted");
  assert.match(challenger?.diagnostic ?? "", /quota exhausted/);
  assert.ok(progress.some((line) => /adversarial re-check unavailable/.test(line)));
});

test("a rejected call with nothing to say still explains itself", async () => {
  const { result } = await run(
    ["claude", "codex"],
    [{ exitCode: 1 }]
  );
  const attempt = result.attempts?.find((item) => item.target === "claude");
  assert.equal(attempt?.reason, "capability-unavailable");
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
      [step]
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
    outputLimitBytes: 8,
    probeBind: async () => true
  });
  const result = await execute(request());
  const attempt = result.attempts?.find((item) => item.target === "claude");
  assert.equal(result.status, "NOT_RUN");
  assert.equal(attempt?.reason, "output-too-large");
  assert.match(attempt?.diagnostic ?? "", /capture limit/);
});

test("a nonzero reviewer exit stops after reporting explicit missing authentication", async () => {
  const { result, attempts } = await run(
    ["claude", "codex"],
    [{ exitCode: 1, stderr: "Error: not logged in" }]
  );
  assert.equal(result.status, "NOT_RUN");
  assert.equal(attempts.length, 1);
  const [rejected] = result.attempts ?? [];
  assert.equal(rejected?.target, "claude");
  assert.equal(rejected?.reason, "login-required");
  assert.notEqual(rejected?.diagnostic, undefined);
});

test("a sandbox permission failure stops as capability-unavailable", async () => {
  const { result, progress } = await run(
    ["codex", "claude"],
    [
      { exitCode: 1, stderr: "Operation not permitted (os error 1)" }
    ]
  );

  assert.equal(result.status, "NOT_RUN");
  assert.ok(progress.some((line) => /capability-unavailable/.test(line)));
  const rejected = result.attempts?.find((attempt) => attempt.target === "codex");
  assert.equal(rejected?.reason, "capability-unavailable");
  assert.match(rejected?.diagnostic ?? "", /Operation not permitted/);
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
    [{ stdout: passing("codex") }, { stdout: passing("claude") }]
  );
  const [codex, claude] = attempts;
  assert.deepEqual(codex?.args.slice(0, 3), ["exec", "-", "--skip-git-repo-check"]);
  assert.ok(codex?.args.includes("-s"));
  assert.ok(codex?.args.includes("read-only"));
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
    [
      { stdout: passing("claude"), stderr: `sandbox: read-only\n${failing("claude")}` },
      { stdout: passing("claude") }
    ]
  );
  assert.equal(result.status, "PASS");
});

test("truncated Codex progress does not discard a complete stdout verdict", async () => {
  const { runner } = fakeRunner([{
    stdout: passing("codex"),
    stderr: "progress\n".repeat(1_000)
  }, { stdout: passing("codex") }]);
  const execute = createReviewExecutor({
    targets: ["codex"],
    cwd: process.cwd(),
    runner,
    env: {},
    outputLimitBytes: 4_096,
    probeBind: async () => true
  });

  assert.equal((await execute(request())).status, "PASS");
});

test("truncated stdout stops the necessary review", async () => {
  const { runner, attempts } = fakeRunner([
    { stdout: passing("claude") },
    { stdout: passing("codex") }
  ]);
  const execute = createReviewExecutor({
    targets: ["claude", "codex"],
    cwd: process.cwd(),
    runner,
    env: {},
    outputLimitBytes: 8,
    probeBind: async () => true
  });
  const result = await execute(request());
  assert.equal(result.status, "NOT_RUN");
  assert.equal(
    result.status === "NOT_RUN" ? result.reason : undefined,
    "output-too-large"
  );
  assert.equal(attempts.length, 1);
  assert.equal(result.attempts?.length, 1);
});

test("two configured targets stop on an unavailable primary even when the host is known", async () => {
  const { runner, attempts } = fakeRunner([
    { errorCode: "ENOENT" },
    { stdout: passing("claude") }
  ]);
  const progress: string[] = [];
  const ordered = createReviewExecutor({
    targets: ["codex", "claude"],
    cwd: process.cwd(),
    runner,
    env: { AGENT_OPS_HOST: "claude" },
    probeBind: async () => true,
    onProgress: (line) => progress.push(line)
  });
  await ordered(request());
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["codex"]);
  assert.ok(progress.some((line) => /codex: missing-cli/.test(line)));

  const alone = fakeRunner([
    { stdout: passing("claude") },
    { stdout: passing("claude") }
  ]);
  const warnings: string[] = [];
  const selfReview = createReviewExecutor({
    targets: ["claude"],
    cwd: process.cwd(),
    runner: alone.runner,
    env: { AGENT_OPS_HOST: "claude" },
    probeBind: async () => true,
    onProgress: (line) => warnings.push(line)
  });
  const result = await selfReview(request());
  assert.equal(result.status, "PASS");
  assert.deepEqual(alone.attempts.map((attempt) => attempt.command), ["claude", "claude"]);
  assert.ok(warnings.some((line) => /claude: adversarial re-check/.test(line)));
});

test("an exhausted timeout chain reports timeout rather than missing-cli", async () => {
  const { result } = await run(["claude"], [{ hang: true }], { timeoutMs: 5 });
  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.status === "NOT_RUN" ? result.reason : undefined, "timeout");
  assert.equal(result.attempts?.[0]?.reason, "timeout");
});

test("cancellation stops the chain instead of falling back", async () => {
  const controller = new AbortController();
  const { runner, attempts } = fakeRunner([{ hang: true }, { stdout: passing("codex") }]);
  const progress: string[] = [];
  let reviewStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    reviewStarted = resolve;
  });
  const execute = createReviewExecutor({
    targets: ["claude", "codex"],
    cwd: process.cwd(),
    runner,
    env: {},
    probeBind: async () => true,
    signal: controller.signal,
    onProgress: (line) => {
      progress.push(line);
      if (/claude: review started/.test(line)) {
        reviewStarted();
      }
    }
  });
  const pending = execute(request());
  await started;
  controller.abort("SIGINT");

  await assert.rejects(pending, ReviewInterruptedError);
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["claude"]);
  assert.ok(progress.some((line) => /claude: review interrupted by SIGINT/.test(line)));
});

test("an ineligible primary target stops before the next target", async () => {
  const { result, attempts } = await run(
    ["opencode" as ReviewTargetId, "agy"],
    []
  );
  assert.equal(result.status, "NOT_RUN");
  assert.equal(
    result.status === "NOT_RUN" ? result.reason : undefined,
    "capability-unavailable"
  );
  assert.deepEqual(attempts, []);
  assert.equal(result.attempts?.[0]?.target, "opencode");
});

test("agy also challenges a PASS from inside its disposable clone", async () => {
  const { result, attempts } = await run(
    ["codex", "agy"],
    [{ stdout: passing("codex") }, { stdout: passing("agy") }]
  );
  assert.equal(result.status, "PASS");
  assert.deepEqual(attempts.map((attempt) => attempt.command), ["codex", "agy"]);
  assert.equal(basename(attempts[1]?.cwd ?? ""), "repository");
  assert.equal(
    attempts[1]?.args[attempts[1].args.indexOf("--add-dir") + 1],
    attempts[1]?.cwd
  );
  assert.ok(attempts[1]?.args[1]?.includes(`Repository root: ${attempts[1].cwd}`));
});

test("every reviewer target runs from its disposable clone", async () => {
  for (const target of ["codex", "claude"] as const) {
    const { result, attempts } = await run(
      [target],
      [{ stdout: passing(target) }, { stdout: passing(target) }]
    );
    assert.equal(result.status, "PASS");
    assert.equal(basename(attempts[0]?.cwd ?? ""), "repository");
    assert.equal(attempts.length, 2);
    if (target === "codex") {
      assert.equal(
        attempts[0]?.args[attempts[0].args.indexOf("-C") + 1],
        attempts[0]?.cwd
      );
    }
  }
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

test("the stall window is ninety seconds by default", () => {
  // Short enough that a sandbox-blocked chain reports in minutes, long enough
  // that a reviewer thinking between progress lines is never cut off.
  assert.equal(DEFAULT_STALL_IDLE_MS, 90_000);
});

test("a silent necessary reviewer stops the review as stalled", async () => {
  const { result, attempts, progress } = await run(
    ["agy", "claude"],
    [
      { hang: true }
    ],
    // The full timeout stays far out of reach: only the stall window may fire.
    { stallIdleMs: 60, timeoutMs: 120_000 }
  );

  assert.deepEqual(attempts.map((attempt) => attempt.command), ["agy"]);
  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.status === "NOT_RUN" ? result.reason : undefined, "stalled");
  assert.equal(result.attempts?.length, 1);
  assert.equal(result.attempts?.[0]?.reason, "stalled");
  assert.ok(progress.some((line) => line.startsWith("agy: stalled →")));
});

test("log-file growth is a heartbeat that holds off the stall abort", async () => {
  const { result } = await run(
    ["agy"],
    [
      { beats: 8, beatMs: 15, beatVia: "log", stdout: passing("agy") },
      { stdout: passing("agy") }
    ],
    { stallIdleMs: 60, timeoutMs: 120_000 }
  );

  // Eight beats spans well past the 60ms window; without the file heartbeat
  // this target is killed before it answers.
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.attempts?.map(({ target, status }) => ({ target, status })), [
    { target: "agy", status: "PASS" },
    { target: "agy", status: "PASS" }
  ]);
});

test("streamed stderr is a heartbeat that holds off the stall abort", async () => {
  const { result } = await run(
    ["codex"],
    [
      { beats: 8, beatMs: 15, beatVia: "stderr", stdout: passing("codex") },
      { stdout: passing("codex") }
    ],
    { stallIdleMs: 60, timeoutMs: 120_000 }
  );

  assert.equal(result.status, "PASS");
  assert.deepEqual(result.attempts?.map(({ target, status }) => ({ target, status })), [
    { target: "codex", status: "PASS" },
    { target: "codex", status: "PASS" }
  ]);
});

test("claude keeps its heartbeat flag out of the call when help omits it", async () => {
  // The fake help output advertises --log-file but not --debug-file, so this
  // install must still review — it only loses the file heartbeat.
  const { result, attempts } = await run(
    ["claude"],
    [{ stdout: passing("claude") }, { stdout: passing("claude") }]
  );

  assert.equal(result.status, "PASS");
  assert.ok(!(attempts[0]?.args ?? []).includes("--debug-file"));
});

test("a declared network block requires the external host runner", async () => {
  const { runner, attempts } = fakeRunner([{ stdout: passing("agy") }]);
  const progress: string[] = [];
  const execute = createReviewExecutor({
    targets: ["agy"],
    cwd: process.cwd(),
    runner,
    env: { CODEX_SANDBOX_NETWORK_DISABLED: "1" },
    onProgress: (line) => progress.push(line)
  });

  const result = await execute(request());

  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.status === "NOT_RUN" ? result.reason : undefined, "host-required");
  assert.deepEqual(attempts, []);
  assert.equal(result.status === "NOT_RUN" ? result.hostRestriction : undefined, "network-blocked");
  assert.ok(progress.some((line) => line.includes("external review host runner required")));
});

test("a bind-blocked host requires the external host runner", async () => {
  const { runner, attempts } = fakeRunner([{ stdout: passing("claude") }]);
  const progress: string[] = [];
  const execute = createReviewExecutor({
    // agy first by configuration; the restriction must reorder it, not drop it.
    targets: ["agy", "claude"],
    cwd: process.cwd(),
    runner,
    env: {},
    probeBind: async () => false,
    onProgress: (line) => progress.push(line)
  });

  const result = await execute(request());

  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.status === "NOT_RUN" ? result.reason : undefined, "host-required");
  assert.deepEqual(attempts, []);
  assert.equal(result.status === "NOT_RUN" ? result.hostRestriction : undefined, "bind-blocked");
  assert.ok(progress.some((line) => line.includes("external review host runner required")));
});

test("agy is told to answer the review rather than plan the work", async () => {
  const { attempts } = await run(["agy"], [{ stdout: passing("agy") }]);
  const prompt = attempts[0]?.args[attempts[0].args.indexOf("-p") + 1] ?? "";

  // Plan mode's default job is to author an implementation plan and ask
  // whether to proceed, which under --print ends the only turn agy gets and
  // returns an empty review after minutes of work.
  assert.match(prompt, /Do not write an implementation plan/u);
  assert.match(prompt, /Do not create or edit any file/u);
  assert.match(prompt, /Do not ask the user anything/u);
});

test("every attempt records what it cost, including one that never ran", async () => {
  const { result } = await run(
    ["agy", "codex"],
    [{ stdout: passing("agy") }, { stdout: passing("codex") }]
  );

  assert.equal(result.status, "PASS");
  assert.equal(result.attempts?.length, 2);
  for (const attempt of result.attempts ?? []) {
    assert.ok(attempt.metrics, `${attempt.target} recorded no cost`);
    assert.ok(attempt.metrics.promptBytes > 0);
    assert.ok(attempt.metrics.durationMs >= 0);
  }
  assert.match(
    renderReviewResult({
      ...result,
      harness: "agy",
      model: "m",
      effort: "e",
      prompt: "p"
    }),
    /cost: .*prompt \d+ bytes, tokens unknown/
  );

  const stopped = await run(
    ["agy", "codex"],
    [{ stdout: "not a review report at all" }]
  );
  assert.equal(stopped.result.status, "NOT_RUN");
  assert.ok(
    stopped.result.attempts?.[0]?.metrics,
    "a round that produced no verdict still spent time"
  );
});

test("reported usage reaches the attempt record and the rendered summary", async () => {
  const withUsage = JSON.stringify({
    structured_output: JSON.parse(
      passing("agy").startsWith("{\"structured_output\"")
        ? JSON.stringify(
            (JSON.parse(passing("agy")) as { structured_output: unknown })
              .structured_output
          )
        : passing("agy")
    ),
    usage: { input_tokens: 1_000, output_tokens: 250, total_tokens: 1_250 }
  });
  const { result } = await run(
    ["agy", "codex"],
    [{ stdout: withUsage }, { stdout: passing("codex") }]
  );

  assert.equal(result.status, "PASS");
  assert.deepEqual(result.attempts?.[0]?.metrics?.usage, {
    inputTokens: 1_000,
    outputTokens: 250,
    totalTokens: 1_250
  });
  assert.match(
    renderReviewResult({
      ...result,
      harness: "agy",
      model: "m",
      effort: "e",
      prompt: "p"
    }),
    /tokens 1250/
  );
});

test("a reviewer that keeps emitting heartbeats is still cut off by the deadline", async () => {
  // Real timers: the first round answers immediately, the second hangs while
  // emitting stderr heartbeats, which satisfies the stall detector. Only the
  // chain budget can end it.
  const { result, attempts } = await run(
    ["agy", "codex"],
    [
      { stdout: passing("agy") },
      { hang: true, beats: 200, beatMs: 10, beatVia: "stderr" }
    ],
    { timeoutMs: 60_000, chainTimeoutMs: 1_500, stallIdleMs: 30_000 }
  );

  assert.equal(result.status, "NOT_RUN");
  assert.equal(attempts.length, 2, "both rounds must have started");
  assert.equal(result.attempts?.[0]?.status, "PASS");
  assert.equal(result.attempts?.at(-1)?.status, "NOT_RUN");
  assert.equal(result.attempts?.at(-1)?.reason, "timeout");
});

test("the chain budget bounds a round whose own timeout is far larger", async () => {
  const started = Date.now();
  // Per-target timeout of a minute, chain budget of a fraction of a second:
  // the round has to end on the chain's terms, not its own.
  const { result } = await run(
    ["agy", "codex"],
    [{ hang: true }],
    { timeoutMs: 60_000, chainTimeoutMs: 300 }
  );

  assert.equal(result.status, "NOT_RUN");
  assert.ok(
    Date.now() - started < 30_000,
    "the chain waited on the per-target timeout instead of its own budget"
  );
});

test("each subprocess re-reads the budget instead of inheriting a stale one", async () => {
  // Every spawn advances the clock past what is left. If any stage captured
  // its timeout once, the reviewer would still get a full budget after the
  // probe and the clone had already spent it.
  let now = 0;
  const { runner } = fakeRunner([
    { stdout: passing("agy") },
    { stdout: passing("codex") }
  ]);
  const execute = createReviewExecutor({
    targets: ["agy", "codex"],
    cwd: process.cwd(),
    runner: {
      start(request) {
        const running = runner.start(request);
        now += 200;
        return running;
      }
    },
    env: {},
    probeBind: async () => true,
    timeoutMs: 900_000,
    chainTimeoutMs: 500,
    now: () => now
  });

  const result = await execute(request());

  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.reason, "timeout");
});

test("an adversarial verdict that lands after the deadline is not accepted", async () => {
  let now = 0;
  let spawns = 0;
  const { runner } = fakeRunner([
    { stdout: passing("agy") },
    { stdout: passing("codex") }
  ]);
  const execute = createReviewExecutor({
    targets: ["agy", "codex"],
    cwd: process.cwd(),
    runner: {
      start(request) {
        const running = runner.start(request);
        if (!request.args.includes("--help")) {
          spawns += 1;
          // Only the last round overruns, so the chain reaches its verdict.
          now += spawns >= 4 ? 10_000 : 1;
        }
        return running;
      }
    },
    env: {},
    probeBind: async () => true,
    timeoutMs: 900_000,
    chainTimeoutMs: 5_000,
    now: () => now
  });

  const result = await execute(request());

  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.reason, "timeout");
  assert.ok(
    result.attempts?.some((attempt) => attempt.status === "PASS"),
    "the first round still happened"
  );
});

test("a preflight that outlasts the chain budget cannot spend the review's time", async () => {
  let now = 0;
  const budgets: number[] = [];
  const { runner } = fakeRunner([{ stdout: passing("agy") }]);
  const execute = createReviewExecutor({
    targets: ["agy", "codex"],
    cwd: process.cwd(),
    runner,
    env: {},
    probeBind: async () => true,
    timeoutMs: 900_000,
    chainTimeoutMs: 100,
    now: () => now,
    preflightTarget: async (_target, budget) => {
      budgets.push(budget?.timeoutMs ?? -1);
      // A slow probe: it outlasts the whole chain budget on its own.
      now += 150;
      return "ok";
    }
  });

  const result = await execute(request());

  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.reason, "timeout");
  assert.equal(budgets.length, 1, "the second preflight must not start");
  assert.ok(
    (budgets[0] ?? 0) <= 100,
    `the probe was given ${budgets[0]} ms of a 100 ms chain`
  );
  assert.equal(
    result.preflight?.at(-1)?.diagnostic,
    "the review deadline was reached during target preflight"
  );
});

test("budget spent during a stage stops the round naming the deadline", async () => {
  let now = 0;
  const { runner } = fakeRunner([{ stdout: passing("agy") }]);
  const execute = createReviewExecutor({
    targets: ["agy", "codex"],
    cwd: process.cwd(),
    runner: {
      start(request) {
        const running = runner.start(request);
        // The capability probe alone spends the whole chain budget.
        if (request.args.includes("--help")) {
          now += 5_000;
        }
        return running;
      }
    },
    env: {},
    probeBind: async () => true,
    timeoutMs: 900_000,
    chainTimeoutMs: 1_000,
    now: () => now
  });

  const result = await execute(request());

  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.reason, "timeout");
  assert.match(
    result.attempts?.[0]?.diagnostic ?? "",
    /review deadline was reached after the capability probe/,
    "an exhausted budget must not be reported as an unavailable reviewer"
  );
});

test("a probe cut short by the deadline is reported as time, not as a bad CLI", async () => {
  // The help probe hangs with no output. Its timeout is the chain's remaining
  // budget, so it fails exactly like a CLI whose flags are missing — the only
  // thing that distinguishes them is the deadline check.
  const execute = createReviewExecutor({
    targets: ["agy", "codex"],
    cwd: process.cwd(),
    runner: {
      start(): RunningVerificationProcess {
        let finish: ((value: {
          exitCode: number | null;
          signal: string | null;
        }) => void) | undefined;
        return {
          pid: 1,
          stdout: bytes(""),
          stderr: bytes(""),
          completion: new Promise((resolve) => {
            finish = resolve;
          }),
          terminateTree: async () => {
            finish?.({ exitCode: null, signal: "SIGTERM" });
          }
        };
      }
    },
    env: {},
    probeBind: async () => true,
    timeoutMs: 900_000,
    chainTimeoutMs: 200
  });

  const result = await execute(request());

  assert.equal(result.status, "NOT_RUN");
  assert.equal(result.reason, "timeout");
  assert.match(
    result.attempts?.[0]?.diagnostic ?? "",
    /review deadline was reached/,
    "an exhausted budget must not be reported as a capability problem"
  );
});
