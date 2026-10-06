import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runBatch } from "../../runtime/src/review/batch.js";
import { ReviewInterruptedError } from "../../runtime/src/review/execute.js";
import { withReviewSlot } from "../../runtime/src/review/slots.js";
import {withFinishLock} from "../../runtime/src/parallel/finish.js";
import {deps} from "../worktree/fixture.js";

const pause = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms));

async function directory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agent-ops-slots-"));
}

for (const kind of ["review", "finish"] as const) {
  test(`${kind} release cannot remove a replacement holder after lease expiry`, async () => {
    const dir = await directory();
    const path = join(dir, kind === "review" ? "agent-ops-review-slot-0.lock" : "agent-ops-finish.lock");
    const run = async (action: () => Promise<void>) => kind === "review"
      ? await withReviewSlot({dir, width: 1, pollMs: 5}, action)
      : await withFinishLock({...deps(), tasks: () => {throw new Error("Unused task service");}, sleep: pause}, dir, action);
    let startedFirst!: () => void, startedSecond!: () => void;
    let releaseFirst!: () => void, releaseSecond!: () => void;
    const firstStarted = new Promise<void>(resolve => {startedFirst = resolve;});
    const secondStarted = new Promise<void>(resolve => {startedSecond = resolve;});
    const firstReleased = new Promise<void>(resolve => {releaseFirst = resolve;});
    const secondReleased = new Promise<void>(resolve => {releaseSecond = resolve;});
    const first = run(async () => {startedFirst(); await firstReleased;});
    let second: Promise<void> | undefined;
    try {
      await firstStarted;
      const previous = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
      await writeFile(join(path, "owner.json"), JSON.stringify({...previous, at: Date.now() - 3 * 60 * 60 * 1000}));
      second = run(async () => {startedSecond(); await secondReleased;});
      await secondStarted;
      releaseFirst();
      await first;
      const replacement = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
      assert.equal(typeof replacement.token, "string");
      assert.notEqual(replacement.token, previous.token);
      releaseSecond();
      await second;
      await assert.rejects(readFile(join(path, "owner.json")), {code: "ENOENT"});
    } finally {
      releaseFirst(); releaseSecond();
      await Promise.allSettled([first, second]);
      await rm(dir, {recursive: true, force: true});
    }
  });
}

test("reviews across callers never exceed the width, and every waiter eventually runs", async () => {
  const dir = await directory();
  try {
    let running = 0;
    let peak = 0;
    const completed: number[] = [];
    await Promise.all([1, 2, 3, 4, 5].map(async (id) =>
      await withReviewSlot({ dir, width: 2, pollMs: 5 }, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await pause(30);
        running -= 1;
        completed.push(id);
      })
    ));
    assert.equal(peak, 2);
    assert.deepEqual(completed.sort(), [1, 2, 3, 4, 5]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a slot held by a dead process or an expired holder is reclaimed", async () => {
  const dir = await directory();
  try {
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    const slot = join(dir, "agent-ops-review-slot-0.lock");
    await mkdir(slot);
    await writeFile(join(slot, "owner.json"), JSON.stringify({ pid: Number(dead.stdout), at: Date.now() }));
    assert.equal(await withReviewSlot({ dir, width: 1, pollMs: 5 }, async () => "after-dead"), "after-dead");

    await mkdir(slot);
    await writeFile(join(slot, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() - 10_000 }));
    assert.equal(await withReviewSlot({ dir, width: 1, pollMs: 5, staleMs: 1000 }, async () => "after-expired"), "after-expired");

    // A live, fresh holder is not reclaimed: the waiter is interrupted instead.
    await mkdir(slot);
    await writeFile(join(slot, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    const abort = new AbortController();
    const waiting = withReviewSlot({ dir, width: 1, pollMs: 5, signal: abort.signal }, async () => "never");
    setTimeout(() => abort.abort("SIGINT"), 30);
    await assert.rejects(waiting, ReviewInterruptedError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a batch that shares the limit with another holder finishes without deadlock", async () => {
  const dir = await directory();
  try {
    let running = 0;
    let peak = 0;
    const outsider = withReviewSlot({ dir, width: 2, pollMs: 5 }, async () => await pause(60));
    const outcomes = await runBatch(["a", "b", "c"], {
      isVerified: async () => true,
      verify: async () => "PASS",
      guard: async () => true,
      review: async () => await withReviewSlot({ dir, width: 2, pollMs: 5 }, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await pause(20);
        running -= 1;
        return { status: "PASS" as const };
      })
    }, { width: 2 });
    await outsider;
    assert.deepEqual(outcomes.map(({ review }) => review?.status), ["PASS", "PASS", "PASS"]);
    assert.ok(peak <= 2, `peak ${String(peak)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
