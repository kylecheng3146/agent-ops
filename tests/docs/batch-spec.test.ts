import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { TRANSIENT_REVIEW_REASONS } from "../../runtime/src/review/batch.js";

/** A tracked text file with LF endings: Windows checks files out with CRLF. */
async function read(path: string): Promise<string> {
  return (await readFile(resolve(path), "utf8")).replace(/\r\n/gu, "\n");
}

async function rule(id: string): Promise<string> {
  const source = await read("docs/en/spec/review.md");
  const start = source.indexOf(`## ${id}\n`);
  assert.ok(start >= 0, `${id} is missing from the review spec`);
  const next = source.indexOf("\n## ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

test("spec-rules: the batch rules exist in order", async () => {
  const source = await read("docs/en/spec/review.md");
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
  const readme = await read("README.md");
  assert.match(readme, /agent-ops batch --parent <task-id> --yes/u);
  for (const flag of ["--parent", "--base", "--parent-base", "--width", "--output"]) {
    assert.ok(readme.includes(`\`${flag}\``) || readme.includes(` ${flag} `), `README does not mention ${flag}`);
  }
  const changelog = await read("CHANGELOG.md");
  // The entry sits under Unreleased until it ships, then under its version heading.
  assert.ok(changelog.includes("All notable changes"));
  assert.ok(changelog.includes("## [Unreleased]"));
  assert.match(changelog, /agent-ops batch --parent/u);
});
