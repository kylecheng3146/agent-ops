import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { TRANSIENT_REVIEW_REASONS } from "../../runtime/src/review/batch.js";

async function rule(id: string): Promise<string> {
  const source = await readFile(resolve("docs/en/spec/review.md"), "utf8");
  const start = source.indexOf(`## ${id}\n`);
  assert.ok(start >= 0, `${id} is missing from the review spec`);
  const next = source.indexOf("\n## ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

test("spec-rules: the batch rules exist in order", async () => {
  const source = await readFile(resolve("docs/en/spec/review.md"), "utf8");
  const ids = [...source.matchAll(/^## (REVIEW-BATCH-\d{3})$/gm)].map((match) => match[1]);
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7].map((n) => `REVIEW-BATCH-${String(n).padStart(3, "0")}`));
});

test("spec-matches-code: the degrade rule names exactly the transient reasons the scheduler retries", async () => {
  const action = (await rule("REVIEW-BATCH-004")).split("\n").find((line) => line.startsWith("- Action:")) ?? "";
  const named = new Set([...action.matchAll(/`([a-z]+(?:-[a-z]+)*)`/gu)].map((match) => match[1]));
  assert.deepEqual([...named].sort(), [...TRANSIENT_REVIEW_REASONS].sort());
});

test("spec-matches-code: the width default and the exit codes are stated where the behavior is defined", async () => {
  assert.match(await rule("REVIEW-BATCH-003"), /`--width` reviews \(default 2\)/u);
  assert.match(
    await rule("REVIEW-BATCH-007"),
    /Exit 0 when every task passed, 1 when any review or verification failed, and 2 otherwise/u
  );
});

test("readme-changelog: the README and the changelog announce the batch command", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  assert.match(readme, /agent-ops batch --parent <task-id> --yes/u);
  for (const flag of ["--parent", "--base", "--parent-base", "--width", "--output"]) {
    assert.ok(readme.includes(`\`${flag}\``) || readme.includes(` ${flag} `), `README does not mention ${flag}`);
  }
  const changelog = await readFile(resolve("CHANGELOG.md"), "utf8");
  const unreleased = changelog.slice(
    changelog.indexOf("## [Unreleased]"),
    changelog.indexOf("\n## [", changelog.indexOf("## [Unreleased]") + 1)
  );
  assert.match(unreleased, /agent-ops batch --parent/u);
});
