// Independent QA: tests/run/startup.acceptance.mjs shards its selected checks with AGENT_OPS_ACCEPTANCE_SHARD=i/n after the
// AGENT_OPS_ACCEPTANCE_CHECKS filter, tests/run/startup.test.ts runs 8 shards concurrently and guards full disjoint coverage,
// and the scripted followup reviewer defaults to a 10 s timeout.
// Run by tests/qa/acceptance.mjs from a built checkout (dist/, or AGENT_OPS_DEBUG_TEST_BUILD).
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = resolve('.');
const runnerPath = join(root, 'tests/run/startup.acceptance.mjs');

/** Spawns a node child; resolves with exit code, stdout and stderr (never rejects on a nonzero exit). */
function node(args, {cwd = root, env, timeout = 900_000} = {}) {
  return new Promise((done, fail) => {
    execFile(process.execPath, args, {cwd, env, timeout, maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        fail(new Error(`${args.join(' ')} did not exit normally (${error.code ?? error.signal}): ${stderr}`));
        return;
      }
      done({code: error ? error.code : 0, stdout, stderr});
    });
  });
}

/** Runs the real startup runner with only the given selection variables (the controller's own CHECKS must not leak in). */
function startup(extra) {
  const env = {...process.env};
  delete env.AGENT_OPS_ACCEPTANCE_CHECKS; delete env.AGENT_OPS_ACCEPTANCE_SHARD;
  return node([runnerPath], {env: {...env, ...extra}});
}
const parse = (stdout, label) => {
  try {return JSON.parse(stdout.trim());}
  catch {assert.fail(`${label} prints one JSON report on stdout, got ${JSON.stringify(stdout.slice(0, 500))}`);}
};
function passing(run, label) {
  assert.equal(run.code, 0, `${label} exits 0; stderr: ${run.stderr.slice(-2000)}`);
  const report = parse(run.stdout, label);
  assert.equal(report.protocolVersion, 1, `${label} protocolVersion`);
  assert.equal(report.completed, true, `${label} completed`);
  assert.deepEqual(report.diagnostics, [], `${label} diagnostics`);
  assert.ok(Array.isArray(report.results), `${label} results array`);
  assert.deepEqual(report.results.filter(r => r.status !== 'PASS').map(r => r.checkId), [], `${label} has only PASS results`);
  return report.results.map(r => r.checkId);
}

// ---- Instrumented stand-in for tests/run/startup.acceptance.mjs, used to exercise tests/run/startup.test.ts in isolation.
const STUB = String.raw`
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const settings = JSON.parse(readFileSync(join(here, 'qa-stub-settings.json'), 'utf8'));
const start = Date.now();
const all = ['run-goal-ignore', ...Array.from({length: 179}, (_, i) => 'qa-stub-check-' + String(i + 1).padStart(3, '0'))];
const requested = (process.env.AGENT_OPS_ACCEPTANCE_CHECKS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const selected = requested.length > 0 ? all.filter(id => requested.includes(id)) : all;
const shard = process.env.AGENT_OPS_ACCEPTANCE_SHARD;
const match = /^(\d+)\/(\d+)$/u.exec(shard ?? '');
const [index, count] = shard === undefined || shard === '' ? [0, 1] : match ? [Number(match[1]), Number(match[2])] : [NaN, NaN];
if (!(count >= 1 && index < count)) {process.stderr.write('bad shard\n'); process.exit(2);}
const sharded = !(shard === undefined || shard === '');
if (sharded) await new Promise(r => setTimeout(r, settings.delayMs));
let ids = selected.filter((_, i) => i % count === index);
let completed = true, failed = null;
// Faults only touch the full 180-check sharded run, never the filtered or unsharded runs.
const full = sharded && requested.length === 0;
if (full && settings.fault === 'duplicate' && index === 0) ids = [...ids, selected[1]];
if (full && settings.fault === 'omit' && index === count - 1) ids = ids.slice(0, -1);
if (full && settings.fault === 'fail' && index === 3) failed = ids[0];
if (full && settings.fault === 'incomplete' && index === 5) completed = false;
const results = ids.map(checkId => ({executionId: 'qa-stub', phase: 'candidate', framework: 'node-assert', frameworkVersion: '1', checkId,
  status: checkId === failed ? 'FAIL' : 'PASS', failureClass: checkId === failed ? 'assertion-failed' : 'none', attempts: 1, evidence: ['stub']}));
mkdirSync(join(here, 'qa-stub-log'), {recursive: true});
writeFileSync(join(here, 'qa-stub-log', process.pid + '-' + start + '.json'), JSON.stringify({pid: process.pid, start, end: Date.now(),
  checks: process.env.AGENT_OPS_ACCEPTANCE_CHECKS ?? null, shard: shard ?? null, count: results.length}));
console.log(JSON.stringify({protocolVersion: 1, executionId: 'qa-stub', phase: 'candidate', framework: 'node-assert', frameworkVersion: '1',
  results, completed, completionEvidence: ['stub'], diagnostics: []}));
if (failed) process.exitCode = 1;
`;

