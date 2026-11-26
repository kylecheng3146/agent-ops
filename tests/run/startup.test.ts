import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {resolve} from "node:path";
import {promisify} from "node:util";
import test from "node:test";

interface Report {completed: boolean; results: {checkId: string; status: string}[]}
const SHARDS = 8;

// The runner exits 1 on any FAIL; keep its stdout so the failing checks are named, and its stderr so a crash names its check.
async function runStartup(extra: Record<string, string>): Promise<{code: number | null; stdout: string; stderr: string; signal?: string | null}> {
  const env: NodeJS.ProcessEnv = {...process.env, AGENT_OPS_DEBUG_TEST_BUILD: resolve(".tmp/test-dist")};
  delete env.AGENT_OPS_ACCEPTANCE_CHECKS; delete env.AGENT_OPS_ACCEPTANCE_SHARD;
  return await promisify(execFile)(process.execPath, ["tests/run/startup.acceptance.mjs"], {
    cwd: process.cwd(), env: {...env, ...extra},
    // The real Git/process suite needs headroom while the other repository tests run.
    // Windows CI ran past 20 minutes on Node 22 once the learning checks were added;
    // a loaded macOS machine ran past 15. Stay under the 30-minute node-test verifier cap.
    timeout: process.platform === "win32" ? 2_400_000 : 1_500_000, maxBuffer: 4 * 1024 * 1024
  }).then(r => ({code: 0, stdout: r.stdout, stderr: r.stderr}), (e: {code?: unknown; signal?: string | null; stdout?: string; stderr?: string}) => {
    // A signal-killed shard has code null; keep it so report() names the crash instead of throwing here.
    if (typeof e.code !== "number" && !e.signal) throw e;
    return {code: typeof e.code === "number" ? e.code : null, signal: e.signal ?? null, stdout: e.stdout ?? "", stderr: e.stderr ?? ""};
  });
}
// A shard whose stdout is not the JSON report crashed: name its exit, signal and last stderr lines (the last "startup: <checkId>").
function report(shard: {code: number | null; signal?: string | null; stdout: string; stderr: string}, label = "startup runner"): Report {
  try {return JSON.parse(shard.stdout.trim()) as Report;}
  catch (e) {
    const tail = shard.stderr.trimEnd().split(/\r?\n/u).slice(-20).join("\n");
    assert.fail(`${label} printed no JSON report (exit ${shard.code}, signal ${shard.signal ?? "none"}: ${(e as Error).message}); stderr tail:\n${tail}`);
  }
}

test("a crashed startup shard is named by label, exit, signal and its last stderr lines", () => {
  // 25 stderr lines: the tail keeps the last 20, so the first lines drop and the last "startup: <checkId>" stays.
  const stderr = Array.from({length: 24}, (_, i) => `startup: check-${i}`).concat("boom").join("\n");
  for (const shard of [{code: 1, signal: null}, {code: null, signal: "SIGKILL"}]) {
    assert.throws(() => report({...shard, stdout: "", stderr}, "shard 6"), (e: Error) => {
      assert.match(e.message, /^shard 6 printed no JSON report/u);
      assert.ok(e.message.includes(`exit ${shard.code}, signal ${shard.signal ?? "none"}`), e.message);
      assert.ok(e.message.includes("startup: check-23\nboom"), e.message);
      assert.ok(!e.message.includes("startup: check-4\n"), "only the last 20 stderr lines are kept");
      return true;
    });
  }
});

test("run startup ignores live runtime artifacts and preserves source and runtime gates", async () => {
  // One serial process took over 11 minutes; shards run the same checks in parallel processes.
  const shards = await Promise.all(Array.from({length: SHARDS}, (_, i) => runStartup({AGENT_OPS_ACCEPTANCE_SHARD: `${i}/${SHARDS}`})));
  const ids: string[] = [];
  for (const [i, shard] of shards.entries()) {
    const r = report(shard, `shard ${i}`);
    assert.equal(r.completed, true, `shard ${i} completed`);
    assert.deepEqual(r.results.filter(x => x.status !== "PASS"), [], `shard ${i} has no failing check`);
    ids.push(...r.results.map(x => x.checkId));
  }
  assert.equal(new Set(ids).size, ids.length, "every check runs in exactly one shard");
  assert.equal(ids.length, 189);
});

test("startup runner shards after the check filter and rejects malformed shards", async () => {
  const only = {AGENT_OPS_ACCEPTANCE_CHECKS: "run-goal-ignore"};
  const ids = async (extra: Record<string, string>) => {
    const r = await runStartup({...only, ...extra});
    assert.equal(r.code, 0);
    const parsed = report(r);
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
