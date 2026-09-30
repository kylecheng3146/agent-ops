import { AgentOpsError } from "../fs/paths.js";
import type { ReviewExecutorOptions } from "./execute.js";

/**
 * NOT_RUN reasons that mean the reviewer was briefly unavailable. Anything
 * else (a sandboxed host, stale verification, a changed policy) fails the same
 * way on a second attempt, so it is reported instead of retried.
 */
export const TRANSIENT_REVIEW_REASONS: ReadonlySet<string> = new Set([
  "probe-failed",
  "stalled",
  "timeout",
  "quota-exhausted",
  "network-unreachable"
]);

/** Reviews allowed at once when the caller names no width. */
export const DEFAULT_BATCH_WIDTH = 2;

export type BatchVerifyStatus = "skipped" | "PASS" | "FAIL" | "not-run";

export interface BatchReview {
  readonly status: "PASS" | "FAIL" | "NOT_RUN";
  readonly reason?: string;
  /** Served from the attestation already recorded for this source. */
  readonly reused?: true;
}

export interface BatchTaskOutcome {
  readonly id: string;
  readonly verify: BatchVerifyStatus;
  readonly review: BatchReview | null;
  /** The one lone retry after a transient NOT_RUN was attempted. */
  readonly retried: boolean;
  /** Stopped because the source changed or the caller interrupted. */
  readonly aborted: boolean;
}

export interface BatchDependencies {
  /** True when the task already has fresh PASS verification evidence. */
  isVerified(id: string): Promise<boolean>;
  verify(id: string, signal: AbortSignal): Promise<"PASS" | "FAIL">;
  review(id: string, signal: AbortSignal): Promise<BatchReview>;
  /** False once HEAD or the working tree is no longer what the batch started on. */
  guard(): Promise<boolean>;
}

export interface BatchOptions {
  readonly width: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (line: string) => void;
}

interface Slot {
  id: string;
  verify: BatchVerifyStatus;
  review: BatchReview | null;
  retried: boolean;
}

/**
 * Verify runs one task at a time (a full test run per task; several at once
 * starve each other of CPU and fake a failure). Each task's review starts as
 * soon as its own verify has passed, so the next verify overlaps it. Reviews
 * run up to `width` at a time; a transient NOT_RUN drops the width to 1 for
 * good and that task gets one more try alone after everything else finished.
 */
export async function runBatch(
  ids: readonly string[],
  deps: BatchDependencies,
  options: BatchOptions
): Promise<BatchTaskOutcome[]> {
  if (!Number.isInteger(options.width) || options.width < 1) {
    throw new AgentOpsError("BATCH_INVALID_WIDTH", "Batch width must be a positive integer.");
  }
  const progress = options.onProgress ?? (() => {});
  const controller = new AbortController();
  const outer = options.signal;
  if (outer?.aborted === true) {
    controller.abort();
  } else {
    outer?.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const slots = new Map<string, Slot>(ids.map((id) => [
    id,
    { id, verify: "not-run", review: null, retried: false }
  ]));
  const slot = (id: string): Slot => slots.get(id)!;
  const stop = (why: string): void => {
    if (!controller.signal.aborted) {
      progress(why);
      controller.abort();
    }
  };
  const guard = async (): Promise<boolean> => {
    try {
      return await deps.guard();
    } catch {
      return false;
    }
  };

  let width = options.width;
  let running = 0;
  let verifying = true;
  const ready: string[] = [];
  const retry: string[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const review = async (id: string, final: boolean): Promise<void> => {
    if (!await guard()) {
      stop("source changed; aborting the batch");
      return;
    }
    const entry = slot(id);
    if (final) {
      entry.retried = true;
    }
    let result: BatchReview;
    try {
      result = await deps.review(id, controller.signal);
    } catch (error) {
      progress(`review ${id} failed to run: ${error instanceof Error ? error.message : String(error)}`);
      result = { status: "NOT_RUN", reason: "review-error" };
    }
    if (controller.signal.aborted) {
      return;
    }
    entry.review = result;
    if (
      !final &&
      result.status === "NOT_RUN" &&
      result.reason !== undefined &&
      TRANSIENT_REVIEW_REASONS.has(result.reason)
    ) {
      if (width > 1) {
        width = 1;
        progress(`degrade: review width -> 1 (${id}: ${result.reason})`);
      }
      retry.push(id);
    }
  };

  const pump = (): void => {
    while (!controller.signal.aborted && running < width && ready.length > 0) {
      const id = ready.shift()!;
      running += 1;
      void review(id, false).finally(() => {
        running -= 1;
        pump();
      });
    }
    if (!verifying && running === 0 && (ready.length === 0 || controller.signal.aborted)) {
      finish();
    }
  };

  const fresh = await Promise.all(ids.map((id) => deps.isVerified(id).catch(() => false)));
  const stale: string[] = [];
  ids.forEach((id, index) => {
    if (fresh[index] === true) {
      slot(id).verify = "skipped";
      ready.push(id);
    } else {
      stale.push(id);
    }
  });

  const verifyAll = async (): Promise<void> => {
    for (const id of stale) {
      if (controller.signal.aborted) {
        break;
      }
      if (!await guard()) {
        stop("source changed; aborting the batch");
        break;
      }
      let status: "PASS" | "FAIL";
      try {
        status = await deps.verify(id, controller.signal);
      } catch (error) {
        progress(`verify ${id} failed to run: ${error instanceof Error ? error.message : String(error)}`);
        status = "FAIL";
      }
      if (controller.signal.aborted) {
        break;
      }
      slot(id).verify = status;
      if (status === "PASS") {
        ready.push(id);
        pump();
      }
    }
    verifying = false;
    pump();
  };

  void verifyAll();
  pump();
  await done;

  if (!controller.signal.aborted) {
    for (const id of retry) {
      if (controller.signal.aborted) {
        break;
      }
      await review(id, true);
    }
  }

  const interrupted = controller.signal.aborted;
  return ids.map((id): BatchTaskOutcome => {
    const entry = slot(id);
    const pendingRetry = retry.includes(id) && !entry.retried;
    const unfinished = entry.review === null
      ? entry.verify !== "FAIL"
      : pendingRetry;
    return {
      id,
      verify: entry.verify,
      review: entry.review,
      retried: entry.retried,
      aborted: interrupted && unfinished
    };
  });
}

type Preflight = NonNullable<ReviewExecutorOptions["preflightTarget"]>;

/**
 * One probe per target for a whole batch. Concurrent callers share the probe
 * in flight and a success is kept, but a failure is forgotten so the retry of
 * a task re-probes instead of inheriting the failure.
 */
export function memoizePreflight(probe: Preflight): Preflight {
  const cache = new Map<string, ReturnType<Preflight>>();
  return (target, budget) => {
    const cached = cache.get(target);
    if (cached !== undefined) {
      return cached;
    }
    const pending = probe(target, budget);
    cache.set(target, pending);
    const forget = (): void => {
      if (cache.get(target) === pending) {
        cache.delete(target);
      }
    };
    pending.then(
      (answer) => {
        if ((typeof answer === "string" ? answer : answer.result) !== "ok") {
          forget();
        }
      },
      forget
    );
    return pending;
  };
}
