import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {resolve} from "node:path";
import {promisify} from "node:util";
import test from "node:test";

interface Report {completed: boolean; results: {checkId: string; status: string}[]}
const SHARDS = 8;

// The runner exits 1 on any FAIL; keep its stdout so the failing checks are named.
async function runStartup(extra: Record<string, string>): Promise<{code: number; stdout: string}> {
  const env: NodeJS.ProcessEnv = {...process.env, AGENT_OPS_DEBUG_TEST_BUILD: resolve(".tmp/test-dist")};
  delete env.AGENT_OPS_ACCEPTANCE_CHECKS; delete env.AGENT_OPS_ACCEPTANCE_SHARD;
  return await promisify(execFile)(process.execPath, ["tests/run/startup.acceptance.mjs"], {
    cwd: process.cwd(), env: {...env, ...extra},
    // The real Git/process suite needs headroom while the other repository tests run.
    // Windows CI ran past 20 minutes on Node 22 once the learning checks were added;
    // a loaded macOS machine ran past 15. Stay under the 30-minute node-test verifier cap.
    timeout: process.platform === "win32" ? 2_400_000 : 1_500_000, maxBuffer: 4 * 1024 * 1024
  }).then(r => ({code: 0, stdout: r.stdout}), (e: {code?: unknown; stdout?: string}) => {
    if (typeof e.code !== "number") throw e;
    return {code: e.code, stdout: e.stdout ?? ""};
  });
}
const report = (stdout: string): Report => JSON.parse(stdout.trim()) as Report;

test("run startup ignores live runtime artifacts and preserves source and runtime gates", async () => {
  // One serial process took over 11 minutes; shards run the same checks in parallel processes.
  const shards = await Promise.all(Array.from({length: SHARDS}, (_, i) => runStartup({AGENT_OPS_ACCEPTANCE_SHARD: `${i}/${SHARDS}`})));
  const ids: string[] = [];
  for (const [i, shard] of shards.entries()) {
    const r = report(shard.stdout);
    assert.equal(r.completed, true, `shard ${i} completed`);
    assert.deepEqual(r.results.filter(x => x.status !== "PASS"), [], `shard ${i} has no failing check`);
    ids.push(...r.results.map(x => x.checkId));
  }
  assert.equal(new Set(ids).size, ids.length, "every check runs in exactly one shard");
  assert.equal(ids.length, 185);
});

test("startup runner shards after the check filter and rejects malformed shards", async () => {
  const only = {AGENT_OPS_ACCEPTANCE_CHECKS: "run-goal-ignore"};
  const ids = async (extra: Record<string, string>) => {
    const r = await runStartup({...only, ...extra});
    assert.equal(r.code, 0);
    const parsed = report(r.stdout);
    assert.equal(parsed.completed, true);
    return parsed.results.map(x => x.checkId);
  };
  assert.deepEqual(await ids({}), ["run-goal-ignore"]);
  assert.deepEqual(await ids({AGENT_OPS_ACCEPTANCE_SHARD: "0/2"}), ["run-goal-ignore"]);
  assert.deepEqual(await ids({AGENT_OPS_ACCEPTANCE_SHARD: "1/2"}), []);
  for (const bad of ["8/8", "abc", "0/0", "-1/8"]) {
    const r = await runStartup({...only, AGENT_OPS_ACCEPTANCE_SHARD: bad});
    assert.notEqual(r.code, 0, `${bad} is rejected`);
    assert.equal(r.stdout.trim(), "", `${bad} runs no check`);
  }
});
