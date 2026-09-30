import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { runCli, type CliIo } from "../../packages/cli/src/cli.js";
import { runBatchCommand, type BatchCommandOptions } from "../../packages/cli/src/commands/batch.js";
import { createSourceGuard } from "../../runtime/src/review/batch-guard.js";
import { DEFAULT_BATCH_WIDTH, type BatchReview } from "../../runtime/src/review/batch.js";
import type { StoredTaskRecord } from "../../runtime/src/task/store.js";
import type { GitRunner } from "../../runtime/src/verify/change-surface.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function record(
  id: string,
  options: { readonly parent?: string; readonly status?: StoredTaskRecord["status"]; readonly reviewBase?: string; readonly createdAt?: string } = {}
): StoredTaskRecord {
  return {
    task: { schemaVersion: 1, id, title: `title of ${id}`, criteria: [], ...(options.parent === undefined ? {} : { parentTaskId: options.parent }) },
    status: options.status ?? "active",
    evidence: {},
    createdAt: options.createdAt ?? "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    failureFingerprint: null,
    policyConfigHash: null,
    completionBase: null,
    ...(options.reviewBase === undefined ? {} : { reviewBase: options.reviewBase })
  } as unknown as StoredTaskRecord;
}

const RECORDS = [
  record("p", { createdAt: "2026-09-30T01:00:00.000Z" }),
  record("a", { parent: "p", createdAt: "2026-09-30T02:00:00.000Z", reviewBase: "recorded-a" }),
  record("b", { parent: "p", createdAt: "2026-09-30T03:00:00.000Z" }),
  record("gone", { parent: "p", status: "archived" })
];

interface Calls {
  readonly verified: string[];
  readonly verifies: string[];
  readonly reviews: Array<[string, string]>;
  peak: number;
}

function options(
  argv: string[],
  overrides: Omit<Partial<BatchCommandOptions>, "verify" | "review"> & {
    readonly fresh?: readonly string[];
    readonly verify?: (id: string) => "PASS" | "FAIL";
    readonly review?: (id: string) => BatchReview;
  } = {}
): { readonly options: BatchCommandOptions; readonly calls: Calls } {
  const { fresh, verify, review, ...rest } = overrides;
  const calls: Calls = { verified: [], verifies: [], reviews: [], peak: 0 };
  let running = 0;
  return {
    calls,
    options: {
      args: parseArgs(argv),
      tasks: { list: async () => RECORDS },
      worktreeBase: "worktree-base",
      guard: async () => true,
      isVerified: async (id) => {
        calls.verified.push(id);
        return fresh?.includes(id) === true;
      },
      verify: async (id) => {
        calls.verifies.push(id);
        await sleep(5);
        return verify?.(id) ?? "PASS";
      },
      review: async (id, base) => {
        calls.reviews.push([id, base]);
        running += 1;
        calls.peak = Math.max(calls.peak, running);
        await sleep(25);
        running -= 1;
        return review?.(id) ?? { status: "PASS" };
      },
      ...rest
    }
  };
}

test("batch-wiring: selects the tree, resolves bases, skips fresh verify and reviews each task on its own base at width 2", async () => {
  assert.equal(DEFAULT_BATCH_WIDTH, 2);
  const { options: opts, calls } = options(
    ["batch", "--parent", "p", "--yes", "--base", "flag-base"],
    { fresh: ["a"] }
  );
  const envelope = await runBatchCommand(opts);
  assert.equal(envelope.code, "BATCH_RESULT");
  assert.deepEqual(envelope.data?.tasks.map((task) => task.taskId), ["a", "b", "p"]);
  assert.deepEqual(calls.verified.sort(), ["a", "b", "p"]);
  assert.deepEqual(calls.verifies, ["b", "p"], "a already has fresh evidence");
  assert.deepEqual(Object.fromEntries(calls.reviews), {
    a: "flag-base",
    b: "flag-base",
    p: "worktree-base"
  });
  assert.equal(calls.peak, 2, "the default width is 2");
  assert.deepEqual(
    envelope.data?.tasks.map((task) => [task.taskId, task.base, task.baseSource, task.verify]),
    [
      ["a", "flag-base", "flag", "skipped"],
      ["b", "flag-base", "flag", "PASS"],
      ["p", "worktree-base", "worktree", "PASS"]
    ]
  );
  assert.equal(envelope.data?.width, 2);
});

test("batch-wiring: --parent-base reaches only the parent, a recorded base beats the worktree base, --width is honored", async () => {
  const { options: opts, calls } = options(
    ["batch", "--parent", "p", "--yes", "--parent-base", "pb", "--width", "1"],
    { fresh: ["a", "b", "p"] }
  );
  const envelope = await runBatchCommand(opts);
  assert.deepEqual(Object.fromEntries(calls.reviews), { a: "recorded-a", b: "worktree-base", p: "pb" });
  assert.equal(calls.peak, 1);
  assert.deepEqual(envelope.data?.tasks.map((task) => task.baseSource), ["recorded", "worktree", "flag"]);
});

