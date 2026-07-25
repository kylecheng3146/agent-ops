import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("package check script exists and is registered through npm", async () => {
  await access("scripts/package-check.mjs");
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.scripts?.["package:check"], "node scripts/package-check.mjs");
});
