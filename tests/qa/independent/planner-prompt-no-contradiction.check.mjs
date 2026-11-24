// Independent QA: the read-only planner prompt must not tell the planner that unobserved external requirements are
// required environment blockers (that contradicts "missing only for an observed absence"), and must still direct genuine
// external requirements to be listed as missing when observed absent and unknown when unprobed, while keeping
// controller-provided execution primitives out of planner environment. Checked on qaPlanningPrompt and on the live prompt
// runQaPlanning sends to both read-only hosts: claude (stdin) and agy (the -p argument).
// Run by tests/qa/acceptance.mjs against a built checkout (dist/, or AGENT_OPS_DEBUG_TEST_BUILD). Fixtures are disposable.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
// An absent module or export is an assertion failure the controller can see, never a collection-time import error.
async function load(path, ...names) {
  const mod = await import(pathToFileURL(join(build, path)).href).catch(() => ({}));
  for (const name of names) assert.equal(typeof mod[name], 'function', `${path} must export function ${name}`);
  return mod;
}
const at = '2026-11-23T00:00:00.000Z';
const runner = {id: 'qa-runner', command: process.execPath, args: ['{materials}'], cwd: '.', adapter: 'generic'};
const config = {schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: [
  {id: 'tests', command: process.execPath, args: ['test.mjs'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}], acceptanceRunners: [runner]},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [], qa: {enabled: true}};
const scenarios = {initialState: {applies: true, behavior: 'Fresh delivery'}, redo: {na: 'No redo'}, timeBoundary: {na: 'No deadline'},
  identitySwitch: {na: 'One host'}, concurrency: {na: 'One controller'}};
const plannerAnswer = {cases: [{id: 'case-guide', criterionIds: ['behavior', 'compatibility'], surfaceIds: [], required: true, mode: 'nonmechanical', preconditions: [],
  actions: ['Read the guide'], expected: 'The guide is accurate', bindings: [], nonmechanicalReason: 'Prose accuracy needs human judgment'}],
  scenarios, environment: [], questions: []};

/** Runs the real runQaPlanning once per read-only host in its own disposable enrolled repository; returns each captured request. */
async function capture(host) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `agent-ops-qa-prompt-${host}-`)));
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const gitRunner = {run: async args => {
    try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']})};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0)};}
  }};
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(root, 'test.mjs'), 'process.exitCode = 0;\n');
    git(['add', '.']); git(['commit', '-qm', 'baseline']);
    const baseline = git(['rev-parse', 'HEAD']);
    await mkdir(join(root, '.agent-ops'), {recursive: true});
    await writeFile(join(root, '.agent-ops/config.json'), JSON.stringify(config));
    const {TaskService} = await load('runtime/src/task/service.js', 'TaskService');
    const {FileTaskStore} = await load('runtime/src/task/store.js', 'FileTaskStore');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {runQaPlanning} = await load('runtime/src/qa/planning.js', 'runQaPlanning');
    const tasks = new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root);
    const service = new TaskService(tasks, {generateId: () => `task-qa-prompt-${host}`, now: () => at, platform: 'darwin',
      completion: {root, base: baseline, gitRunner, loadConfig: async () => structuredClone(config)}});
    const task = (await service.create({title: 'Planner prompt guidance', goal: 'The planner prompt does not contradict itself',
      criteria: [{id: 'behavior', description: 'Observable behavior', verifierIds: ['tests']},
        {id: 'compatibility', description: 'The guide stays accurate', verifierIds: ['tests']}], sessionId: 'developer-session'})).task;
    assert.ok(task.qa?.required, 'Fixture precondition: the delivery root is enrolled in QA');
    const head = git(['rev-parse', 'HEAD']);
    const version = qaDeliveryVersion({tasks: [task], config, candidateCommit: head,
      sourceFingerprint: createHash('sha256').update(`qa-plan-candidate:${head}`).digest('hex')});
    // Test-only read-only planner transport: records the request and answers a schema-valid plan; never a production plan.
    const requests = [];
    const planner = {start(request) {
      requests.push(request);
      const body = JSON.stringify({structured_output: plannerAnswer, response: 'plan', usage: {input_tokens: 5, output_tokens: 3}});
      return {pid: null, stdout: (async function* () {yield Buffer.from(body);})(), stderr: (async function* () {})(),
        completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => {}};
    }};
    const probe = {identity: async p => p === process.pid ? `identity-${p}` : null, groupAlive: () => false, signalGroup: async () => {}};
    // The planner's own outcome is not under test here; only the prompt it was sent.
    await runQaPlanning({store: new FileQaStore(join(root, '.git')), root, version, originalGoal: task.goal, tasks: [task], scope: 'full',
      timing: 'late', runners: config.verification.acceptanceRunners, baselineCommit: baseline, advisory: null, available: [host],
      implementationHost: 'codex', implementationSessionId: 'developer-session', controllerId: 'qa-controller', runner: planner,
      now: () => at, probe}).catch(() => undefined);
    assert.equal(requests.length, 1, `Fixture precondition: runQaPlanning invoked the ${host} planner once`);
    return requests[0];
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

