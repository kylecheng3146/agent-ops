import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

// The Office server runs detached without a console; on Windows every child it
// starts without windowsHide opens (and closes) a visible cmd window.
const FILES = [
  "runtime/src/office/collect.ts",
  "packages/cli/src/parallel-deps.ts",
  "packages/cli/src/context.ts",
  "runtime/src/fs/transaction.ts"
];

test("every child process on the Office server path hides its console window", async () => {
  for (const file of FILES) {
    const source = await readFile(file, "utf8");
    const calls = [...source.matchAll(/\b(?:execFileSync|execFile|spawn)\(|\brun\("git"/gu)];
    assert.ok(calls.length > 0, `${file} has no child process call`);
    for (const call of calls) {
      // The options object is the first {...} after the call opens.
      const rest = source.slice(call.index);
      assert.match(rest.slice(0, rest.indexOf("}") + 1), /windowsHide: true/u, `${file}:${call.index} ${call[0]}`);
    }
  }
});
