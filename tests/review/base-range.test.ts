import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ReviewTargetId } from "../../runtime/src/contracts.js";
import { createReviewExecutor } from "../../runtime/src/review/execute.js";
import { buildReviewPrompt } from "../../runtime/src/review/runner.js";
import { resolveReviewScope, type ReviewScope } from "../../runtime/src/review/scope.js";
import type { ReviewExecutionRequest } from "../../runtime/src/review/runner.js";
import type {
  ProcessRequest,
  RunningVerificationProcess,
  VerificationProcessRunner
} from "../../runtime/src/verify/spawn.js";
import { NodeVerificationProcessRunner } from "../../runtime/src/verify/spawn.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Three commits, so a base of the first is more than `HEAD~1`. */
async function threeCommitRepository(): Promise<{
  readonly root: string;
  readonly base: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-base-range-"));
  git(root, "init", "--quiet", "--initial-branch", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  await writeFile(join(root, "kept.txt"), "one\n");
  await writeFile(join(root, "removed.txt"), "doomed\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "first");
  const base = git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "kept.txt"), "two\n");
  await writeFile(join(root, "added.txt"), "new\n");
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "second");
  git(root, "rm", "--quiet", "removed.txt");
  git(root, "commit", "--quiet", "-m", "third");
  return { root, base };
}

function envelope(
  target: ReviewTargetId,
  changedFiles: readonly string[]
): string {
  const payload = JSON.stringify({
    summary: "Review complete.",
    results: [{
      criterionId: "tests",
      status: "PASS",
      summary: "Tests pass.",
      evidence: ["npm test"]
    }],
    findings: [],
    residualRisks: [],
    changedFilesInspected: [...changedFiles],
    supportingFilesInspected: []
  });
  return target === "codex"
    ? payload
    : JSON.stringify({ structured_output: JSON.parse(payload) });
}

function bytes(value: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(value);
    }
  };
}

interface Seen {
  readonly prompt: string;
  /** What the instructed range diff actually produces inside the snapshot. */
  readonly rangeDiff: string;
  readonly ordinaryDiff: string;
}

/**
 * Real Git, fake reviewers. The snapshot has to be a genuine clone for this to
 * prove anything: the defect being guarded against is that a clone of HEAD
 * shows an empty ordinary diff for an already-committed range.
 */
function hybridRunner(
  base: string,
  changedFiles: readonly string[],
  seen: Seen[]
): VerificationProcessRunner {
  const real = new NodeVerificationProcessRunner();
  const help = [
    "--add-dir", "--permission-mode", "--no-session-persistence",
    "--safe-mode", "--disable-slash-commands", "--json-schema", "--sandbox",
    "--mode", "--cd", "--ephemeral", "--ignore-user-config", "--ignore-rules",
    "--output-schema", "--log-file"
  ].join(" ");
  return {
    start(request: ProcessRequest): RunningVerificationProcess {
      if (request.command === "git") {
        return real.start(request);
      }
      if (request.args.includes("--help")) {
        const stream = bytes(help);
        return {
          pid: null,
          stdout: request.command === "agy" ? bytes("") : stream,
          stderr: request.command === "agy" ? stream : bytes(""),
          completion: Promise.resolve({ exitCode: 0, signal: null }),
          async terminateTree() {}
        };
      }
      // Targets differ: some carry the prompt in argv, some on stdin.
      const prompt = `${request.args.join(" ")}\n${request.stdin ?? ""}`;
      seen.push({
        prompt,
        rangeDiff: git(request.cwd, "diff", "--name-status", base, "HEAD"),
        ordinaryDiff: git(request.cwd, "diff", "--name-status")
      });
      return {
        pid: null,
        stdout: bytes(
          envelope(request.command as ReviewTargetId, changedFiles)
        ),
        stderr: bytes(""),
        completion: Promise.resolve({ exitCode: 0, signal: null }),
        async terminateTree() {}
      };
    }
  };
}

async function baseScope(root: string, base: string): Promise<ReviewScope> {
  return resolveReviewScope({
    root,
    base,
    runner: {
      async run(args: readonly string[]) {
        try {
          // Raw bytes: the change surface parses NUL-delimited paths, so a
          // trimmed string would be rejected before the scope is built.
          return {
            stdout: execFileSync("git", [...args], { cwd: root }),
            exitCode: 0
          };
        } catch {
          return { stdout: Buffer.from(""), exitCode: 1 };
        }
      }
    }
  });
}

