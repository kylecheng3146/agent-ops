import type { UsageHighWater } from "./types.js";

function highWater(value: number | null, incoming: number | null): number | null {
  if (incoming === null) {
    return value;
  }
  return value === null ? incoming : Math.max(value, incoming);
}

/** Merge telemetry without allowing a resumed process to lower a prior high-water mark. */
export function recordUsage(
  usage: readonly UsageHighWater[],
  incoming: UsageHighWater
): UsageHighWater[] {
  const index = usage.findIndex((value) => value.source === incoming.source && value.epoch === incoming.epoch);
  if (index < 0) {
    return [...usage, incoming];
  }
  const previous = usage[index];
  const sameEpoch = previous.epoch === incoming.epoch;
  const merged: UsageHighWater = sameEpoch
    ? {
        ...incoming,
        inputTokens: highWater(previous.inputTokens, incoming.inputTokens),
        outputTokens: highWater(previous.outputTokens, incoming.outputTokens),
        totalTokens: highWater(previous.totalTokens, incoming.totalTokens),
        costUsd: highWater(previous.costUsd, incoming.costUsd),
        completeness:
          previous.completeness === "complete" || incoming.completeness === "complete"
            ? "complete"
            : previous.completeness === "partial" || incoming.completeness === "partial"
              ? "partial"
              : "unknown"
      }
    : incoming;
  return usage.map((value, currentIndex) => currentIndex === index ? merged : value);
}
