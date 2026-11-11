import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {resolve} from "node:path";
import {promisify} from "node:util";
import test from "node:test";

test("run startup ignores live runtime artifacts and preserves source and runtime gates", async () => {
  // The runner exits 1 on any FAIL; keep its stdout so the failing checks are named.
  const result = await promisify(execFile)(process.execPath, ["tests/run/startup.acceptance.mjs"], {
    cwd: process.cwd(), env: {...process.env, AGENT_OPS_DEBUG_TEST_BUILD: resolve(".tmp/test-dist")},
    // The real Git/process suite needs headroom while the other repository tests run.
    // Windows CI ran past 20 minutes on Node 22 once the learning checks were added;
    // a loaded macOS machine ran past 15. Stay under the 30-minute node-test verifier cap.
    timeout: process.platform === "win32" ? 2_400_000 : 1_500_000, maxBuffer: 4 * 1024 * 1024
  }).catch((e: {stdout?: string}) => {if (!e.stdout?.trim()) throw e; return {stdout: e.stdout};});
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.completed, true);
  assert.equal(report.results.length, 149);
  const failed = report.results.filter((r: {status: string}) => r.status !== "PASS");
  assert.deepEqual(failed, []);
});
