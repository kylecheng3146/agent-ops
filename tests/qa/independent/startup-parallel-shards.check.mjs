// Independent QA (plan 3e1da610…): startup acceptance sharding via AGENT_OPS_ACCEPTANCE_SHARD=i/n, the 8-shard concurrent
// tests/run/startup.test.ts, the 10 s scripted followup reviewer default and atomic review-schema staging in followup-cli-workflows.
// Collected by tests/qa/acceptance.mjs; needs a built checkout (dist/ or AGENT_OPS_DEBUG_TEST_BUILD).
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {copyFile, link, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = resolve('.');
const runnerPath = join(root, 'tests/run/startup.acceptance.mjs');
const activeBuild = () => resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');

/** Runs node; resolves {code, stdout, stderr} for any exit code, rejects only when the child never exited normally. */
function node(args, {cwd = root, env = process.env, timeout = 900_000} = {}) {
  return new Promise((done, fail) => {
    execFile(process.execPath, args, {cwd, env, timeout, maxBuffer: 32 * 1024 * 1024}, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        fail(new Error(`node ${args.join(' ')} did not exit normally (${error.code ?? error.signal}): ${String(stderr).slice(-2000)}`));
        return;
      }
      done({code: error ? error.code : 0, stdout: String(stdout), stderr: String(stderr)});
    });
  });
}

/** Real startup runner; only the selection variables passed in `extra` apply (the controller's own selection never leaks). */
function startup(extra = {}) {
  const env = {...process.env};
  delete env.AGENT_OPS_ACCEPTANCE_CHECKS; delete env.AGENT_OPS_ACCEPTANCE_SHARD;
  return node([runnerPath], {env: {...env, ...extra}});
}

function report(run, label) {
  try {return JSON.parse(run.stdout.trim());}
  catch {assert.fail(`${label}: expected one JSON report on stdout, got ${JSON.stringify(run.stdout.slice(0, 500))}`);}
}

