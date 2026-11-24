// Independent QA: a QA planner answer larger than the 64 KiB spawn default (agy prints its transcript and the final
// JSON) is still parsed and planned, while an answer over the 1 MiB capture limit keeps failing closed.
// Run by tests/qa/acceptance.mjs from a built checkout (dist/, or AGENT_OPS_DEBUG_TEST_BUILD).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
// A missing or incomplete build is an assertion failure the controller can see, never a collection-time import error.
async function load(path, ...names) {
  const mod = await import(pathToFileURL(join(build, path)).href).catch(() => ({}));
  for (const name of names) assert.ok(name in mod, `${path} must export ${name}`);
  return mod;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const at = '2026-11-23T00:00:00.000Z';
const goal = 'Release 1.4.1 after fixing why QA got stuck';
const task = {schemaVersion: 2, id: 'task-qa-independent', title: 'Planner runner entries', goal, criteria: [
  {id: 'planner-runner-entry', description: 'Planner sees runner entries', verifierIds: ['tests']},
  {id: 'planning-unchanged', description: 'Planning schema unchanged', verifierIds: ['tests']}],
  qa: {schemaVersion: 1, required: true, policyHash: 'a'.repeat(64), enrolledAt: at, enrollment: 'new', late: false}};
// Distinct values in every field so a dropped or swapped field is visible.
const runners = [
  {id: 'independent-qa', adapter: 'generic', command: 'node', args: ['tests/qa/acceptance.mjs'], cwd: '.'},
  {id: 'unit-suite', adapter: 'node', command: 'npm', args: ['run', 'test', '--', '--grep', '{checks}'], cwd: 'packages/cli', timeoutMs: 60000},
  {id: 'py-suite', adapter: 'pytest', command: 'python3', args: ['-m', 'pytest', '{materials}'], cwd: 'research'}];
const entries = runners.map(r => ({id: r.id, adapter: r.adapter, command: r.command, args: r.args, cwd: r.cwd}));
const scenarios = {initialState: {applies: true, behavior: 'First planning run'}, redo: {applies: true, behavior: 'Replanning'},
  timeBoundary: {na: 'No deadline'}, identitySwitch: {na: 'Same config for every host'}, concurrency: {na: 'Single planner'}};
const binding = {runnerId: 'independent-qa', checkIds: ['entry-check'], redCheckIds: ['entry-check'],
  materials: [{path: 'tests/qa/independent/case.check.mjs', role: 'test'}]};
const cases = () => [
  {id: 'case-entry', criterionIds: ['planner-runner-entry'], surfaceIds: ['planning'], required: true, mode: 'behavioral',
    preconditions: ['Built'], actions: ['Plan'], expected: 'Runner entries visible', bindings: [binding]},
  {id: 'case-unchanged', criterionIds: ['planning-unchanged'], surfaceIds: ['planning'], required: true, mode: 'nonmechanical',
    preconditions: [], actions: ['Read'], expected: 'Unchanged', bindings: [], nonmechanicalReason: 'Judgment'}];
const answer = (patch = {}) => ({cases: cases(), scenarios, environment: [], questions: [], ...patch});

/** Test-only planner transport answering like a read-only Claude envelope; it records each request (including stdin). */
function fakePlanner(body) {
  const requests = [];
  return {requests, runner: {start(request) {
    requests.push(request);
    const out = JSON.stringify({structured_output: body, usage: {input_tokens: 1, output_tokens: 1}});
    return {pid: null, stdout: (async function* () {yield Buffer.from(out);})(), stderr: (async function* () {})(),
      completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => {}};
  }}};
}
const dataOf = stdin => {
  const [, rest] = stdin.split('BEGIN UNTRUSTED DATA\n');
  assert.ok(rest !== undefined, 'The planner prompt carries a BEGIN UNTRUSTED DATA block');
  return JSON.parse(rest.split('\nEND UNTRUSTED DATA')[0]);
};
const instructionsOf = stdin => stdin.split('BEGIN UNTRUSTED DATA')[0];
const schemaOf = request => JSON.parse(request.args[request.args.indexOf('--json-schema') + 1]);
const runnerFields = data => (data.runners ?? []).map(r => ({id: r.id, adapter: r.adapter, command: r.command, args: r.args, cwd: r.cwd}));

async function fixture(check) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-qa-independent-'));
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(root, 'source.txt'), 'candidate\n');
    git(['add', '.']); git(['commit', '-qm', 'candidate']);
    const {taskContractHash} = await load('runtime/src/task/contract.js', 'taskContractHash');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const {runQaPlanning, QA_PLAN_SCHEMA} = await load('runtime/src/qa/planning.js', 'runQaPlanning', 'QA_PLAN_SCHEMA');
    const version = {taskId: task.id, goalHash: hash(goal), taskContractHash: taskContractHash(task), treeContractHash: 'b'.repeat(64),
      scopeHash: 'c'.repeat(64), policyHash: task.qa.policyHash, configHash: 'd'.repeat(64), candidateCommit: git(['rev-parse', 'HEAD']).trim(),
      sourceFingerprint: 'e'.repeat(64)};
    const store = new FileQaStore(join(root, '.git'));
    const base = {store, root, version, originalGoal: goal, tasks: [task], scope: 'full', timing: 'late', surfaceIds: ['planning'], runners,
      advisory: null, available: ['claude'], implementationHost: 'codex', implementationSessionId: 'developer-session', controllerId: 'controller'};
    const plan = async body => {
      const planner = fakePlanner(body);
      const result = await runQaPlanning({...base, runner: planner.runner});
      assert.equal(planner.requests.length, 1, 'Exactly one planner session starts');
      return {result, request: planner.requests[0]};
    };
    /** Stores a prior controller report on the task control so the next planning run is a replan with history. */
    const priorReport = async () => {
      const report = await store.put('report', {schemaVersion: 1, id: 'report-prior', version, attempt: {kind: 'attempt', digest: 'f'.repeat(64)},
        createdAt: at, results: [{caseId: 'case-entry', status: 'UNKNOWN', executions: [], observations: ['Prior run left the check unexecuted.']}],
        findings: [], questions: []});
      const control = await store.readControl(task.id);
      await store.updateControl(task.id, control.revision, c => ({...c, revision: c.revision + 1, report}));
      return report;
    };
    await check({store, base, plan, priorReport, runQaPlanning, QA_PLAN_SCHEMA});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

