// Independent QA: the QA planner capture limit is an inclusive 1 MiB for every read-only planner host (agy, claude, codex).
// An answer of exactly 1048576 bytes is planned, a 1048577-byte answer fails closed without saving or overwriting a plan,
// and replanning after a truncated attempt recovers. Run by tests/qa/acceptance.mjs from a built checkout
// (dist/, or AGENT_OPS_DEBUG_TEST_BUILD). Unexpected rejections become assertion failures, never infrastructure errors.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const MiB = 1024 * 1024;
const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
async function load(path, ...names) {
  const mod = await import(pathToFileURL(join(build, path)).href).catch(() => ({}));
  for (const name of names) assert.ok(name in mod, `${path} must export ${name}`);
  return mod;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const at = '2026-11-24T00:00:00.000Z';
const goal = 'QA planning keeps a 1 MiB planner answer instead of truncating it at 64 KiB';
const task = {schemaVersion: 2, id: 'task-qa-output-limit', title: 'Planner output limit', goal, criteria: [
  {id: 'planner-large-output', description: 'Planner answers up to 1 MiB are planned', verifierIds: ['tests']},
  {id: 'planner-over-limit', description: 'Planner answers over 1 MiB fail closed', verifierIds: ['tests']}],
  qa: {schemaVersion: 1, required: true, policyHash: 'a'.repeat(64), enrolledAt: at, enrollment: 'new', late: false}};
const runners = [{id: 'independent-qa', adapter: 'generic', command: 'node', args: ['tests/qa/acceptance.mjs'], cwd: '.'}];
const scenarios = {initialState: {applies: true, behavior: 'First planning run'}, redo: {applies: true, behavior: 'Replanning'},
  timeBoundary: {na: 'No deadline'}, identitySwitch: {applies: true, behavior: 'Same limit for every host'}, concurrency: {na: 'Single planner'}};
const binding = {runnerId: 'independent-qa', checkIds: ['limit-check'], redCheckIds: ['limit-check'],
  materials: [{path: 'tests/qa/independent/limit.check.mjs', role: 'test'}]};
const answer = () => ({scenarios, environment: [], questions: [], cases: [
  {id: 'case-large', criterionIds: ['planner-large-output'], surfaceIds: ['planning'], required: true, mode: 'behavioral',
    preconditions: ['Built'], actions: ['Plan a large answer'], expected: 'Planned', bindings: [binding]},
  {id: 'case-over', criterionIds: ['planner-over-limit'], surfaceIds: ['planning'], required: true, mode: 'invariant',
    preconditions: ['Built'], actions: ['Plan an oversized answer'], expected: 'Fails closed', bindings: [binding]}]});
const caseIds = ['case-large', 'case-over'];

/** Pads `envelope(pad)` with ASCII so its UTF-8 length is exactly `bytes`; codex pads whitespace between JSON tokens. */
function stdoutFor(host, body, bytes) {
  const usage = {input_tokens: 1, output_tokens: 1};
  const envelope = {
    agy: pad => JSON.stringify({status: 'SUCCESS', response: pad, structured_output: body, usage}),
    claude: pad => JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: pad, structured_output: body, usage}),
    codex: pad => `{${pad.replaceAll('x', ' ')}${JSON.stringify(body).slice(1)}`,
  }[host];
  const out = envelope('x'.repeat(bytes - Buffer.byteLength(envelope(''))));
  assert.equal(Buffer.byteLength(out), bytes, `fixture: ${host} stdout must be exactly ${bytes} bytes`);
  return Buffer.from(out);
}
/** Test-only planner transport streaming `stdout` in 64 KiB chunks, so capture spans many writes. */
function planner(stdout) {
  const requests = [];
  return {requests, runner: {start(request) {
    requests.push(request);
    return {pid: null, stdout: (async function* () {
      for (let i = 0; i < stdout.length; i += 65536) yield stdout.subarray(i, i + 65536);
    })(), stderr: (async function* () {})(), completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => {}};
  }}};
}

