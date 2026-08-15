import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  extractFinalMessage,
  extractJsonObject,
  extractReviewObject
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

test("review JSON must be the complete response, without fences or prose recovery", () => {
  const payload = "{\"results\":[{\"criterionId\":\"tests\",\"status\":\"PASS\"," +
    "\"evidence\":[\"npm test\"]}]}";
  assert.equal(extractJsonObject(["```json", payload, "```"].join("\n")), undefined);
  assert.equal(extractJsonObject(`Here is my verdict:\n${payload}\nThanks.`), undefined);
  assert.deepEqual(extractJsonObject(payload), JSON.parse(payload));
  assert.equal(extractJsonObject("no object here"), undefined);
  assert.equal(extractJsonObject("{ broken"), undefined);
  assert.equal(extractJsonObject("[1,2,3]"), undefined);
});

test("review extraction accepts only each target's native structured field", () => {
  const payload = "{\"results\":[{\"criterionId\":\"tests\",\"status\":\"PASS\"," +
    "\"evidence\":[\"npm test\"]}]}";
  const envelope = JSON.stringify({
    is_error: false,
    subtype: "success",
    structured_output: JSON.parse(payload)
  });
  assert.deepEqual(extractReviewObject("claude", envelope), JSON.parse(payload));
  assert.deepEqual(extractReviewObject("agy", JSON.stringify({ response: payload })), JSON.parse(payload));
  assert.deepEqual(extractReviewObject("codex", payload), JSON.parse(payload));
  assert.equal(extractReviewObject("claude", JSON.stringify({ result: payload })), undefined);
  assert.equal(extractReviewObject("codex", `prose ${payload}`), undefined);
});