/** Test-only planner transport: a valid Claude-style envelope padded with a transcript-like field to `bytes`. */
function paddedPlanner(body, bytes) {
  const requests = [];
  return {requests, runner: {start(request) {
    requests.push(request);
    const bare = JSON.stringify({structured_output: body, usage: {input_tokens: 1, output_tokens: 1}, result: ''});
    const out = JSON.stringify({structured_output: body, usage: {input_tokens: 1, output_tokens: 1}, result: 'x'.repeat(Math.max(0, bytes - bare.length))});
    return {pid: null, stdout: (async function* () {yield Buffer.from(out);})(), stderr: (async function* () {})(),
      completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => {}};
  }}};
}

export const checks = {
  'qa-planner-large-output': () => fixture(async ({store, base, runQaPlanning}) => {
    const planner = paddedPlanner(answer(), 1024 * 1024 - 1024);
    const result = await runQaPlanning({...base, runner: planner.runner}).catch(error => error);
    assert.equal(result?.code, undefined, `A planner answer just under 1 MiB must be planned, got ${result?.code}`);
    assert.equal(result.state, 'plan-ready');
    assert.equal((await store.get(result.plan)).cases.length, 2, 'The saved plan carries both cases');
  }),
  'qa-planner-over-limit': () => fixture(async ({store, base, runQaPlanning}) => {
    const planner = paddedPlanner(answer(), 1024 * 1024 + 4096);
    await assert.rejects(runQaPlanning({...base, runner: planner.runner}), {code: 'QA_PLAN_NOT_RUN'});
    const control = await store.readControl(base.version.taskId);
    assert.equal(control?.plan ?? null, null, 'No plan is saved for a truncated answer');
  }),
};
