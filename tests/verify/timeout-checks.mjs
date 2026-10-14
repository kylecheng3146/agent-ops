import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Runner and review time limits. Modules load lazily so an older build fails each
// check as an assertion, never as a crashed runner.
const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const load = async path => {
  try {return await import(pathToFileURL(join(build, path)).href);}
  catch (e) {assert.fail(`${path} is unavailable: ${e.code ?? e.message}`);}
};

/** A one-criterion behavioral task whose runner has a build step that outlives its own 300 ms limit. */
async function slowBuild(check) {
  const {FileTaskStore} = await load('runtime/src/task/store.js');
  const {TaskService} = await load('runtime/src/task/service.js');
  const {FileEvidenceStore, calculateConfigHash} = await load('runtime/src/verify/evidence.js');
  const {VerificationService} = await load('runtime/src/verify/service.js');
  const {NodeVerificationProcessRunner} = await load('runtime/src/verify/spawn.js');
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-timeout-'));
  try {
    const git = (...args) => execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    git('init', '-q'); git('config', 'user.name', 'Timeout fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(root, 'product.mjs'), 'export const value = 0;\n');
    git('add', '.'); git('commit', '-qm', 'baseline');
    const baseline = git('rev-parse', 'HEAD').toString().trim();
    const gitRunner = {run: async args => {
      try {return {exitCode: 0, stdout: git(...args)};} catch {return {exitCode: 1, stdout: Buffer.alloc(0)};}
    }};
    const config = {schemaVersion: 3, profiles: ['core'], verification: {commands: [], acceptanceRunners: [{id: 'acceptance',
      command: process.execPath, args: ['tests/check.mjs'], cwd: '.', adapter: 'generic',
      build: [{command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 300}]}]},
      features: {completionGate: {enabled: false}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};
    const tasks = new TaskService(new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root),
      {completion: {root, gitRunner, base: baseline, loadConfig: async () => config}});
    const materials = [{path: 'tests/check.mjs', role: 'test'}];
    const record = await tasks.create({title: 'Fix value', goal: 'Value equals one', policyConfigHash: calculateConfigHash(config), criteria: [
      {id: 'behavior', description: 'Value equals one', verifierIds: [], acceptance: {mode: 'behavioral', baselineCommit: baseline,
        bindings: [{runnerId: 'acceptance', materials, checkIds: ['behavior'], redCheckIds: ['behavior']}]}},
      {id: 'numeric', description: 'Value stays numeric', verifierIds: [], acceptance: {mode: 'invariant', baselineCommit: baseline,
        bindings: [{runnerId: 'acceptance', materials, checkIds: ['numeric']}]}}]});
    await mkdir(join(root, 'tests'));
    await writeFile(join(root, 'tests/check.mjs'), 'process.exitCode = 0;\n');
    await writeFile(join(root, 'product.mjs'), 'export const value = 1;\n');
    git('add', '.'); git('commit', '-qm', 'candidate');
    const report = await new VerificationService({root, scope: 'project', config, gitRunner, processRunner: new NodeVerificationProcessRunner(),
      taskService: tasks, evidenceStore: new FileEvidenceStore(root, root), trusted: true, base: baseline}).verify(record.task.id);
    await check(report);
  } finally {await rm(root, {recursive: true, force: true});}
}

const raw = {
  'acceptance-step-timeouts': async () => {
    const {ACCEPTANCE_TIMEOUTS} = await load('runtime/src/verify/acceptance-replay.js');
    // Each step kind has its own default; the old shared 60 s cut off npm ci and long runners alike.
    assert.deepEqual(ACCEPTANCE_TIMEOUTS, {setup: 600_000, build: 300_000, testBuild: 300_000, run: 300_000, git: 60_000});
  },

  'acceptance-timeout-detail': () => slowBuild(async report => {
    assert.equal(report.status, 'UNKNOWN', JSON.stringify(report.acceptance));
    const details = (report.acceptance ?? []).map(row => row.detail);
    assert.ok(details.length > 0 && details.every(detail => /build step .+ exceeded 300 ms; raise the step's timeoutMs in verification\.acceptanceRunners\[\]\.build\./u.test(detail ?? '')),
      JSON.stringify(report.acceptance));
  }),

  'review-default-timeout': async () => {
    const {DEFAULT_REVIEW_TIMEOUT_MS} = await load('runtime/src/review/execute.js');
    assert.equal(DEFAULT_REVIEW_TIMEOUT_MS, 1_800_000);
  },

  'review-timeout-not-capped': async () => {
    const execute = await load('runtime/src/review/execute.js');
    assert.equal(typeof execute.stageTimeout, 'function', 'stageTimeout is not exported');
    // A configured reviewer timeout above the default is honored, not cut back to it.
    assert.equal(execute.stageTimeout({timeoutMs: 3_600_000}), 3_600_000);
    assert.equal(execute.stageTimeout({}), execute.DEFAULT_REVIEW_TIMEOUT_MS);
    // Short stages keep their own ceiling, and the chain deadline still wins.
    assert.equal(execute.stageTimeout({timeoutMs: 3_600_000}, 60_000), 60_000);
    assert.equal(execute.stageTimeout({timeoutMs: 3_600_000, deadlineAt: 1_000, now: () => 400}), 600);
  }
};

/** Missing behavior surfaces as a failed assertion, so the baseline is red, not broken. */
export const timeoutChecks = Object.fromEntries(Object.entries(raw).map(([id, check]) => [id, async () => {
  try {await check();}
  catch (e) {
    if (e?.code === 'ERR_ASSERTION') throw e;
    throw new assert.AssertionError({message: `${id}: ${e?.code ?? ''} ${e?.stack ?? e}`});
  }
}]));
