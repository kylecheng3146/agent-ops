import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package exposes a Node 22 CLI without runtime dependencies", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "@kylecheng3146/agent-ops");
  assert.equal(pkg.engines.node, ">=22.14.0");
  assert.equal(pkg.bin["agent-ops"], "dist/packages/cli/src/bin.js");
  assert.deepEqual(pkg.dependencies ?? {}, {});
});

test("test compilation cleans only the top-level temporary root", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(
    pkg.scripts["test:compile"],
    "node scripts/clean.mjs .tmp && tsc -p tsconfig.test.json",
  );
});