/** Copies the candidate startup.test.ts beside the stub runner in a disposable workspace and runs it with node --test. */
async function withStubWorkspace(settings, check) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-ops-qa-startup-shards-'));
  try {
    const dir = join(workspace, 'tests/run');
    await mkdir(dir, {recursive: true});
    await copyFile(join(root, 'tests/run/startup.test.ts'), join(dir, 'startup.test.ts'));
    await writeFile(join(dir, 'startup.acceptance.mjs'), STUB);
    await writeFile(join(dir, 'qa-stub-settings.json'), JSON.stringify(settings));
    await writeFile(join(workspace, 'package.json'), JSON.stringify({type: 'module', private: true}));
    const env = {...process.env};
    delete env.AGENT_OPS_ACCEPTANCE_CHECKS; delete env.AGENT_OPS_ACCEPTANCE_SHARD; delete env.NODE_TEST_CONTEXT;
    const strip = process.features?.typescript ? [] : ['--experimental-strip-types'];
    const run = await node([...strip, '--test', 'tests/run/startup.test.ts'], {cwd: workspace, env, timeout: 300_000});
    const logDir = join(dir, 'qa-stub-log');
    const names = await readdir(logDir).catch(() => []);
    const log = await Promise.all(names.map(async n => JSON.parse(await readFile(join(logDir, n), 'utf8'))));
    await check({run, log});
  } finally {
    await rm(workspace, {recursive: true, force: true});
  }
}
const fullShardRuns = log => log.filter(e => e.checks === null && e.shard !== null && e.shard !== '');
const output = run => `${run.stdout.slice(-3000)}\n${run.stderr.slice(-2000)}`;

