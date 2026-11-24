// Live (watch-hub): a read-only planner could not probe a Swift toolchain or a desktop GUI session, marked them unknown,
// and QA stayed QA_BLOCKED with no way forward. Only an environment observed missing blocks; unknown is advisory.
// Run by tests/qa/acceptance.mjs from a built checkout (dist/, or AGENT_OPS_DEBUG_TEST_BUILD).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
// A missing export is an assertion failure the controller can see, never a collection-time import error.
async function load(path, ...names) {
  const mod = await import(pathToFileURL(join(build, path)).href).catch(() => ({}));
  for (const name of names) assert.ok(name in mod, `${path} must export ${name}`);
  return mod;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const at = '2026-11-23T00:00:00.000Z';
const goal = 'QA must not block on environment a read-only planner cannot probe';
const task = {schemaVersion: 2, id: 'task-qa-unknown-env', title: 'Unknown environment', goal, criteria: [
  {id: 'unit-tests', description: 'Unit tests pass', verifierIds: ['tests']}],
  qa: {schemaVersion: 1, required: true, policyHash: 'a'.repeat(64), enrolledAt: at, enrollment: 'new', late: false}};
const scenarios = {initialState: {applies: true, behavior: 'First plan'}, redo: {na: 'No replay'}, timeBoundary: {na: 'No deadline'},
  identitySwitch: {na: 'One host'}, concurrency: {na: 'Single planner'}};
// No runners: every case is nonmechanical, like a SwiftPM project with exit-code verification only.
const cases = [{id: 'case-unit-tests', criterionIds: ['unit-tests'], surfaceIds: ['planning'], required: true, mode: 'nonmechanical',
  preconditions: ['Swift toolchain'], actions: ['Read the tests'], expected: 'Tests cover the change', bindings: [],
  nonmechanicalReason: 'No configured acceptance runner'}];
const toolchain = {name: 'swift-5-10-macos-14-toolchain', required: true, status: 'unknown', evidence: ['Read-only planning cannot run swift']};
const desktop = {name: 'macos-desktop-session', required: true, status: 'unknown', evidence: ['No GUI session in the planner sandbox']};
const absent = {name: 'browser', required: true, status: 'missing', evidence: ['Observed no installed browser']};
const answer = environment => ({cases, scenarios, environment, questions: []});

function fakePlanner(body) {
  const requests = [];
  return {requests, runner: {start(request) {
    requests.push(request);
    const out = JSON.stringify({structured_output: body, usage: {input_tokens: 1, output_tokens: 1}});
    return {pid: null, stdout: (async function* () {yield Buffer.from(out);})(), stderr: (async function* () {})(),
      completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => {}};
  }}};
}

async function fixture(check) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-qa-unknown-env-'));
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(root, 'source.txt'), 'candidate\n');
    git(['add', '.']); git(['commit', '-qm', 'candidate']);
    const {taskContractHash} = await load('runtime/src/task/contract.js', 'taskContractHash');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const {runQaPlanning} = await load('runtime/src/qa/planning.js', 'runQaPlanning');
    const {qaStatus} = await load('runtime/src/qa/status.js', 'qaStatus');
    const version = {taskId: task.id, goalHash: hash(goal), taskContractHash: taskContractHash(task), treeContractHash: 'b'.repeat(64),
      scopeHash: 'c'.repeat(64), policyHash: task.qa.policyHash, configHash: 'd'.repeat(64), candidateCommit: git(['rev-parse', 'HEAD']).trim(),
      sourceFingerprint: 'e'.repeat(64)};
    const store = new FileQaStore(join(root, '.git'));
    const base = {store, root, version, originalGoal: goal, tasks: [task], scope: 'full', timing: 'late', surfaceIds: ['planning'], runners: [],
      advisory: null, available: ['claude'], implementationHost: 'codex', implementationSessionId: 'developer-session', controllerId: 'controller'};
    const plan = async environment => {
      const planner = fakePlanner(answer(environment));
      const result = await runQaPlanning({...base, runner: planner.runner});
      return {result, request: planner.requests[0]};
    };
    const status = async () => await qaStatus(store, [{task, status: 'active'}], task.id, null);
    await check({store, plan, status});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

export const checks = {
  'qa-environment-blocks-predicate': async () => {
    const {qaEnvironmentBlocks} = await load('runtime/src/qa/policy.js', 'qaEnvironmentBlocks');
    assert.equal(qaEnvironmentBlocks(toolchain), false, 'Required but unknown is advisory');
    assert.equal(qaEnvironmentBlocks(absent), true, 'Required and observed missing blocks');
    assert.equal(qaEnvironmentBlocks({...absent, required: false}), false, 'Optional missing never blocks');
    assert.equal(qaEnvironmentBlocks({...toolchain, status: 'available'}), false);
  },
  'qa-unknown-environment-plan-ready': () => fixture(async ({plan, store}) => {
    const {result} = await plan([toolchain, desktop]);
    assert.equal(result.state, 'plan-ready', 'Unprobed environment does not block planning');
    assert.deepEqual(result.blockers, []);
    const saved = await store.get(result.plan);
    assert.deepEqual(saved.environment.map(e => e.status), ['unknown', 'unknown'], 'The stored plan keeps the observed status');
  }),
  'qa-stored-unknown-plan-unblocked': () => fixture(async ({plan, store, status}) => {
    const {result} = await plan([toolchain, desktop]);
    // A control an earlier release left blocked on the same stored plan: no replanning, no schema change.
    const control = await store.readControl(task.id);
    await store.updateControl(task.id, control.revision, c => ({...c, revision: c.revision + 1, state: 'blocked'}));
    assert.equal((await store.readControl(task.id)).plan.digest, result.plan.digest);
    const blockers = (await status()).blockers;
    assert.deepEqual(blockers.filter(b => b.startsWith('environment:')), [], 'Status names no unknown environment as a blocker');
  }),
  'qa-missing-environment-still-blocks': () => fixture(async ({plan, status}) => {
    const {result} = await plan([toolchain, absent]);
    assert.equal(result.state, 'blocked', 'An observed missing requirement still blocks');
    assert.deepEqual(result.blockers, ['browser: missing']);
    assert.deepEqual((await status()).blockers.filter(b => b.startsWith('environment:')), ['environment:browser']);
  }),
  'qa-planner-observed-absence-rule': () => fixture(async ({plan}) => {
    const {request} = await plan([]);
    const instructions = request.stdin.split('BEGIN UNTRUSTED DATA')[0];
    assert.match(instructions, /missing only for an absence you observed/u, 'Missing means observed absence');
    assert.match(instructions, /cannot probe[^.]*\bunknown\b[^.]*does not block/u, 'Unprobed environment is unknown and advisory');
    assert.match(instructions, /An absent runner is not environment[^.]*nonmechanical/u, 'No runner means a nonmechanical case, not a blocker');
    assert.match(instructions, /only nonmechanical cases need is required false/u, 'Nonmechanical-only environment is not required');
  })
};
