import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runBatch } from "../../runtime/src/review/batch.js";
import { ReviewInterruptedError } from "../../runtime/src/review/execute.js";
import { withReviewSlot } from "../../runtime/src/review/slots.js";

const pause = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms));

async function directory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agent-ops-slots-"));
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
