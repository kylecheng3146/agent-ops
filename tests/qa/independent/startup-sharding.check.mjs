// Independent QA for sharding tests/run/startup.acceptance.mjs and running the shards in parallel
// from tests/run/startup.test.ts. Run by tests/qa/acceptance.mjs from the checkout root.
// Real-runner checks need a build in dist/ (or AGENT_OPS_DEBUG_TEST_BUILD) like the runner itself.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const RUNNER = resolve('tests/run/startup.acceptance.mjs');
const STARTUP_TEST = resolve('tests/run/startup.test.ts');
const TOTAL = 180;

// Spawn a node process and keep exit code, stdout and stderr whatever the outcome.
function spawnNode(args, {cwd = process.cwd(), env, timeout}) {
  return new Promise((done, fail) => execFile(process.execPath, args, {cwd, env, timeout, maxBuffer: 16 * 1024 * 1024},
    (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return fail(error);
      done({code: error ? error.code : 0, stdout, stderr});
    }));
}

// The QA runner itself is invoked with AGENT_OPS_ACCEPTANCE_CHECKS naming *these* checks; never leak it.
function runnerEnv(extra) {
  const env = {...process.env, AGENT_OPS_ACCEPTANCE_EXECUTION_ID: 'qa-startup-sharding', AGENT_OPS_ACCEPTANCE_PHASE: 'qa-phase'};
  delete env.AGENT_OPS_ACCEPTANCE_CHECKS; delete env.AGENT_OPS_ACCEPTANCE_SHARD;
  return {...env, ...extra};
}
const runRunner = (extra, timeout = 1_500_000) => spawnNode([RUNNER], {env: runnerEnv(extra), timeout});

function parseReport(run, label) {
  let report;
  try {report = JSON.parse(run.stdout.trim());}
  catch {assert.fail(`${label}: stdout is not one JSON report (exit ${run.code})`);}
  assert.equal(report.completed, true, `${label}: completed`);
  assert.ok(Array.isArray(report.results), `${label}: results array`);
  return report;
}
async function selected(extra, label) {
  const run = await runRunner(extra);
  assert.equal(run.code, 0, `${label}: exit code`);
  return parseReport(run, label).results.map(r => r.checkId);
}

const ONLY = {AGENT_OPS_ACCEPTANCE_CHECKS: 'run-goal-ignore'};
const MALFORMED = ['8/8', 'abc', '0/0', '-1/8', '1/0', '0/2/1', ' 0/2'];

// ---- Stub harness for tests/run/startup.test.ts -------------------------------------------------
// A fast stand-in for the real runner: 180 synthetic checks (one is run-goal-ignore), i/n sharding
// after the check filter, malformed shards rejected, and a file barrier proving the 8 shards overlap.
const STUB = String.raw`
import {appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const dir = process.env.QA_STARTUP_STUB_DIR, variant = process.env.QA_STARTUP_STUB_VARIANT ?? 'ok';
const raw = process.env.AGENT_OPS_ACCEPTANCE_SHARD, checksEnv = process.env.AGENT_OPS_ACCEPTANCE_CHECKS;
const log = entry => appendFileSync(join(dir, 'log.jsonl'), JSON.stringify(entry) + '\n');
const ids = Array.from({length: 180}, (_, i) => i === 0 ? 'run-goal-ignore' : 'synthetic-' + String(i).padStart(3, '0'));
const requested = (checksEnv ?? '').split(',').map(s => s.trim()).filter(Boolean);
const chosen = requested.length > 0 ? ids.filter(id => requested.includes(id)) : ids;
const shard = raw ?? '', m = /^(\d+)\/(\d+)$/u.exec(shard);
const [index, count] = shard === '' ? [0, 1] : m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
if (!(count >= 1 && index < count)) {log({shard: raw ?? null, checks: checksEnv ?? null, rejected: true}); process.stderr.write('bad shard\n'); process.exit(2);}
let concurrent = null;
if (count === 8 && requested.length === 0) {
  const barrier = join(dir, 'barrier'); mkdirSync(barrier, {recursive: true});
  writeFileSync(join(barrier, String(index)), '');
  const deadline = Date.now() + 10000;
  while (readdirSync(barrier).length < 8 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  concurrent = readdirSync(barrier).length >= 8;
}
let mine = chosen.filter((_, i) => i % count === index);
if (count === 8 && variant === 'duplicate' && index === 1) mine = [chosen[0], ...mine.slice(1)];
if (count === 8 && variant === 'missing' && index === 7) mine = mine.slice(1);
const results = mine.map(checkId => ({executionId: 'stub', phase: 'stub', framework: 'node-assert', frameworkVersion: '1', checkId,
  status: count === 8 && variant === 'fail' && index === 3 && checkId === mine[0] ? 'FAIL' : 'PASS', failureClass: 'none', attempts: 1, evidence: ['stub']}));
log({shard: raw ?? null, checks: checksEnv ?? null, rejected: false, concurrent, returned: results.length});
console.log(JSON.stringify({protocolVersion: 1, executionId: 'stub', phase: 'stub', framework: 'node-assert', frameworkVersion: '1', results,
  completed: true, completionEvidence: ['stub'], diagnostics: []}));
if (results.some(r => r.status !== 'PASS')) process.exitCode = 1;
`;

