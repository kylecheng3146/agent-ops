import assert from "node:assert/strict";
import test from "node:test";
import {recordUsage} from "../../runtime/src/run/budget.js";
import type {UsageHighWater} from "../../runtime/src/run/types.js";

test("usage keeps per-epoch high water marks and preserves previous resume epochs", () => {
  const first: UsageHighWater = {
    source: "claude",
    epoch: "process-1",
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    costUsd: 0.1,
    completeness: "partial",
    observedAt: "2026-10-04T00:00:00Z"
  };
  const lowered: UsageHighWater = { ...first, inputTokens: 1, outputTokens: 2, totalTokens: 3 };
  const resumed: UsageHighWater = { ...first, epoch: "process-2", totalTokens: 4, completeness: "complete" };
  const merged = recordUsage(recordUsage([], first), lowered);
  assert.equal(merged[0]?.totalTokens, 15);
  const epochs = recordUsage(merged, resumed);
  assert.equal(epochs[0]?.epoch, "process-1");
  assert.equal(epochs[0]?.totalTokens, 15);
  assert.equal(epochs[1]?.totalTokens, 4);
  assert.equal(epochs.reduce((sum, item) => sum + (item.totalTokens ?? 0), 0), 19);
});
