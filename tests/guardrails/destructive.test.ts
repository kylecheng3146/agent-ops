import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type { SecurityException } from "../../runtime/src/contracts.js";
import { evaluateGuardrail } from "../../runtime/src/guardrails/evaluate.js";

interface CommandFixture {
  id: string;
  command: string;
  args: string[];
  scope: string;
  expected:
    | { action: "allow" }
    | { action: "warn" | "block"; ruleId: string };
}

interface ExceptionFixture {
  id: string;
  exception: SecurityException;
  evaluationScope: string;
  expectedAction: "allow" | "block";
}

async function readJsonFixture<T>(name: string): Promise<T> {
  const path = resolve("tests", "fixtures", "guardrails", name);
  return JSON.parse(await readFile(path, "utf8")) as T;
}

test("classifies destructive command fixtures without executing input", async (t) => {
  const fixtures = await readJsonFixture<CommandFixture[]>("destructive.json");

  for (const fixture of fixtures) {
    await t.test(fixture.id, () => {
      const input = {
        kind: "command" as const,
        command: fixture.command,
        args: fixture.args,
        scope: fixture.scope
      };

      const decision = evaluateGuardrail(input);

      assert.equal(decision.action, fixture.expected.action);
      if ("ruleId" in fixture.expected) {
        assert.equal(
          decision.action === "allow" ? undefined : decision.ruleId,
          fixture.expected.ruleId
        );
      }
      assert.deepEqual(input.args, fixture.args);
    });
  }

  assert.deepEqual(
    evaluateGuardrail({
      kind: "command",
      command: "node",
      args: ["-e", "throw new Error('guardrail input was executed')"],
      scope: "packages/cli"
    }),
    { action: "allow" }
  );
});

test("applies only valid exact-rule bounded unexpired exceptions", async (t) => {
  const fixtures = await readJsonFixture<ExceptionFixture[]>("exceptions.json");
  const now = new Date("2030-01-01T00:00:00.000Z");

  for (const fixture of fixtures) {
    await t.test(fixture.id, () => {
      const input = {
        kind: "command" as const,
        command: "git",
        args: ["reset", "--hard", "HEAD~1"],
        scope: fixture.evaluationScope
      };
      const options = {
        exceptions: [fixture.exception],
        now
      };

      const first = evaluateGuardrail(input, options);
      const second = evaluateGuardrail(input, options);

      assert.equal(first.action, fixture.expectedAction);
      assert.deepEqual(first, second);
    });
  }
});

test("does not provide a global exception bypass", () => {
  const decision = evaluateGuardrail(
    {
      kind: "command",
      command: "git",
      args: ["push", "--force", "origin", "main"],
      scope: "packages/cli"
    },
    {
      exceptions: [
        {
          ruleId: "*",
          scope: ".",
          expiresAt: "2999-01-01T00:00:00.000Z",
          reason: "Attempted global bypass."
        }
      ],
      now: new Date("2030-01-01T00:00:00.000Z")
    }
  );

  assert.equal(decision.action, "block");
  assert.equal(decision.ruleId, "destructive-force-push");
});

test("never invokes an executable clock supplied in evaluation options", () => {
  let clockCalls = 0;
  const input = {
    kind: "command" as const,
    command: "git",
    args: ["reset", "--hard", "HEAD~1"],
    scope: "packages/cli"
  };
  const options = {
    exceptions: [
      {
        ruleId: "destructive-reset",
        scope: "packages/cli",
        expiresAt: "2030-01-02T00:00:00.000Z",
        reason: "A callback must not grant this exception."
      }
    ],
    clock: () => {
      clockCalls += 1;
      return new Date("2030-01-01T00:00:00.000Z");
    }
  };

  const first = evaluateGuardrail(input, options);
  const second = evaluateGuardrail(input, options);

  assert.equal(clockCalls, 0);
  assert.equal(first.action, "block");
  assert.deepEqual(first, second);
});