async function runStartupTestAgainstStub(variant) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-qa-startup-stub-'));
  try {
    await mkdir(join(root, 'tests/run'), {recursive: true});
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(root, 'tests/run/startup.acceptance.mjs'), STUB);
    const env = {...process.env, QA_STARTUP_STUB_DIR: root, QA_STARTUP_STUB_VARIANT: variant};
    for (const key of Object.keys(env)) if (key.startsWith('AGENT_OPS_ACCEPTANCE_') || key.startsWith('NODE_TEST')) delete env[key];
    const run = await spawnNode(['--experimental-strip-types', '--no-warnings', '--test', '--test-reporter=tap', STARTUP_TEST],
      {cwd: root, env, timeout: 300_000});
    let entries = [];
    try {entries = (await readFile(join(root, 'log.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
    return {run, entries, barrier: await readdir(join(root, 'barrier')).catch(() => [])};
  } finally {await rm(root, {recursive: true, force: true});}
}
const eightShardEntries = entries => entries.filter(e => e.checks === null && /^\d+\/8$/u.test(e.shard ?? ''));
const tail = run => `exit ${run.code}\n${(run.stdout + run.stderr).slice(-3000)}`;

export const checks = {
  // Case startup-runner-shard-filtering-and-validation
  'startup-shard-applies-after-check-filter': async () => {
    assert.deepEqual(await selected({...ONLY, AGENT_OPS_ACCEPTANCE_SHARD: '1/2'}, '1/2 of one check'), [],
      'shard 1/2 of a one-check filter runs nothing (shard applies after the filter)');
    assert.deepEqual(await selected({...ONLY, AGENT_OPS_ACCEPTANCE_SHARD: '0/2'}, '0/2 of one check'), ['run-goal-ignore']);
    const pair = {AGENT_OPS_ACCEPTANCE_CHECKS: 'run-goal-ignore,controller-stop'};
    const [a, b] = await Promise.all(['0/2', '1/2'].map(s => selected({...pair, AGENT_OPS_ACCEPTANCE_SHARD: s}, `${s} of two checks`)));
    assert.equal(a.length, 1, '0/2 of two checks runs exactly one'); assert.equal(b.length, 1, '1/2 of two checks runs exactly one');
    assert.notEqual(a[0], b[0], 'shards are disjoint');
    assert.deepEqual([...a, ...b].sort(), ['controller-stop', 'run-goal-ignore']);
  },
  'startup-shard-rejects-malformed-values': async () => {
    // Control: a well-formed shard runs, so a runner that cannot start never passes as "rejecting".
    assert.deepEqual(await selected({...ONLY, AGENT_OPS_ACCEPTANCE_SHARD: '0/1'}, 'control 0/1'), ['run-goal-ignore']);
    for (const bad of MALFORMED) {
      const run = await runRunner({...ONLY, AGENT_OPS_ACCEPTANCE_SHARD: bad});
      const label = JSON.stringify(bad);
      assert.notEqual(run.code, 0, `${label} exits nonzero`);
      assert.equal(run.stdout, '', `${label} writes nothing to stdout`);
      assert.match(run.stderr, /shard/iu, `${label} explains the shard error on stderr`);
      assert.ok(!run.stderr.includes('startup: run-goal-ignore'), `${label} rejected before any check runs`);
    }
  },

  // Case startup-runner-unsharded-compatibility
  'startup-unsharded-selection-and-protocol': async () => {
    for (const extra of [{}, {AGENT_OPS_ACCEPTANCE_SHARD: ''}]) {
      const label = 'AGENT_OPS_ACCEPTANCE_SHARD' in extra ? 'empty shard' : 'unset shard';
      const run = await runRunner({...ONLY, ...extra});
      assert.equal(run.code, 0, `${label}: exit code`);
      const report = parseReport(run, label);
      assert.equal(report.protocolVersion, 1);
      assert.equal(report.executionId, 'qa-startup-sharding');
      assert.equal(report.phase, 'qa-phase');
      assert.equal(report.framework, 'node-assert');
      assert.equal(report.frameworkVersion, '1');
      assert.ok(Array.isArray(report.completionEvidence) && report.completionEvidence.length > 0, `${label}: completionEvidence`);
      assert.deepEqual(report.diagnostics, []);
      assert.deepEqual(report.results.map(r => [r.checkId, r.status]), [['run-goal-ignore', 'PASS']], `${label}: selection`);
    }
  },

  // Case startup-test-orchestrates-eight-concurrent-shards (fast stub runner, real startup.test.ts)
  'startup-test-spawns-eight-concurrent-shards': async () => {
    const {run, entries, barrier} = await runStartupTestAgainstStub('ok');
    assert.equal(run.code, 0, `startup.test.ts passes against a correct sharded runner\n${tail(run)}`);
    const eight = eightShardEntries(entries);
    assert.deepEqual(eight.map(e => e.shard).sort(), Array.from({length: 8}, (_, i) => `${i}/8`),
      'one unfiltered process per shard 0/8..7/8');
    assert.deepEqual(barrier.sort(), ['0', '1', '2', '3', '4', '5', '6', '7']);
    assert.ok(eight.every(e => e.concurrent === true), 'all 8 shards were in flight at the same time');
    assert.equal(eight.reduce((n, e) => n + e.returned, 0), TOTAL);
    const filtered = entries.filter(e => e.checks === 'run-goal-ignore');
    for (const shard of [null, '0/2', '1/2']) {
      assert.ok(filtered.some(e => e.shard === shard && !e.rejected), `exercises run-goal-ignore with shard ${shard ?? 'unset'}`);
    }
    for (const bad of ['8/8', 'abc', '0/0', '-1/8']) {
      assert.ok(filtered.some(e => e.shard === bad && e.rejected), `exercises malformed shard ${bad}`);
    }
  },
  'startup-test-enforces-unique-180-coverage': async () => {
    const variants = ['duplicate', 'missing', 'fail'];
    const outcomes = await Promise.all(variants.map(runStartupTestAgainstStub));
    for (const [i, {run, entries}] of outcomes.entries()) {
      // The 8 shards must have run, so the nonzero exit comes from the coverage/status assertions.
      assert.equal(eightShardEntries(entries).length, 8, `${variants[i]}: all 8 shards ran`);
      assert.notEqual(run.code, 0, `startup.test.ts must fail for the ${variants[i]} shard variant\n${tail(run)}`);
    }
  },

  // Case startup-eight-shards-real-execution-and-coverage
  'startup-eight-real-shards-pass-with-180-unique-checks': async () => {
    // Fast pre-check: a runner that ignores the shard would run run-goal-ignore here.
    assert.deepEqual(await selected({...ONLY, AGENT_OPS_ACCEPTANCE_SHARD: '1/2'}, 'pre-check 1/2'), [],
      'runner honours AGENT_OPS_ACCEPTANCE_SHARD');
    const shards = await Promise.all(Array.from({length: 8}, (_, i) => runRunner({AGENT_OPS_ACCEPTANCE_SHARD: `${i}/8`})));
    const ids = [];
    for (const [i, run] of shards.entries()) {
      const report = parseReport(run, `shard ${i}/8`);
      assert.deepEqual(report.results.filter(r => r.status !== 'PASS').map(r => [r.checkId, r.status, r.evidence]), [],
        `shard ${i}/8 has no non-PASS result`);
      assert.equal(run.code, 0, `shard ${i}/8 exit code`);
      ids.push(...report.results.map(r => r.checkId));
    }
    assert.equal(new Set(ids).size, ids.length, 'no checkId runs in two shards');
    assert.equal(ids.length, TOTAL, 'the 8 shards cover exactly 180 checks');
  },

  // Case followup-reviewer-explicit-hang-timeout-preserved
  'followup-explicit-hang-timeout-still-unknown': async () => {
    const source = await readFile(resolve('tests/followup/assessment-checks.mjs'), 'utf8');
    const start = source.indexOf("'followup-assessment-isolation-drift'");
    assert.ok(start >= 0, 'isolation-drift check exists');
    const body = source.slice(start, source.indexOf('\n  })', start));
    assert.match(body, /\[\{hang: true\}\],\s*\{timeoutMs: 2000\}\)[\s\S]{0,200}conclusion, 'UNKNOWN'\);\s*assert\.equal\(\w+\.assessment\.reason, 'timeout'\)/u,
      'explicit hang case keeps timeoutMs 2000 and asserts UNKNOWN / timeout');
    const run = await runRunner({AGENT_OPS_ACCEPTANCE_CHECKS: 'followup-assessment-isolation-drift'});
    const report = parseReport(run, 'isolation-drift');
    assert.deepEqual(report.results.map(r => [r.checkId, r.status]), [['followup-assessment-isolation-drift', 'PASS']],
      `isolation-drift passes: ${JSON.stringify(report.results.map(r => r.evidence))}`);
    assert.equal(run.code, 0);
  }
};