async function fixture(check) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-qa-output-limit-'));
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(root, 'source.txt'), 'candidate\n');
    git(['add', '.']); git(['commit', '-qm', 'candidate']);
    const {taskContractHash} = await load('runtime/src/task/contract.js', 'taskContractHash');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const {runQaPlanning} = await load('runtime/src/qa/planning.js', 'runQaPlanning');
    const version = {taskId: task.id, goalHash: hash(goal), taskContractHash: taskContractHash(task), treeContractHash: 'b'.repeat(64),
      scopeHash: 'c'.repeat(64), policyHash: task.qa.policyHash, configHash: 'd'.repeat(64), candidateCommit: git(['rev-parse', 'HEAD']).trim(),
      sourceFingerprint: 'e'.repeat(64)};
    const store = new FileQaStore(join(root, '.git'));
    const base = {store, root, version, originalGoal: goal, tasks: [task], scope: 'full', timing: 'late', surfaceIds: ['planning'], runners,
      advisory: null, implementationSessionId: 'developer-session', controllerId: 'controller'};
    /** One planning run on `host` answering `bytes` of stdout; resolves to the result or the rejection, never throws. */
    const plan = async (host, bytes) => {
      const fake = planner(stdoutFor(host, answer(), bytes));
      // A different implementation host keeps host selection on `host` without a fallback.
      const outcome = await runQaPlanning({...base, available: [host], implementationHost: host === 'codex' ? 'claude' : 'codex',
        runner: fake.runner}).catch(error => error);
      assert.equal(fake.requests.length, 1, `Exactly one ${host} planner session starts`);
      return outcome;
    };
    const control = () => store.readControl(task.id);
    /** The plan was saved: no rejection, plan-ready, control points at it, and the stored plan keeps the submitted cases. */
    const assertPlanned = async (outcome, label) => {
      assert.equal(outcome?.code, undefined, `${label} must be planned, got ${outcome?.code}: ${outcome?.message}`);
      assert.equal(outcome.state, 'plan-ready', `${label} state`);
      const saved = await control();
      assert.deepEqual(saved.plan, outcome.plan, `${label}: control.plan is the returned plan`);
      assert.equal(saved.state, 'plan-ready');
      assert.equal(saved.owner, null, `${label}: owner released`);
      assert.deepEqual((await store.get(outcome.plan)).cases.map(c => c.id), caseIds, `${label}: stored plan keeps both cases`);
    };
    /** Failed closed: QA_PLAN_NOT_RUN, control blocked with the owner released and `plan` left as given. */
    const assertFailedClosed = async (outcome, plan, label) => {
      assert.equal(outcome?.code, 'QA_PLAN_NOT_RUN', `${label} must fail closed, got ${outcome?.code ?? outcome?.state}`);
      const saved = await control();
      assert.equal(saved.state, 'blocked', `${label}: control blocked`);
      assert.equal(saved.owner, null, `${label}: owner released`);
      assert.deepEqual(saved.plan, plan, `${label}: plan ${plan === null ? 'not saved' : 'preserved'}`);
    };
    await check({store, plan, control, assertPlanned, assertFailedClosed});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

export const checks = {
  'qa-plan-exact-1mib-boundary': () => fixture(async ({plan, assertPlanned}) => {
    await assertPlanned(await plan('agy', MiB), 'An agy answer of exactly 1048576 bytes');
  }),
  'qa-plan-large-output-all-hosts': async () => {
    for (const host of ['agy', 'claude', 'codex'])
      await fixture(async ({plan, assertPlanned}) => assertPlanned(await plan(host, MiB - 1024), `A ${host} answer of 1 MiB - 1 KiB`));
  },
  'qa-plan-replan-after-truncated-attempt': () => fixture(async ({plan, assertPlanned, assertFailedClosed}) => {
    await assertFailedClosed(await plan('agy', MiB + 1), null, 'An agy answer of 1048577 bytes');
    await assertPlanned(await plan('agy', MiB - 1024), 'Replanning with an agy answer of 1 MiB - 1 KiB');
  }),
  'qa-plan-over-1mib-by-one-byte': () => fixture(async ({store, plan, assertFailedClosed}) => {
    const outcome = await plan('agy', MiB + 1);
    await assertFailedClosed(outcome, null, 'An agy answer of 1048577 bytes');
    assert.match(outcome.message, /\(none\)/u, 'The truncation is reported as the planner not answering (none)');
    const directory = join(store.directory, 'planning-diagnostics');
    const files = await readdir(directory).catch(() => []);
    assert.equal(files.length, 1, 'One private planning diagnostic is written');
    const diagnostic = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
    assert.equal(typeof diagnostic.stdout, 'string');
    assert.ok(Buffer.byteLength(diagnostic.stdout) <= 32768, 'The diagnostic keeps at most 32 KiB of stdout');
  }),
  'qa-plan-over-1mib-preserves-prior-plan': () => fixture(async ({plan, assertPlanned, assertFailedClosed}) => {
    const prior = await plan('agy', 8 * 1024);
    await assertPlanned(prior, 'A small agy answer');
    await assertFailedClosed(await plan('agy', MiB + 1), prior.plan, 'Replanning with an agy answer of 1048577 bytes');
  }),
};