/** The trusted instruction part of a planner prompt: everything before the untrusted DATA block. */
function instructions(prompt, label) {
  assert.match(prompt, /BEGIN UNTRUSTED DATA/u, `Fixture precondition: the ${label} prompt was captured`);
  return prompt.split('BEGIN UNTRUSTED DATA')[0];
}

function assertGuidance(text, label) {
  // No contradiction: nothing calls unobserved/unprobed requirements (required) environment blockers.
  assert.doesNotMatch(text, /required environment blockers?/iu, `${label}: no "required environment blocker" instruction remains`);
  for (const sentence of text.split(/(?<=[.;:])\s+/u)) {
    if (/unobserved|unprobed|not observed|cannot probe|could not probe|can't probe|couldn't probe/iu.test(sentence) && /\bblock/iu.test(sentence))
      assert.match(sentence, /(does not|doesn't|never|not) block/iu, `${label}: an unobserved requirement is never told to block: "${sentence}"`);
  }
  // Genuine external requirements stay listed: missing when observed absent, unknown when unprobed.
  const external = text.split('\n').find(line => /genuine external requirements?/iu.test(line));
  assert.ok(external, `${label}: the prompt still addresses genuine external requirements`);
  const rule = external.slice(external.search(/genuine external requirements?/iu)).split('.')[0];
  assert.match(rule, /required environment/iu, `${label}: genuine external requirements are listed as required environment`);
  assert.match(rule, /missing\b[^;]*observ[^;]*absen/iu, `${label}: missing when observed absent`);
  assert.match(rule, /unknown\b[^;]*(not|n't|un)\s*probe/iu, `${label}: unknown when it could not be probed`);
  // Controller-provided execution primitives remain excluded from planner environment.
  assert.match(text, /controller-provided execution primitives are not (planner )?environment/iu,
    `${label}: controller-provided execution primitives are not planner environment`);
}

export const checks = {
  // Case planner-prompt-genuine-external-env-no-contradiction.
  'indep-qa-prompt-external-env-guidance': async () => {
    const {qaPlanningPrompt} = await load('runtime/src/qa/planning.js', 'qaPlanningPrompt');
    assertGuidance(instructions(qaPlanningPrompt({}), 'qaPlanningPrompt'), 'qaPlanningPrompt');

    const claude = await capture('claude');
    assert.equal(claude.command, 'claude', 'Fixture precondition: the claude host planned');
    assertGuidance(instructions(String(claude.stdin ?? ''), 'claude stdin'), 'claude stdin');

    const agy = await capture('agy');
    assert.equal(agy.command, 'agy', 'Fixture precondition: the agy host planned');
    const p = agy.args.indexOf('-p');
    assert.ok(p >= 0 && typeof agy.args[p + 1] === 'string', 'agy receives its prompt as the -p argument');
    assertGuidance(instructions(agy.args[p + 1], 'agy -p'), 'agy -p');
  }
};