function executionRequest(scope: ReviewScope): ReviewExecutionRequest {
  return {
    readOnly: true,
    invocation: {
      harness: "claude" as const,
      model: "configured",
      effort: "configured",
      scope,
      packet: {
        request: "Review the requested implementation.",
        criteria: [{ id: "tests", description: "The test suite passes." }],
        artifactRefs: [],
        evidenceRequirements: []
      }
    }
  };
}

test("both reviewers receive the resolved base and can diff the whole range", async () => {
  const { root, base } = await threeCommitRepository();
  try {
    const scope = await baseScope(root, base);
    assert.equal(scope.mode, "base");
    const seen: Seen[] = [];
    const progress: string[] = [];
    const execute = createReviewExecutor({
      targets: ["agy", "codex"],
      cwd: root,
      runner: hybridRunner(base, scope.changedFiles, seen),
      env: {},
      probeBind: async () => true,
      timeoutMs: 120_000,
      onProgress: (line) => progress.push(line)
    });
    const result = await execute(executionRequest(scope));

    assert.equal(result.status, "PASS", progress.join(" | "));
    assert.equal(seen.length, 2, "both rounds must run");
    for (const attempt of seen) {
      assert.match(attempt.prompt, new RegExp(base), "prompt lacks the base SHA");
      assert.ok(
        attempt.prompt.includes(`git diff ${base} HEAD --`),
        "prompt lacks the range diff instruction"
      );
      // The defect this guards: without the range, this is all a reviewer sees.
      assert.equal(attempt.ordinaryDiff, "", "the snapshot worktree is clean");
      const range = attempt.rangeDiff.split("\n").sort();
      assert.deepEqual(range, [
        "A\tadded.txt",
        "D\tremoved.txt",
        "M\tkept.txt"
      ], "the range must cover more than the last commit");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a base commit missing from the snapshot ends the chain as NOT_RUN", async () => {
  const { root, base } = await threeCommitRepository();
  try {
    const scope = await baseScope(root, base);
    const absent = "0".repeat(40);
    const seen: Seen[] = [];
    const execute = createReviewExecutor({
      targets: ["agy", "codex"],
      cwd: root,
      runner: hybridRunner(base, scope.changedFiles, seen),
      env: {},
      probeBind: async () => true,
      timeoutMs: 120_000
    });
    const result = await execute(
      executionRequest({ ...scope, resolvedBase: absent } as ReviewScope)
    );

    assert.equal(result.status, "NOT_RUN");
    assert.equal(seen.length, 0, "no reviewer may run without the base");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The instruction is text a reviewer pastes into a shell, so the only honest
 * check is to run it there. A double-quoted `$name` would expand and select a
 * different path, which reads as an empty diff rather than as an error.
 */
test("the instructed diff survives shell-hostile filenames", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-base-quote-"));
  try {
    git(root, "init", "--quiet", "--initial-branch", "main");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Test");
    await writeFile(join(root, "plain.txt"), "one\n");
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "first");
    const base = git(root, "rev-parse", "HEAD");
    const hostile = [
      "dollar$AGENT_OPS_UNSET.txt",
      "back`tick`.txt",
      "quote'name.txt"
    ];
    for (const name of hostile) {
      await writeFile(join(root, name), "payload\n");
    }
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "second");

    const prompt = buildReviewPrompt({
      harness: "codex",
      model: "configured",
      effort: "configured",
      scope: {
        mode: "base",
        baseRef: "HEAD~1",
        resolvedBase: base,
        changedFiles: hostile
      },
      packet: {
        request: "Review.",
        criteria: [{ id: "tests", description: "Tests pass." }],
        artifactRefs: [],
        evidenceRequirements: []
      }
    });
    const command = prompt
      .split("\n")
      .find((line) => line.startsWith("git diff "));
    assert.ok(command, "the prompt must carry a runnable diff command");

    // Run it verbatim: appending a flag after the paths would make it a
    // pathspec and quietly change what is being tested.
    const output = execFileSync("sh", ["-c", command], {
      cwd: root,
      encoding: "utf8"
    });
    assert.deepEqual(
      output
        .split("\n")
        .filter((line) => line.startsWith("+++ b/"))
        .sort(),
      hostile.map((name) => `+++ b/${name}`).sort(),
      "every hostile filename must reach git as an exact argument"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
