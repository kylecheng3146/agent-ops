import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {resolve} from "node:path";
import {promisify} from "node:util";
import test from "node:test";

test("run startup ignores live runtime artifacts and preserves source and runtime gates", async () => {
  const result = await promisify(execFile)(process.execPath, ["tests/run/startup.acceptance.mjs"], {
    cwd: process.cwd(), env: {...process.env, AGENT_OPS_DEBUG_TEST_BUILD: resolve(".tmp/test-dist")}, timeout: 120000, maxBuffer: 1024 * 1024
  });
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.completed, true);
  assert.equal(report.results.length, 12);
  assert.ok(report.results.every((r: {status: string}) => r.status === "PASS"), result.stdout);
});
