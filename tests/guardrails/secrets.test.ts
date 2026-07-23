import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { evaluateGuardrail } from "../../runtime/src/guardrails/evaluate.js";

interface SecretFixture {
  id: string;
  parts: string[];
  expected:
    | { action: "allow" }
    | { action: "block"; ruleId: string };
}

async function readFixtures(): Promise<SecretFixture[]> {
  const path = resolve("tests", "fixtures", "guardrails", "secrets.json");
  return JSON.parse(await readFile(path, "utf8")) as SecretFixture[];
}

test("classifies secret fixtures without returning credential material", async (t) => {
  for (const fixture of await readFixtures()) {
    await t.test(fixture.id, () => {
      const content = fixture.parts.join("");
      const input = {
        kind: "content" as const,
        content,
        scope: "docs/example.md"
      };

      const decision = evaluateGuardrail(input);

      assert.equal(decision.action, fixture.expected.action);
      if ("ruleId" in fixture.expected) {
        assert.equal(
          decision.action === "allow" ? undefined : decision.ruleId,
          fixture.expected.ruleId
        );
      }
      assert.doesNotMatch(JSON.stringify(decision), new RegExp(content, "u"));
      assert.deepEqual(input, {
        kind: "content",
        content,
        scope: "docs/example.md"
      });
    });
  }
});

test("returns the same redacted decision for the same content", async () => {
  const fixture = (await readFixtures()).find(
    ({ id }) => id === "high-entropy-assignment-block"
  );
  assert.ok(fixture);
  const input = {
    kind: "content" as const,
    content: fixture.parts.join(""),
    scope: "config/local.env"
  };

  assert.deepEqual(evaluateGuardrail(input), evaluateGuardrail(input));
});
