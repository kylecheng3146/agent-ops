import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {resolve} from "node:path";
import {promisify} from "node:util";
import test from "node:test";

test("escape acceptance runner reports every rule and lesson check as PASS", async () => {
  // The runner exits 1 on any FAIL; keep its stdout so the failing checks are named.
  const result = await promisify(execFile)(process.execPath, ["tests/escape/acceptance.mjs"], {
    cwd: process.cwd(), env: {...process.env, AGENT_OPS_DEBUG_TEST_BUILD: resolve(".tmp/test-dist"),
      AGENT_OPS_ACCEPTANCE_EXECUTION_ID: "escape-unit", AGENT_OPS_ACCEPTANCE_PHASE: "baseline"},
    timeout: process.platform === "win32" ? 600_000 : 300_000, maxBuffer: 4 * 1024 * 1024
  }).catch((e: {stdout?: string}) => {if (!e.stdout?.trim()) throw e; return {stdout: e.stdout};});
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.protocolVersion, 1);
  assert.equal(report.completed, true);
  assert.equal(report.results.length, 17);
  assert.ok(report.results.every((r: {executionId: string, phase: string}) => r.executionId === "escape-unit" && r.phase === "baseline"));
  for (const id of ["escape-lesson-store", "escape-lesson-gate", "escape-lesson-metrics"]) {
    assert.ok(report.results.some((r: {checkId: string}) => r.checkId === id), id);
  }
  assert.ok(report.results.every((r: {checkId: string}) => r.checkId.startsWith("escape-")), "escape runner runs only escape checks");
  const failed = report.results.filter((r: {status: string}) => r.status !== "PASS");
  assert.deepEqual(failed, []);
});
