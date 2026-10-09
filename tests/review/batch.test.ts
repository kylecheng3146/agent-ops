import assert from "node:assert/strict";
import test from "node:test";

import {
  memoizePreflight,
  runBatch,
  TRANSIENT_REVIEW_REASONS,
  type BatchDependencies,
  type BatchReview
} from "../../runtime/src/review/batch.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const PASS: BatchReview = { status: "PASS" };

interface Fake {
  readonly deps: BatchDependencies;
  readonly events: string[];
  readonly calls: Map<string, number>;
  readonly peak: { review: number; verify: number };
}

function fake(options: {
  readonly fresh?: readonly string[];
  readonly verify?: (id: string) => "PASS" | "FAIL";
  readonly review?: (id: string, call: number, signal: AbortSignal) => Promise<BatchReview>;
  readonly guard?: () => boolean;
  readonly verifyMs?: number;
  readonly reviewMs?: number;
}): Fake {
  const events: string[] = [];
  const calls = new Map<string, number>();
  const peak = { review: 0, verify: 0 };
  let reviewing = 0;
  let verifying = 0;
  const deps: BatchDependencies = {
    isVerified: async (id) => options.fresh?.includes(id) === true,
    verify: async (id) => {
      verifying += 1;
      peak.verify = Math.max(peak.verify, verifying);
      events.push(`verify-start ${id}`);
      await sleep(options.verifyMs ?? 10);
      events.push(`verify-end ${id}`);
      verifying -= 1;
      return options.verify?.(id) ?? "PASS";
    },
    review: async (id, signal) => {
      const call = (calls.get(id) ?? 0) + 1;
      calls.set(id, call);
      reviewing += 1;
      peak.review = Math.max(peak.review, reviewing);
      events.push(`review-start ${id}#${call}`);
      try {
        if (options.review !== undefined) {
          return await options.review(id, call, signal);
        }
        await sleep(options.reviewMs ?? 10);
        return PASS;
      } finally {
        events.push(`review-end ${id}#${call}`);
        reviewing -= 1;
      }
    },
    guard: async () => options.guard?.() ?? true
  };
  return { deps, events, calls, peak };
}

test("width-cap: never more reviews at once than the width, and a freed slot is refilled", async () => {
  const f = fake({ fresh: ["a", "b", "c", "d", "e"], reviewMs: 15 });
  const outcomes = await runBatch(["a", "b", "c", "d", "e"], f.deps, { width: 2 });
  assert.equal(f.peak.review, 2);
  assert.deepEqual(outcomes.map((item) => item.review?.status), ["PASS", "PASS", "PASS", "PASS", "PASS"]);
  assert.ok(outcomes.every((item) => item.verify === "skipped" && !item.aborted && !item.retried));
  assert.ok(
    f.events.indexOf("review-start c#1") > f.events.indexOf("review-end a#1"),
    "c starts once a frees its slot"
  );
  await assert.rejects(runBatch(["a"], f.deps, { width: 0 }), /width/u);
});

test("verify-serial-pipeline: verifies never overlap, a review starts after its own verify, a failed verify gets no review", async () => {
  const f = fake({
    verify: (id) => (id === "b" ? "FAIL" : "PASS"),
    verifyMs: 20,
    reviewMs: 60
  });
  const outcomes = await runBatch(["a", "b", "c"], f.deps, { width: 3 });
  assert.equal(f.peak.verify, 1);
  assert.ok(f.events.indexOf("review-start a#1") > f.events.indexOf("verify-end a"));
  assert.ok(
    f.events.indexOf("review-start a#1") < f.events.indexOf("verify-end c"),
    "a's review overlaps the later verifies"
  );
  assert.equal(f.calls.get("b"), undefined);
  assert.deepEqual(outcomes.map((item) => [item.id, item.verify, item.review?.status ?? null, item.aborted]), [
    ["a", "PASS", "PASS", false],
    ["b", "FAIL", null, false],
    ["c", "PASS", "PASS", false]
  ]);
});

test("degrade-retry: a transient NOT_RUN drops width to 1 and retries once alone; other reasons are final", async () => {
  assert.ok(TRANSIENT_REVIEW_REASONS.has("probe-failed") && !TRANSIENT_REVIEW_REASONS.has("host-sandboxed"));
  const lines: string[] = [];
  const f = fake({
    fresh: ["a", "b", "c", "d"],
    review: async (id, call) => {
      if (id === "a") {
        await sleep(5);
        return call === 1 ? { status: "NOT_RUN", reason: "probe-failed" } : PASS;
      }
      await sleep(30);
      return id === "b" ? { status: "NOT_RUN", reason: "host-sandboxed" } : PASS;
    }
  });
  const outcomes = await runBatch(["a", "b", "c", "d"], f.deps, {
    width: 2,
    onProgress: (line) => lines.push(line)
  });
  assert.equal(f.calls.get("a"), 2);
  assert.equal(f.calls.get("b"), 1);
  const byId = new Map(outcomes.map((item) => [item.id, item]));
  assert.deepEqual(byId.get("a")?.review, PASS);
  assert.equal(byId.get("a")?.retried, true);
  assert.deepEqual(byId.get("b")?.review, { status: "NOT_RUN", reason: "host-sandboxed" });
  assert.equal(byId.get("b")?.retried, false);
  assert.ok(lines.some((line) => line.startsWith("degrade:")));
  const events = f.events;
  const startC = events.indexOf("review-start c#1");
  const endC = events.indexOf("review-end c#1");
  const startD = events.indexOf("review-start d#1");
  assert.ok(startD > endC && startC < endC, "after degrade, c and d run one at a time");
  assert.ok(events.indexOf("review-start a#2") > events.indexOf("review-end d#1"), "the retry runs last, alone");
});

