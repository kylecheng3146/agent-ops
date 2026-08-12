import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  extractFinalMessage,
  extractJsonObject
} from "../../runtime/src/review/extract.js";

function fixture(name: string): string {
  return readFileSync(resolve("tests", "fixtures", "review", name), "utf8");
}

const CLAUDE = fixture("claude-stdout.txt");
const AGY = fixture("agy-stdout.txt");
const CODEX = fixture("codex-stdout.txt");

test("each target's final message is recovered from its real stdout", () => {
  assert.equal(extractFinalMessage("claude", CLAUDE), "OK");
  assert.equal(extractFinalMessage("agy", AGY), "OK");
  assert.equal(extractFinalMessage("codex", CODEX), "OK");
});

test("the envelope branches are not interchangeable", () => {
  // claude puts the answer under .result, agy under .response.
  assert.equal(extractFinalMessage("agy", CLAUDE), undefined);
  assert.equal(extractFinalMessage("claude", AGY), undefined);
});

test("malformed transport output misses instead of throwing", () => {
  for (const target of ["claude", "agy"] as const) {
    assert.equal(extractFinalMessage(target, ""), undefined);
    assert.equal(extractFinalMessage(target, "{\"result\":"), undefined);
    assert.equal(extractFinalMessage(target, "not json at all"), undefined);
    assert.equal(extractFinalMessage(target, "{}"), undefined);
  }
  assert.equal(extractFinalMessage("codex", "   \n  "), undefined);
});

test("codex stderr noise never reaches the extractor", () => {
  // Progress, banner and hook lines go to stderr; stdout is the bare answer.
  const stderr = fixture("codex-stderr.txt");
  assert.match(stderr, /sandbox: read-only/);
  assert.equal(extractFinalMessage("codex", CODEX), "OK");
});

test("a JSON object is recovered from a fence, from prose, or missed", () => {
  const payload = "{\"results\":[{\"criterionId\":\"tests\",\"status\":\"PASS\"," +
    "\"evidence\":[\"npm test\"]}]}";
  assert.deepEqual(
    extractJsonObject(["```json", payload, "```"].join("\n")),
    JSON.parse(payload)
  );
  assert.deepEqual(
    extractJsonObject(`Here is my verdict:\n${payload}\nThanks.`),
    JSON.parse(payload)
  );
  assert.deepEqual(extractJsonObject(payload), JSON.parse(payload));
  assert.equal(extractJsonObject("no object here"), undefined);
  assert.equal(extractJsonObject("{ broken"), undefined);
  assert.equal(extractJsonObject("[1,2,3]"), undefined);
});

test("the composed path returns the model's object, never the envelope", () => {
  const payload = "{\"results\":[{\"criterionId\":\"tests\",\"status\":\"PASS\"," +
    "\"evidence\":[\"npm test\"]}]}";
  const envelope = JSON.stringify({
    is_error: false,
    subtype: "success",
    result: `Verdict:\n\`\`\`json\n${payload}\n\`\`\``
  });
  const message = extractFinalMessage("claude", envelope);
  assert.notEqual(message, undefined);
  const parsed = extractJsonObject(message ?? "");
  assert.deepEqual(parsed, JSON.parse(payload));
  assert.equal((parsed as { is_error?: unknown }).is_error, undefined);
});