test("batch-envelope: the code follows the worst outcome and every task is described", async () => {
  const ok = await runBatchCommand(options(["batch", "--parent", "p", "--yes"]).options);
  assert.deepEqual([ok.code, ok.status], ["BATCH_RESULT", "ok"]);
  assert.deepEqual(Object.keys(ok.data?.tasks[0] ?? {}).sort(), [
    "aborted", "base", "baseSource", "retried", "review", "taskId", "title", "verify"
  ]);

  const verifyFailed = await runBatchCommand(options(["batch", "--parent", "p", "--yes"], {
    verify: (id) => (id === "b" ? "FAIL" : "PASS")
  }).options);
  assert.equal(verifyFailed.code, "BATCH_FAILED");
  const failedTask = verifyFailed.data?.tasks.find((task) => task.taskId === "b");
  assert.deepEqual([failedTask?.verify, failedTask?.review], ["FAIL", null]);
  assert.match(verifyFailed.data?.text ?? "", /no review \(verify failed\)/u);

  const notRun = await runBatchCommand(options(["batch", "--parent", "p", "--yes"], {
    review: (id) => (id === "a" ? { status: "NOT_RUN", reason: "host-sandboxed" } : { status: "PASS" })
  }).options);
  assert.equal(notRun.code, "BATCH_NOT_RUN");
  assert.equal(notRun.status, "error");
  assert.match(notRun.data?.text ?? "", /NOT_RUN host-sandboxed/u);

  const both = await runBatchCommand(options(["batch", "--parent", "p", "--yes"], {
    review: (id) => (id === "a"
      ? { status: "NOT_RUN", reason: "host-sandboxed" }
      : id === "b" ? { status: "FAIL" } : { status: "PASS" })
  }).options);
  assert.equal(both.code, "BATCH_FAILED", "a defect is not hidden behind a NOT_RUN");

  const reused = await runBatchCommand(options(["batch", "--parent", "p", "--yes"], {
    fresh: ["a", "b", "p"],
    review: () => ({ status: "PASS", reused: true })
  }).options);
  assert.ok(reused.data?.tasks.every((task) => task.review?.reused === true));
});

test("batch-envelope: the CLI exits 0, 1 or 2, and --output still writes the envelope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-ops-batch-"));
  try {
    const cases: Array<[string, number]> = [["BATCH_RESULT", 0], ["BATCH_FAILED", 1], ["BATCH_NOT_RUN", 2]];
    for (const [code, exit] of cases) {
      const file = join(directory, `${code}.json`);
      const out: string[] = [];
      const io: CliIo = { isTTY: false, writeStdout: (value) => out.push(value), writeStderr: (value) => out.push(value) };
      const actual = await runCli(["batch", "--parent", "p", "--yes", "--output", file], io, {
        version: "0.0.0-test",
        execute: async () => code === "BATCH_RESULT"
          ? { code, status: "ok", data: { tasks: [] }, errors: [] }
          : { code, status: "error", data: { tasks: [] }, errors: [{ code, message: code }] }
      });
      assert.equal(actual, exit, code);
      assert.equal((JSON.parse(await readFile(file, "utf8")) as { code: string }).code, code);
      assert.match(out.join(""), new RegExp(`${code}.*envelope written to`, "u"));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch-guard: a dirty tree is refused before anything runs", async () => {
  const { options: opts, calls } = options(["batch", "--parent", "p", "--yes"], { guard: async () => false });
  const envelope = await runBatchCommand(opts);
  assert.equal(envelope.code, "BATCH_DIRTY_WORKTREE");
  assert.equal(envelope.status, "error");
  assert.deepEqual([calls.verified, calls.verifies, calls.reviews], [[], [], []]);
});

test("batch-guard: a change while it runs, or an interrupt, aborts the unfinished tasks", async () => {
  let checks = 0;
  const changed = options(["batch", "--parent", "p", "--yes", "--width", "1"], {
    fresh: ["a", "b", "p"],
    guard: async () => ++checks <= 2 // the start check and the first review pass; then HEAD moves
  });
  const envelope = await runBatchCommand(changed.options);
  assert.equal(envelope.code, "BATCH_NOT_RUN");
  assert.equal(changed.calls.reviews.length, 1);
  assert.deepEqual(envelope.data?.tasks.map((task) => task.aborted), [false, true, true]);
  assert.match(envelope.data?.text ?? "", /aborted/u);

  const controller = new AbortController();
  const interrupted = options(["batch", "--parent", "p", "--yes", "--width", "1"], {
    fresh: ["a", "b", "p"],
    signal: controller.signal
  });
  const pending = runBatchCommand(interrupted.options);
  await sleep(10);
  controller.abort();
  const result = await pending;
  assert.equal(result.code, "BATCH_NOT_RUN");
  assert.ok(result.data?.tasks.every((task) => task.aborted));
});

test("batch-guard: createSourceGuard holds only while HEAD and the tree are unchanged", async () => {
  let head = "a".repeat(40);
  let dirty = false;
  const runner: GitRunner = {
    run: async (args) => ({
      exitCode: 0,
      stdout: args[0] === "rev-parse"
        ? Buffer.from(`${head}\n`)
        : dirty && args[0] === "diff" && args[1] === "--cached"
          ? Buffer.from("src/x.ts\0")
          : new Uint8Array()
    })
  };
  const guard = await createSourceGuard(runner);
  assert.equal(await guard(), true);
  dirty = true;
  assert.equal(await guard(), false, "an uncommitted change");
  dirty = false;
  assert.equal(await guard(), true);
  head = "b".repeat(40);
  assert.equal(await guard(), false, "HEAD moved");
  dirty = true;
  assert.equal(await (await createSourceGuard(runner))(), false, "starting dirty is refused at once");
});