export const checks = {
  'startup-runner-shard-partition': async () => {
    const subset = 'run-goal-ignore,controller-stop,source-and-runtime-safety,live-worktree-heartbeats';
    const ordered = passing(await startup({AGENT_OPS_ACCEPTANCE_CHECKS: subset}), 'unsharded subset');
    assert.deepEqual([...ordered].sort(), subset.split(',').sort(), 'the unsharded subset selects each requested check once');
    for (const n of [2, 3]) {
      const runs = await Promise.all(Array.from({length: n}, (_, i) =>
        startup({AGENT_OPS_ACCEPTANCE_CHECKS: subset, AGENT_OPS_ACCEPTANCE_SHARD: `${i}/${n}`})));
      const all = [];
      for (const [i, run] of runs.entries()) {
        const ids = passing(run, `shard ${i}/${n}`);
        assert.deepEqual(ids, ordered.filter((_, k) => k % n === i), `shard ${i}/${n} runs exactly the checks at index ≡ ${i} mod ${n}`);
        all.push(...ids);
      }
      assert.equal(new Set(all).size, all.length, `no check runs in two of ${n} shards`);
      assert.deepEqual([...all].sort(), [...ordered].sort(), `${n} shards together run the whole selection`);
    }
  },

  'startup-runner-unsharded-compatible': async () => {
    const run = await startup({AGENT_OPS_ACCEPTANCE_CHECKS: 'run-goal-ignore'});
    assert.deepEqual(passing(run, 'unsharded run-goal-ignore'), ['run-goal-ignore']);
    const report = parse(run.stdout, 'unsharded');
    assert.equal(report.results[0].status, 'PASS');
    assert.equal(report.results[0].framework, 'node-assert');
  },

  'startup-runner-shard-after-check-filter': async () => {
    const only = {AGENT_OPS_ACCEPTANCE_CHECKS: 'run-goal-ignore'};
    const [first, second] = await Promise.all([startup({...only, AGENT_OPS_ACCEPTANCE_SHARD: '0/2'}),
      startup({...only, AGENT_OPS_ACCEPTANCE_SHARD: '1/2'})]);
    assert.deepEqual(passing(first, 'shard 0/2'), ['run-goal-ignore'], 'shard 0/2 runs the one filtered check');
    assert.deepEqual(passing(second, 'shard 1/2'), [], 'shard 1/2 of a one-check selection is empty');
  },

  'startup-runner-malformed-shard-rejected': async () => {
    for (const bad of ['8/8', 'abc', '0/0', '-1/8']) {
      const run = await startup({AGENT_OPS_ACCEPTANCE_CHECKS: 'run-goal-ignore', AGENT_OPS_ACCEPTANCE_SHARD: bad});
      assert.notEqual(run.code, 0, `${bad} exits nonzero`);
      assert.doesNotMatch(run.stderr, /startup: run-goal-ignore/u, `${bad} starts no check`);
      assert.doesNotMatch(run.stdout, /"PASS"/u, `${bad} reports no PASS result`);
    }
  },

  'startup-test-concurrent-eight-shards': () => withStubWorkspace({fault: null, delayMs: 3000}, async ({run, log}) => {
    assert.equal(run.code, 0, `startup.test.ts passes against a correct runner:\n${output(run)}`);
    const shards = fullShardRuns(log);
    assert.deepEqual(shards.map(e => e.shard).sort(), Array.from({length: 8}, (_, i) => `${i}/8`),
      `the full suite runs as shards 0/8..7/8, each once; invocations: ${JSON.stringify(log)}`);
    assert.equal(shards.reduce((sum, e) => sum + e.count, 0), 180, 'the 8 shards report 180 checks together');
    const latestStart = Math.max(...shards.map(e => e.start)), earliestEnd = Math.min(...shards.map(e => e.end));
    assert.ok(latestStart < earliestEnd, `all 8 shard processes overlap in wall-clock time: ${JSON.stringify(shards)}`);
  }),

  'startup-test-coverage-and-failure-guards': async () => {
    // Control: the same workspace without a fault passes, so a nonzero exit below comes from the injected fault.
    await withStubWorkspace({fault: null, delayMs: 0}, async ({run}) => {
      assert.equal(run.code, 0, `control run passes:\n${output(run)}`);
    });
    for (const fault of ['duplicate', 'omit', 'fail', 'incomplete']) {
      await withStubWorkspace({fault, delayMs: 0}, async ({run, log}) => {
        assert.equal(fullShardRuns(log).length, 8, `${fault}: the fault reached the sharded run; invocations: ${JSON.stringify(log)}`);
        assert.notEqual(run.code, 0, `${fault}: startup.test.ts must fail:\n${output(run)}`);
      });
    }
  },

  'followup-reviewer-timeout-defaults': async () => {
    const {reviewer} = await import(pathToFileURL(join(root, 'tests/followup/assessment-checks.mjs')).href);
    const unused = {root: join(tmpdir(), 'agent-ops-qa-unused-root')};
    assert.equal((await reviewer(unused)).options.timeoutMs, 10000, `default timeoutMs on ${process.platform}`);
    assert.equal((await reviewer(unused, [], {timeoutMs: 2000})).options.timeoutMs, 2000, 'explicit override is kept');
    const source = await readFile(join(root, 'tests/followup/assessment-checks.mjs'), 'utf8');
    assert.match(source, /reviewer\(f, \[\{hang: true\}\], \{timeoutMs: 2000\}\)/u, 'the hang case still passes an explicit 2000 ms timeout');
    const run = await startup({AGENT_OPS_ACCEPTANCE_CHECKS: 'followup-assessment-isolation-drift'});
    assert.deepEqual(passing(run, 'followup-assessment-isolation-drift'), ['followup-assessment-isolation-drift']);
  }
};