test("degrade-retry: a second transient NOT_RUN is final, never a third attempt", async () => {
  const f = fake({
    fresh: ["a"],
    review: async () => ({ status: "NOT_RUN", reason: "stalled" })
  });
  const [outcome] = await runBatch(["a"], f.deps, { width: 2 });
  assert.equal(f.calls.get("a"), 2);
  assert.deepEqual(outcome?.review, { status: "NOT_RUN", reason: "stalled" });
  assert.equal(outcome?.retried, true);
  assert.equal(outcome?.aborted, false);
});

test("guard-abort: a changed source aborts in-flight reviews, starts nothing new, and marks the rest aborted", async () => {
  let guardCalls = 0;
  const f = fake({
    fresh: ["a", "b", "c"],
    // a and b start (guard calls 1 and 2); a finishes, and the check before c
    // (call 3) reports the change while b is still running.
    guard: () => ++guardCalls <= 2,
    review: (id, _call, signal) => new Promise((resolve) => {
      if (id === "a") {
        setTimeout(() => resolve(PASS), 5);
        return;
      }
      signal.addEventListener("abort", () => resolve({ status: "NOT_RUN", reason: "interrupted" }), { once: true });
    })
  });
  const lines: string[] = [];
  const outcomes = await runBatch(["a", "b", "c"], f.deps, { width: 2, onProgress: (line) => lines.push(line) });
  assert.equal(f.calls.get("c"), undefined, "no new review starts after the change");
  assert.ok(lines.some((line) => line.includes("source changed")));
  assert.deepEqual(outcomes.map((item) => [item.id, item.review?.status ?? null, item.aborted]), [
    ["a", "PASS", false],
    ["b", null, true],
    ["c", null, true]
  ]);
});

test("guard-abort: an interrupt from the caller aborts the batch too", async () => {
  const outer = new AbortController();
  const f = fake({
    fresh: ["a", "b"],
    review: (_id, _call, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ status: "NOT_RUN", reason: "interrupted" }), { once: true });
    })
  });
  const pending = runBatch(["a", "b"], f.deps, { width: 1, signal: outer.signal });
  await sleep(10);
  outer.abort();
  const outcomes = await pending;
  assert.ok(outcomes.every((item) => item.aborted));
  assert.equal(f.calls.get("b"), undefined);
});

test("preflight-memo: shares one in-flight probe, keeps only ok, probes again after a failure", async () => {
  let probes = 0;
  const answers: Array<string | { result: string }> = [{ result: "probe-failed" }, "ok", "ok"];
  const memo = memoizePreflight(async () => {
    await sleep(5);
    return answers[probes++] as never;
  });
  const [first, second] = await Promise.all([memo("agy"), memo("agy")]);
  assert.equal(probes, 1, "concurrent callers share one probe");
  assert.deepEqual(first, { result: "probe-failed" });
  assert.deepEqual(second, { result: "probe-failed" });
  assert.equal(await memo("agy"), "ok");
  assert.equal(probes, 2, "a failure is not cached");
  assert.equal(await memo("agy"), "ok");
  assert.equal(probes, 2, "a success is cached");
  await memo("claude");
  assert.equal(probes, 3, "targets are cached separately");
});

test("each verify and review reports its phase as it starts, the latest step last", async () => {
  const f = fake({ verifyMs: 5, reviewMs: 30 });
  const phases: string[] = [];
  const onPhase = (phase: "verifying" | "reviewing"): void => {
    phases.push(phase);
    f.events.push(`phase ${phase}`);
  };
  await runBatch(["a", "b"], f.deps, { width: 2, onPhase });
  assert.deepEqual(phases.filter((phase) => phase === "verifying").length, 2);
  assert.deepEqual(phases.filter((phase) => phase === "reviewing").length, 2);
  // Reported right as each step starts, so the newest step is the last report.
  f.events.forEach((event, index) => {
    if (event === "phase verifying") assert.match(f.events[index + 1] ?? "", /^verify-start /u);
    if (event === "phase reviewing") assert.match(f.events[index + 1] ?? "", /^review-start /u);
  });
});

test("a failing phase report never fails the batch", async () => {
  const f = fake({ fresh: ["a"] });
  const outcomes = await runBatch(["a"], f.deps, { width: 1, onPhase: () => { throw new Error("office down"); } });
  assert.equal(outcomes[0]?.review?.status, "PASS");
});
