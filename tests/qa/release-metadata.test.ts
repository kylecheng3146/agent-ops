import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("current release metadata agrees across package, lockfile, README, and changelog", async () => {
  const [manifest, lockfile, readme, changelog] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("package-lock.json", "utf8"),
    readFile("README.md", "utf8"),
    readFile("CHANGELOG.md", "utf8")
  ]);
  const { version } = JSON.parse(manifest) as { version: string };
  const lock = JSON.parse(lockfile) as { version: string; packages: Record<string, { version: string }> };
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""]?.version, version);
  assert.ok(readme.includes(`This source release is version ${version}.`));
  const [unreleased, latest] = changelog.split(/\r?\n/u).filter(line => line.startsWith("## "));
  assert.equal(unreleased, "## [Unreleased]");
  assert.equal(latest?.match(/^## \[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/u)?.[1], version);
});
