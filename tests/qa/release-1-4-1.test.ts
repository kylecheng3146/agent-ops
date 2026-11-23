// Independent QA for the 1.4.1 release metadata (plan cases release-1-4-1-version-consistent
// and release-1-4-1-changelog-structure). Test names are the plan's check IDs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const VERSION = "1.4.1";
const HEADING = "## [1.4.1] - 2026-11-23";
const UNRELEASED = "## [Unreleased]";

const read = async (path: string): Promise<string> => (await readFile(resolve(path), "utf8")).replace(/\r\n/gu, "\n");

test("release-1-4-1-version-metadata", async () => {
  const pkg = JSON.parse(await read("package.json")) as { version?: string };
  assert.equal(pkg.version, VERSION);
  const lock = JSON.parse(await read("package-lock.json")) as { version?: string; packages?: Record<string, { version?: string }> };
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages?.[""]?.version, VERSION);
  assert.ok((await read("README.md")).includes(`This source release is version ${VERSION}.`), "README names 1.4.1");
  const lines = (await read("CHANGELOG.md")).split("\n");
  const unreleased = lines.indexOf(UNRELEASED);
  const released = lines.indexOf(HEADING);
  assert.ok(unreleased >= 0, "CHANGELOG keeps ## [Unreleased]");
  assert.ok(released > unreleased, "dated 1.4.1 heading sits below Unreleased");
});

test("release-1-4-1-changelog-entry", async () => {
  const lines = (await read("CHANGELOG.md")).split("\n");
  const unreleased = lines.indexOf(UNRELEASED);
  const released = lines.indexOf(HEADING);
  assert.ok(unreleased >= 0, "CHANGELOG keeps ## [Unreleased]");
  assert.ok(released > unreleased, "dated 1.4.1 heading sits below Unreleased");
  assert.deepEqual(lines.slice(unreleased + 1, released).filter(line => line.trim() !== ""), [], "Unreleased section is empty");
  const next = lines.findIndex((line, index) => index > released && line.startsWith("## "));
  const section = lines.slice(released + 1, next < 0 ? undefined : next).join(" ").replace(/\s+/gu, " ");
  assert.ok(section.includes("QA author") && section.includes("clone"), "1.4.1 notes describe the QA author clone fix");
  assert.ok(section.includes("AGENT_OPS_QA_TASK_ID"), "1.4.1 notes name AGENT_OPS_QA_TASK_ID");
  assert.ok(section.includes(".agent-ops/qa-author-input.json"), "1.4.1 notes name .agent-ops/qa-author-input.json");
});
