import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {resolve} from "node:path";
import {promisify} from "node:util";
import test from "node:test";

test("run startup ignores live runtime artifacts and preserves source and runtime gates", async () => {
  // The runner exits 1 on any FAIL; keep its stdout so the failing checks are named.
  const result = await promisify(execFile)(process.execPath, ["tests/run/startup.acceptance.mjs"], {
    cwd: process.cwd(), env: {...process.env, AGENT_OPS_DEBUG_TEST_BUILD: resolve(".tmp/test-dist")}, timeout: 600000, maxBuffer: 4 * 1024 * 1024
  }).catch((e: {stdout?: string}) => {if (!e.stdout?.trim()) throw e; return {stdout: e.stdout};});
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.completed, true);
  assert.equal(report.results.length, 63);
  const failed = report.results.filter((r: {status: string}) => r.status !== "PASS");
  assert.deepEqual(failed, []);
});
