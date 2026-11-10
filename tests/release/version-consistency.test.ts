import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const read = async (path: string): Promise<string> => (await readFile(resolve(path), "utf8")).replace(/\r\n/gu, "\n");

test("README status, lockfile and CHANGELOG name the package version", async () => {
  const { version } = JSON.parse(await read("package.json")) as { version: string };
  const lock = JSON.parse(await read("package-lock.json")) as { version: string; packages: Record<string, { version?: string }> };
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""]?.version, version);
  assert.ok((await read("README.md")).includes(`This source release is version ${version}.`));
  // The released version has a dated heading below Unreleased, which stays for the next changes.
  const changelog = await read("CHANGELOG.md");
  const released = changelog.search(new RegExp(`^## \\[${version.replace(/\./gu, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "mu"));
  assert.ok(released > changelog.indexOf("## [Unreleased]") && changelog.indexOf("## [Unreleased]") >= 0);
});
