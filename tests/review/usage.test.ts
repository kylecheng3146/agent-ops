import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { extractUsage } from "../../runtime/src/review/usage.js";

async function fixture(name: string): Promise<string> {
  return readFile(resolve("tests/fixtures/review", name), "utf8");
}

test("claude usage comes from its own envelope, cache counts included", async () => {
  const usage = extractUsage("claude", await fixture("claude-stdout.txt"), "");

  assert.ok(usage, "claude publishes usage and it must be read");
  assert.equal(usage.inputTokens, 2);
  assert.equal(usage.outputTokens, 4);
  assert.equal(usage.cacheReadTokens, 16_446);
  assert.equal(usage.cacheWriteTokens, 18_892);
  assert.equal(usage.totalTokens, 2 + 4 + 16_446 + 18_892);
  assert.equal(usage.costUsd, 0.19725299999999998);
});

test("agy usage comes from its own envelope and reports its own total", async () => {
  const usage = extractUsage("agy", await fixture("agy-stdout.txt"), "");

  assert.ok(usage);
  assert.equal(usage.inputTokens, 45_738);
  assert.equal(usage.outputTokens, 1_414);
  assert.equal(usage.totalTokens, 47_152);
  assert.equal(usage.costUsd, undefined);
});

test("codex usage is read from stderr, taking the last total it printed", () => {
  const usage = extractUsage(
    "codex",
    "{}",
    "tokens used\n1,200\nworking\ntokens used\n7,858\n"
  );

  assert.deepEqual(usage, { totalTokens: 7_858 });
});

test("a target that reports no usage yields nothing rather than a guess", async () => {
  assert.equal(extractUsage("codex", await fixture("codex-stdout.txt"), ""), undefined);
  assert.equal(extractUsage("claude", "{\"result\":\"ok\"}", ""), undefined);
  assert.equal(extractUsage("agy", "not json at all", ""), undefined);
  assert.equal(
    extractUsage("claude", "{\"usage\":{\"input_tokens\":\"many\"}}", ""),
    undefined,
    "a non-numeric count is not coerced"
  );
  assert.equal(
    extractUsage("claude", "{\"usage\":{\"input_tokens\":-5}}", ""),
    undefined,
    "a negative count is not a measurement"
  );
});

test("nothing but numbers survives: prompts and secrets never enter the record", () => {
  const secret = `ghp_${"A".repeat(36)}`;
  const usage = extractUsage(
    "claude",
    JSON.stringify({
      result: `the reviewer said ${secret}`,
      session_id: secret,
      usage: { input_tokens: 10, output_tokens: 20, note: secret },
      total_cost_usd: 0.5
    }),
    `progress mentioning ${secret}`
  );

  assert.ok(usage);
  const serialized = JSON.stringify(usage);
  assert.doesNotMatch(serialized, /ghp_/);
  assert.doesNotMatch(serialized, /reviewer said/);
  for (const value of Object.values(usage)) {
    assert.equal(typeof value, "number");
  }
});