/** Asserts a clean protocol-v1 report with only PASS results and returns the checkIds in report order. */
function passingIds(run, label) {
  assert.equal(run.code, 0, `${label} exits 0; stderr tail: ${run.stderr.slice(-2000)}`);
  const r = report(run, label);
  assert.equal(r.protocolVersion, 1, `${label} protocolVersion`);
  assert.equal(r.completed, true, `${label} completed`);
  assert.deepEqual(r.diagnostics, [], `${label} diagnostics`);
  assert.ok(Array.isArray(r.results), `${label} results is an array`);
  assert.deepEqual(r.results.filter(x => x.status !== 'PASS').map(x => `${x.checkId}:${x.status}`), [], `${label} reports only PASS`);
  return r.results.map(x => x.checkId);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Instrumented stand-in for tests/run/startup.acceptance.mjs used to drive the candidate tests/run/startup.test.ts in isolation.
// 180 checks; enforces AGENT_OPS_ACCEPTANCE_CHECKS then AGENT_OPS_ACCEPTANCE_SHARD; logs pid/start/end/shard/count per run.
// Faults are injected only into the full (unfiltered) sharded run, so the filter/malformed tests of startup.test.ts stay green.
const STUB = String.raw`
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
const start = Date.now();
const here = dirname(fileURLToPath(import.meta.url));
const {fault, delayMs} = JSON.parse(readFileSync(join(here, 'qa-parallel-stub.json'), 'utf8'));
const all = ['run-goal-ignore', ...Array.from({length: 179}, (_, i) => 'qa-parallel-stub-' + String(i + 1).padStart(3, '0'))];
const requested = (process.env.AGENT_OPS_ACCEPTANCE_CHECKS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const selected = requested.length > 0 ? all.filter(id => requested.includes(id)) : all;
const shard = process.env.AGENT_OPS_ACCEPTANCE_SHARD ?? '';
const m = /^(\d+)\/(\d+)$/u.exec(shard);
const [index, count] = shard === '' ? [0, 1] : m ? [Number(m[1]), Number(m[2])] : [NaN, NaN];
if (!(count >= 1 && index < count)) {process.stderr.write('stub: invalid shard ' + JSON.stringify(shard) + '\n'); process.exit(2);}
const sharded = shard !== '';
if (sharded) await new Promise(r => setTimeout(r, delayMs));
let ids = selected.filter((_, i) => i % count === index);
let completed = true, failing = null;
if (sharded && requested.length === 0) {
  // duplicate: shard 0 swaps its last check for one owned by shard 1 (total stays 180, one id twice, one missing).
  if (fault === 'duplicate' && index === 0) ids = [...ids.slice(0, -1), selected[1]];
  if (fault === 'omit' && index === count - 1) ids = ids.slice(0, -1);
  if (fault === 'fail' && index === 3) failing = ids[0];
  if (fault === 'incomplete' && index === 5) completed = false;
}
const results = ids.map(checkId => ({executionId: 'qa-stub', phase: 'candidate', framework: 'node-assert', frameworkVersion: '1', checkId,
  status: checkId === failing ? 'FAIL' : 'PASS', failureClass: checkId === failing ? 'assertion-failed' : 'none', attempts: 1, evidence: ['stub']}));
mkdirSync(join(here, 'qa-parallel-log'), {recursive: true});
writeFileSync(join(here, 'qa-parallel-log', process.pid + '-' + start + '.json'), JSON.stringify({pid: process.pid, start, end: Date.now(),
  checks: process.env.AGENT_OPS_ACCEPTANCE_CHECKS ?? null, shard: process.env.AGENT_OPS_ACCEPTANCE_SHARD ?? null, count: results.length}));
console.log(JSON.stringify({protocolVersion: 1, executionId: 'qa-stub', phase: 'candidate', framework: 'node-assert', frameworkVersion: '1',
  results, completed, completionEvidence: ['stub'], diagnostics: []}));
if (failing) process.exitCode = 1;
`;

/** Copies the candidate tests/run/startup.test.ts beside the stub in a disposable workspace and runs it under node --test. */
async function withStubbedStartupTest(settings, check) {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-ops-qa-parallel-shards-'));
  try {
    const dir = join(workspace, 'tests/run');
    await mkdir(dir, {recursive: true});
    await copyFile(join(root, 'tests/run/startup.test.ts'), join(dir, 'startup.test.ts'));
    await writeFile(join(dir, 'startup.acceptance.mjs'), STUB);
    await writeFile(join(dir, 'qa-parallel-stub.json'), JSON.stringify(settings));
    await writeFile(join(workspace, 'package.json'), JSON.stringify({private: true, type: 'module'}));
    const env = {...process.env};
    for (const key of ['AGENT_OPS_ACCEPTANCE_CHECKS', 'AGENT_OPS_ACCEPTANCE_SHARD', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete env[key];
    const strip = process.features?.typescript ? [] : ['--experimental-strip-types'];
    const run = await node([...strip, '--test', 'tests/run/startup.test.ts'], {cwd: workspace, env, timeout: 300_000});
    const logDir = join(dir, 'qa-parallel-log');
    const names = await readdir(logDir).catch(() => []);
    const log = await Promise.all(names.map(async n => JSON.parse(await readFile(join(logDir, n), 'utf8'))));
    await check({run, log, full: log.filter(e => e.checks === null && e.shard !== null && e.shard !== '')});
  } finally {
    await rm(workspace, {recursive: true, force: true});
  }
}
const tail = run => `stdout:\n${run.stdout.slice(-3000)}\nstderr:\n${run.stderr.slice(-2000)}`;
const eightShards = Array.from({length: 8}, (_, i) => `${i}/8`);

/** Text of every `reviewer(...)` call argument list in `source` (balanced parentheses). */
function reviewerCallArgs(source) {
  const calls = [];
  for (const m of source.matchAll(/\breviewer\(/gu)) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < source.length && depth > 0; i++) depth += source[i] === '(' ? 1 : source[i] === ')' ? -1 : 0;
    calls.push(source.slice(m.index + m[0].length, i - 1));
  }
  return calls;
}

export const checks = {
  'qa-shard-modulo-partition': async () => {
    const subset = 'run-goal-ignore,controller-stop,source-and-runtime-safety,live-worktree-heartbeats';
    const ordered = passingIds(await startup({AGENT_OPS_ACCEPTANCE_CHECKS: subset}), 'unsharded 4-check selection');
    assert.deepEqual([...ordered].sort(), subset.split(',').sort(), 'unsharded selection runs each requested check exactly once');
    for (const n of [2, 3]) {
      const runs = await Promise.all(Array.from({length: n}, (_, i) =>
        startup({AGENT_OPS_ACCEPTANCE_CHECKS: subset, AGENT_OPS_ACCEPTANCE_SHARD: `${i}/${n}`})));
      const seen = [];
      for (const [i, run] of runs.entries()) {
        const ids = passingIds(run, `shard ${i}/${n}`);
        assert.deepEqual(ids, ordered.filter((_, k) => k % n === i), `shard ${i}/${n} runs exactly the checks at index ≡ ${i} (mod ${n})`);
        for (const id of ids) assert.ok(!seen.includes(id), `${id} ran in more than one of ${n} shards`);
        seen.push(...ids);
      }
      assert.deepEqual([...seen].sort(), [...ordered].sort(), `${n} shards together cover the unsharded selection`);
    }
  },

  'qa-unsharded-runner-compatible': async () => {
    for (const [label, extra] of [['SHARD unset', {}], ['SHARD empty', {AGENT_OPS_ACCEPTANCE_SHARD: ''}]]) {
      const run = await startup({AGENT_OPS_ACCEPTANCE_CHECKS: 'run-goal-ignore', ...extra});
      assert.deepEqual(passingIds(run, label), ['run-goal-ignore'], `${label}: exactly the requested check`);
      const [result] = report(run, label).results;
      assert.equal(result.status, 'PASS', `${label}: PASS`);
      assert.equal(result.framework, 'node-assert', `${label}: framework`);
    }
  },

  'qa-shard-after-check-filter': async () => {
    const only = {AGENT_OPS_ACCEPTANCE_CHECKS: 'run-goal-ignore'};
    const [first, second] = await Promise.all([startup({...only, AGENT_OPS_ACCEPTANCE_SHARD: '0/2'}),
      startup({...only, AGENT_OPS_ACCEPTANCE_SHARD: '1/2'})]);
    assert.deepEqual(passingIds(first, 'shard 0/2'), ['run-goal-ignore'], 'shard 0/2 holds the single filtered check');
    assert.deepEqual(passingIds(second, 'shard 1/2'), [], 'shard 1/2 of a one-check selection is empty yet completed');
  },

  'qa-malformed-shard-rejected': async () => {
    for (const bad of ['8/8', 'abc', '0/0', '-1/8']) {
      const run = await startup({AGENT_OPS_ACCEPTANCE_CHECKS: 'run-goal-ignore', AGENT_OPS_ACCEPTANCE_SHARD: bad});
      assert.notEqual(run.code, 0, `${JSON.stringify(bad)} exits nonzero`);
      assert.match(run.stderr, /shard/iu, `${JSON.stringify(bad)} writes a shard error diagnostic to stderr`);
      assert.doesNotMatch(run.stdout, /protocolVersion|"PASS"/u, `${JSON.stringify(bad)} prints no report or PASS result`);
      assert.doesNotMatch(run.stderr, /startup: run-goal-ignore/u, `${JSON.stringify(bad)} executes no check`);
    }
  },

  'qa-startup-test-eight-concurrent-shards': () => withStubbedStartupTest({fault: null, delayMs: 3000}, async ({run, log, full}) => {
    assert.equal(run.code, 0, `startup.test.ts passes against a healthy runner\n${tail(run)}`);
    assert.deepEqual(full.map(e => e.shard).sort(), eightShards, `full run uses shards 0/8..7/8 once each; log ${JSON.stringify(log)}`);
    assert.equal(full.reduce((sum, e) => sum + e.count, 0), 180, 'the 8 shards return 180 checks in total');
    const latestStart = Math.max(...full.map(e => e.start)), earliestEnd = Math.min(...full.map(e => e.end));
    assert.ok(latestStart < earliestEnd, `the 8 shard processes overlap in wall-clock time: ${JSON.stringify(full)}`);
  }),

  'qa-startup-test-coverage-and-failure-guards': async () => {
    // Control first: the same workspace without a fault passes, so each nonzero exit below is caused by its fault.
    await withStubbedStartupTest({fault: null, delayMs: 0}, async ({run, full}) => {
      assert.equal(run.code, 0, `control run passes\n${tail(run)}`);
      assert.deepEqual(full.map(e => e.shard).sort(), eightShards, 'control run executes the 8 shards');
    });
    for (const fault of ['duplicate', 'omit', 'fail', 'incomplete']) {
      await withStubbedStartupTest({fault, delayMs: 0}, async ({run, log, full}) => {
        assert.deepEqual(full.map(e => e.shard).sort(), eightShards, `${fault}: fault reached all 8 shards; log ${JSON.stringify(log)}`);
        assert.notEqual(run.code, 0, `${fault}: startup.test.ts must fail\n${tail(run)}`);
      });
    }
  },

  'qa-followup-reviewer-timeout-and-callers': async () => {
    const {reviewer} = await import(pathToFileURL(join(root, 'tests/followup/assessment-checks.mjs')).href);
    const unused = {root: join(tmpdir(), 'agent-ops-qa-parallel-unused')};
    assert.equal((await reviewer(unused)).options.timeoutMs, 10000, `default timeoutMs on ${process.platform}`);
    assert.equal((await reviewer(unused, [], {timeoutMs: 2000})).options.timeoutMs, 2000, 'explicit timeoutMs override is kept');
    const assessment = await readFile(join(root, 'tests/followup/assessment-checks.mjs'), 'utf8');
    assert.ok(reviewerCallArgs(assessment).some(a => /hang:\s*true/u.test(a) && /timeoutMs:\s*2000\b/u.test(a)),
      'the hang case still passes an explicit {timeoutMs: 2000}');
    const repairCalls = reviewerCallArgs(await readFile(join(root, 'tests/followup/repair-checks.mjs'), 'utf8'));
    assert.ok(repairCalls.length > 0, 'repair-checks calls reviewer()');
    assert.deepEqual(repairCalls.filter(a => /timeoutMs/u.test(a)), [], 'repair-checks reviewer() callers inherit the default timeout');
    const run = await startup({AGENT_OPS_ACCEPTANCE_CHECKS: 'followup-assessment-isolation-drift'});
    assert.deepEqual(passingIds(run, 'followup-assessment-isolation-drift'), ['followup-assessment-isolation-drift']);
  },

  'qa-followup-cli-atomic-schema-staging': async () => {
    const build = activeBuild();
    const disposable = await mkdtemp(join(tmpdir(), 'agent-ops-qa-schema-build-'));
    try {
      for (const part of ['packages', 'runtime']) await symlink(join(build, part), join(disposable, part), 'dir');
      const schemas = join(disposable, 'schemas'), schema = join(schemas, 'review-report.schema.json');
      const sentinel = `{"qa-sentinel": "${process.pid}-${Date.now()}"}\n`;
      await mkdir(schemas);
      await writeFile(schema, sentinel);
      await link(schema, `${schema}.prev`);
      const before = (await stat(schema)).ino;
      const run = await startup({AGENT_OPS_DEBUG_TEST_BUILD: disposable, AGENT_OPS_ACCEPTANCE_CHECKS: 'followup-cli-workflows'});
      assert.deepEqual(passingIds(run, 'followup-cli-workflows'), ['followup-cli-workflows']);
      assert.equal(await readFile(schema, 'utf8'), await readFile(join(root, 'schemas/review-report.schema.json'), 'utf8'),
        'staged schema matches the repository schema');
      assert.notEqual((await stat(schema)).ino, before, 'schema was replaced by rename (new inode), not rewritten in place');
      assert.equal(await readFile(`${schema}.prev`, 'utf8'), sentinel, 'the hard-linked old inode is untouched (no truncation)');
      assert.deepEqual((await readdir(schemas)).filter(n => n.endsWith('.tmp')), [], 'no staging .tmp file is left behind');
    } finally {
      await rm(disposable, {recursive: true, force: true});
    }
  }
};
