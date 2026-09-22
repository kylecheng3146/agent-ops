import type { ReviewTargetId } from "../contracts.js";

/**
 * What one reviewer round cost, as the target itself reported it. Every field
 * is optional: a target that reports nothing yields nothing, because an
 * invented number is worse than a missing one when the point of the record is
 * to decide whether review is expensive.
 */
export interface ReviewUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-negative finite number, or nothing. Strings are not coerced. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function present(usage: ReviewUsage): ReviewUsage | undefined {
  return Object.values(usage).some((value) => value !== undefined)
    ? usage
    : undefined;
}

function defined<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value } as Record<string, T>;
}

/**
 * codex prints a token total to stderr and nothing to stdout but the answer.
 * The last occurrence wins: the same line is reprinted as the run progresses.
 */
function codexUsage(stderr: string): ReviewUsage | undefined {
  const matches = [...stderr.matchAll(/tokens used[\s:]*([\d,]+)/giu)];
  const last = matches[matches.length - 1]?.[1];
  if (last === undefined) {
    return undefined;
  }
  const total = Number.parseInt(last.replaceAll(",", ""), 10);
  return Number.isFinite(total) ? { totalTokens: total } : undefined;
}

/**
 * The numbers a target already publishes in its own transport envelope. This
 * reads nothing else: prompts, model text and repository content never enter
 * the record, only counts.
 */
export function extractUsage(
  target: ReviewTargetId,
  stdout: string,
  stderr: string
): ReviewUsage | undefined {
  if (target === "codex") {
    return codexUsage(stderr);
  }
  const envelope = parseObject(stdout);
  const usage = envelope?.usage;
  if (!isRecord(usage)) {
    return undefined;
  }
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const cacheRead = count(usage.cache_read_tokens) ??
    count(usage.cache_read_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const total = count(usage.total_tokens) ??
    (input === undefined && output === undefined
      ? undefined
      : (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0));
  return present({
    ...defined("inputTokens", input),
    ...defined("outputTokens", output),
    ...defined("cacheReadTokens", cacheRead),
    ...defined("cacheWriteTokens", cacheWrite),
    ...defined("totalTokens", total),
    ...defined("costUsd", count(envelope?.total_cost_usd))
  });
}
