import assert from "node:assert/strict";
import test from "node:test";

import { CliArgumentError, parseArgs } from "../../packages/cli/src/args.js";
import { completeInitChoices } from "../../packages/cli/src/wizard.js";
import type { ReviewTargetId } from "../../runtime/src/contracts.js";

interface Recorded {
  readonly questions: string[];
  readonly probed: ReviewTargetId[];
}

function scriptedIo(answers: readonly string[], recorded: Recorded) {
  const queue = [...answers];
  return {
    isTTY: true,
    async prompt(question: string): Promise<string> {
      recorded.questions.push(question);
      return queue.shift() ?? "";
    }
  };
}

function probe(recorded: Recorded, failing: readonly ReviewTargetId[] = []) {
  return async (target: ReviewTargetId): Promise<boolean> => {
    recorded.probed.push(target);
    return !failing.includes(target);
  };
}

test("declining external review writes no targets and probes nothing", async () => {
  const recorded: Recorded = { questions: [], probed: [] };
  const args = await completeInitChoices(
    parseArgs(["init"]),
    scriptedIo(["project", "codex", "core", ""], recorded),
    { probeReviewTarget: probe(recorded) }
  );
  assert.equal(args.reviewTargets, undefined);
  assert.deepEqual(recorded.probed, []);
  // The external-review question must default to "no".
  assert.ok(
    recorded.questions.some((question) => /external review/i.test(question))
  );
  assert.ok(
    recorded.questions.some((question) => /\[y\/N\]|\(y\/N\)/i.test(question))
  );
});

test("accepting external review records the declared order and probes once each", async () => {
  const recorded: Recorded = { questions: [], probed: [] };
  const args = await completeInitChoices(
    parseArgs(["init"]),
    scriptedIo(["project", "codex", "core", "y", "agy,codex"], recorded),
    { probeReviewTarget: probe(recorded) }
  );
  // Declared order wins over the order the operator typed.
  assert.deepEqual(args.reviewTargets, ["codex", "agy"]);
  assert.deepEqual(recorded.probed, ["codex", "agy"]);
});

test("a failing probe warns but still completes the install", async () => {
  const recorded: Recorded = { questions: [], probed: [] };
  const warnings: string[] = [];
  const args = await completeInitChoices(
    parseArgs(["init"]),
    scriptedIo(["project", "codex", "core", "y", "codex"], recorded),
    {
      probeReviewTarget: probe(recorded, ["codex"]),
      warn: (message) => warnings.push(message)
    }
  );
  assert.deepEqual(args.reviewTargets, ["codex"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /codex login/);
});

test("opencode is not offered and is rejected if typed", async () => {
  const recorded: Recorded = { questions: [], probed: [] };
  await assert.rejects(
    completeInitChoices(
      parseArgs(["init"]),
      scriptedIo(["project", "codex", "core", "y", "opencode"], recorded),
      { probeReviewTarget: probe(recorded) }
    ),
    CliArgumentError
  );
  assert.deepEqual(recorded.probed, []);
});

test("the non-interactive path takes repeated flags and never probes", async () => {
  const recorded: Recorded = { questions: [], probed: [] };
  const args = await completeInitChoices(
    parseArgs([
      "init",
      "--scope",
      "project",
      "--harness",
      "codex",
      "--profile",
      "core",
      "--review-target",
      "agy",
      "--review-target",
      "codex"
    ]),
    { isTTY: false },
    { probeReviewTarget: probe(recorded) }
  );
  assert.deepEqual(args.reviewTargets, ["agy", "codex"]);
  assert.deepEqual(recorded.probed, []);
  assert.deepEqual(recorded.questions, []);
});

test("--review-target validates its value and rejects duplicates", () => {
  assert.throws(
    () => parseArgs(["init", "--review-target", "opencode"]),
    CliArgumentError
  );
  assert.throws(
    () =>
      parseArgs([
        "init",
        "--review-target",
        "codex",
        "--review-target",
        "codex"
      ]),
    CliArgumentError
  );
  assert.deepEqual(
    parseArgs(["init", "--review-target", "claude"]).reviewTargets,
    ["claude"]
  );
});

test("a non-interactive init without the flag configures no targets", async () => {
  const args = await completeInitChoices(
    parseArgs([
      "init",
      "--scope",
      "project",
      "--harness",
      "codex",
      "--profile",
      "core"
    ]),
    { isTTY: false }
  );
  assert.equal(args.reviewTargets, undefined);
});
