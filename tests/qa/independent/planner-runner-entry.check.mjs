// Independent QA: the QA planner prompt shows every configured acceptance runner's entry (id, adapter, command, args, cwd)
// on initial planning and on replanning, while the plan schema, normalization, rejection and history stay unchanged.
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

export const checks = {
  'qa-planner-runner-entries-and-prompt': () => fixture(async ({plan}) => {
    const {request} = await plan(answer());
    assert.deepEqual(runnerFields(dataOf(request.stdin)), entries,
      'DATA.runners carries each configured runner id, adapter, command, args and cwd, in configured order');
    const instructions = instructionsOf(request.stdin);
    assert.match(instructions, /DATA\.runners/u, 'The instructions point the planner at DATA.runners');
    assert.match(instructions, /\bentry\b/u, 'The planner is told to read the runner entry');
    assert.match(instructions, /in the clone/u, 'The runner entry is read in the planner clone');
    // One instruction sentence ties reading the entry (first) to material paths and check ids.
    const sentence = instructions.split('\n').find(line => /\bentry\b/u.test(line)) ?? '';
    assert.match(sentence, /\bentry\b[^.]*\bfirst\b|\bbefore\b[^.]*\bmaterial/u, 'The entry is read before choosing material');
    assert.match(sentence, /\bmaterial\b[^.]*\bpaths?\b/u, 'Reading the entry governs material paths');
    assert.match(sentence, /\bcheck ids\b/u, 'Reading the entry governs the check ids');
  }),
  'qa-planner-replan-runner-entries': () => fixture(async ({plan, priorReport}) => {
    const first = await plan(answer());
    assert.deepEqual(runnerFields(dataOf(first.request.stdin)), entries, 'Initial planning shows full runner entries');
    const report = await priorReport();
    const {request} = await plan(answer());
    const data = dataOf(request.stdin);
    assert.equal(data.history?.report?.reference?.digest, report.digest, 'The replan carries prior history');
    assert.deepEqual(runnerFields(data), entries, 'Replanning shows the same runner command, args and cwd alongside DATA.history');
    assert.match(instructionsOf(request.stdin), /\bentry\b/u, 'The replan prompt still instructs reading the runner entry');
  }),
  'qa-planning-schema-and-validation-invariant': () => fixture(async ({store, base, plan, priorReport, runQaPlanning, QA_PLAN_SCHEMA}) => {
    assert.equal(QA_PLAN_SCHEMA.additionalProperties, false);
    assert.deepEqual([...QA_PLAN_SCHEMA.required].sort(), ['cases', 'environment', 'questions', 'scenarios']);
    assert.deepEqual(Object.keys(QA_PLAN_SCHEMA.properties).sort(), ['cases', 'environment', 'questions', 'scenarios']);
    // {applies:false, na} is stored as {na} and the plan is ready.
    const first = await plan(answer({scenarios: {...scenarios, redo: {applies: false, na: 'No replay'}}}));
    assert.equal(first.result.state, 'plan-ready');
    assert.deepEqual((await store.get(first.result.plan)).scenarios.redo, {na: 'No replay'});
    // Replan: history is serialized into DATA.history; the response schema handed to the planner is unchanged.
    const report = await priorReport();
    const second = await plan(answer());
    const history = dataOf(second.request.stdin).history;
    assert.equal(history.report.reference.digest, report.digest);
    assert.equal(history.report.results[0].caseId, 'case-entry');
    assert.deepEqual(history.previousReports, []);
    assert.match(history.authority, /not current proof/u);
    assert.deepEqual(schemaOf(second.request), schemaOf(first.request), 'Replanning does not change the response schema');
    assert.equal(second.result.state, 'plan-ready');
    // Invalid plans are rejected, never stored as ready.
    const unmapped = answer({cases: [cases()[0]]});
    await assert.rejects(runQaPlanning({...base, runner: fakePlanner(unmapped).runner}), {code: 'QA_PLAN_INVALID'}, 'An unmapped criterion is rejected');
    const extra = {...answer(), verdict: 'PASS'};
    await assert.rejects(runQaPlanning({...base, runner: fakePlanner(extra).runner}), {code: 'QA_PLAN_INVALID'}, 'An unknown top-level field is rejected');
    const control = await store.readControl(task.id);
    assert.equal(control.state, 'blocked');
    assert.deepEqual(control.plan, second.result.plan, 'A rejected plan never replaces the stored plan');
  })
};
