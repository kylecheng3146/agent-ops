// Independent QA: the CLI `qa show` surface and the reviewer gate data (qaReviewData) agree that a required unknown
// environment is advisory and only an observed missing one blocks. Live: a read-only planner marked
// swift-5-10-macos-14-toolchain and macos-desktop-session-for-watchhub-ui unknown and QA stayed QA_BLOCKED.
// Run by tests/qa/acceptance.mjs against a built checkout (dist/, or AGENT_OPS_DEBUG_TEST_BUILD).
// Every fixture is a disposable git repository; nothing here is production output.
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
const hash = value => createHash('sha256').update(value).digest('hex');
const at = '2026-11-23T00:00:00.000Z';
const MATERIAL = 'tests/qa-independent/answer.test.mjs';
const runner = {id: 'qa-runner', command: process.execPath, args: ['{materials}'], cwd: '.', adapter: 'generic'};
const config = {schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: [
  {id: 'tests', command: process.execPath, args: ['test.mjs'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}], acceptanceRunners: [runner]},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [], qa: {enabled: true}};
const feature = answer => `export const answer = () => ${answer};\n`;
/** Test-only material speaking the generic acceptance protocol. */
const CASE_TEST = `import {answer} from '../../feature.mjs';
const executionId = process.env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID, phase = process.env.AGENT_OPS_ACCEPTANCE_PHASE;
const requested = (process.env.AGENT_OPS_ACCEPTANCE_CHECKS ?? '').split(',').filter(Boolean);
const checks = {'answer-two': answer() === 2};
const results = Object.entries(checks).filter(([id]) => requested.length === 0 || requested.includes(id)).map(([checkId, ok]) => ({executionId,
  framework: 'qa-fixture', frameworkVersion: '1', checkId, phase, status: ok ? 'PASS' : 'FAIL', failureClass: ok ? 'none' : 'assertion-failed',
  attempts: 1, evidence: [checkId + ' observed ' + answer()]}));
console.log(JSON.stringify({protocolVersion: 1, executionId, framework: 'qa-fixture', frameworkVersion: '1', phase, results,
  completed: true, completionEvidence: ['qa fixture finished'], diagnostics: []}));
process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
`;
const scenarios = {initialState: {applies: true, behavior: 'Fresh enrolled delivery'}, redo: {applies: true, behavior: 'A stored blocked control resumes'},
  timeBoundary: {na: 'No deadline'}, identitySwitch: {na: 'One host'}, concurrency: {na: 'One controller'}};
const answerCase = {id: 'case-answer-two', criterionIds: ['behavior'], surfaceIds: [], required: true, mode: 'behavioral',
  preconditions: ['An enrolled delivery'], actions: ['Ask for the answer'], expected: 'The answer is two',
  bindings: [{runnerId: 'qa-runner', checkIds: ['answer-two'], redCheckIds: ['answer-two'], materials: [{path: MATERIAL, role: 'test'}]}]};
const guideCase = {id: 'case-guide', criterionIds: ['compatibility'], surfaceIds: [], required: true, mode: 'nonmechanical', preconditions: [],
  actions: ['Read the guide'], expected: 'The guide is accurate', bindings: [], nonmechanicalReason: 'Prose accuracy needs human judgment'};
const toolchain = {name: 'swift-5-10-macos-14-toolchain', required: true, status: 'unknown', evidence: ['Read-only planning cannot run swift']};
const desktop = {name: 'macos-desktop-session-for-watchhub-ui', required: true, status: 'unknown', evidence: ['No GUI session in the planner sandbox']};
const browser = {name: 'installed-browser', required: true, status: 'missing', evidence: ['Observed no installed browser']};
const envBlockers = blockers => blockers.filter(b => b.startsWith('environment:'));
const session = {host: 'claude', sessionId: 'qa-author', implementationSessionId: 'developer-session', implementationHost: 'codex', writable: true, fallbackReason: null};

async function fixture(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-unknown-consumers-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-unknown-consumers-outside-')));
  const git = (args, cwd = root) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const gitRunner = {run: async args => {
    try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']})};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0)};}
  }};
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(root, 'feature.mjs'), feature(1));
    await writeFile(join(root, 'test.mjs'), 'process.exitCode = 0;\n');
    git(['add', '.']); git(['commit', '-qm', 'baseline']);
    const baseline = git(['rev-parse', 'HEAD']);
    await mkdir(join(root, '.agent-ops'), {recursive: true});
    await writeFile(join(root, '.agent-ops/config.json'), JSON.stringify(config));
    const commit = async value => {
      await writeFile(join(root, 'feature.mjs'), feature(value));
      git(['add', '.']); git(['commit', '-qm', `candidate ${value}`]);
      return git(['rev-parse', 'HEAD']);
    };
    const {TaskService} = await load('runtime/src/task/service.js', 'TaskService');
    const {FileTaskStore} = await load('runtime/src/task/store.js', 'FileTaskStore');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js', 'FileEvidenceStore');
    const {NodeVerificationProcessRunner} = await load('runtime/src/verify/spawn.js', 'NodeVerificationProcessRunner');
    const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js', 'calculateSourceFingerprint');
    const {resolveReviewScope} = await load('runtime/src/review/scope.js', 'resolveReviewScope');
    const {qaDeliveryVersion, qaReviewData} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion', 'qaReviewData');
    const {claimQaControl, releaseQaControl} = await load('runtime/src/qa/session.js', 'claimQaControl', 'releaseQaControl');
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js', 'runQaDelivery');
    const {runQaCommand} = await load('packages/cli/src/commands/qa.js', 'runQaCommand');
    const tasks = new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root);
    const service = new TaskService(tasks, {generateId: () => 'task-qa-unknown-consumers', now: () => at, platform: 'darwin',
      completion: {root, base: baseline, gitRunner, loadConfig: async () => structuredClone(config)}});
    const task = (await service.create({title: 'Unknown environment is advisory', goal: 'QA does not block on environment a read-only planner cannot probe',
      criteria: [{id: 'behavior', description: 'Observable behavior', verifierIds: ['tests']},
        {id: 'compatibility', description: 'The guide stays accurate', verifierIds: ['tests']}], sessionId: 'developer-session'})).task;
    assert.ok(task.qa?.required, 'Fixture precondition: the delivery root is enrolled in QA');
    const records = async () => (await tasks.read()).tasks;
    const store = new FileQaStore(join(root, '.git'));
    // Same rule as the production adapter: without a change surface the plan binds the candidate commit.
    const fingerprint = async () => {
      try {return await calculateSourceFingerprint(root, await resolveReviewScope({root, runner: gitRunner, base: baseline}), gitRunner);}
      catch (error) {if (error.code === 'REVIEW_NO_CHANGE_SURFACE') return hash(`qa-plan-candidate:${git(['rev-parse', 'HEAD'])}`); throw error;}
    };
    const version = async () => qaDeliveryVersion({tasks: [task], config, candidateCommit: git(['rev-parse', 'HEAD']), sourceFingerprint: await fingerprint()});
    // Test-only planner transport: a stored current plan must never reach it.
    const planner = {calls: 0, start() {this.calls++; throw new Error('A stored plan must not be replanned');}};
    // Test-only writable author host with a fake process identity; it writes exactly one new material file.
    const alive = new Set(), authors = [];
    let pid = 9000;
    const probe = {identity: async p => p === process.pid || alive.has(p) ? `identity-${p}` : null, groupAlive: () => false, signalGroup: async p => {alive.delete(p);}};
    const host = kind => ({kind,
      async start(input) {authors.push(input); const p = ++pid; alive.add(p); await input.registerProcess(p);
        return {...input, kind, sessionId: input.sessionId, threadId: null, nativeVersion: null, processId: p, startedAt: at, process: null, goalStatus: 'unknown'};},
      async resume() {throw new Error('unused');},
      async activate() {return {actionId: 'a', accepted: true, nativeStatus: 'active', payload: null};},
      async *observe(handle) {
        const control = await store.readControl(task.id);
        await mkdir(join(handle.cwd, 'tests/qa-independent'), {recursive: true});
        await writeFile(join(handle.cwd, MATERIAL), CASE_TEST);
        await mkdir(join(handle.cwd, '.agent-ops'), {recursive: true});
        await writeFile(join(handle.cwd, '.agent-ops/qa-author-response.json'), JSON.stringify({schemaVersion: 1, generation: handle.generation,
          plan: control.plan.digest, candidateCommit: git(['rev-parse', 'HEAD'], handle.cwd),
          materials: [{path: MATERIAL, role: 'test', caseIds: ['case-answer-two']}], requestedEdits: [], observations: [], questions: []}));
        yield {runId: handle.runId, workerId: handle.workerId, generation: handle.generation, contractHash: handle.contractHash, host: kind,
          nativeStatus: 'unknown', payload: {}, proof: false, type: 'completed', at};
      },
      async stop(handle) {alive.delete(handle.processId); return {actionId: 's', accepted: true, nativeStatus: 'paused', payload: null};},
      async update() {throw new Error('unused');}, async interrupt() {throw new Error('unused');}});
    /** A stored schemaVersion 1 plan and control as an earlier release left them: no planner is involved. */
    const seed = async ({environment, state}) => {
      const planRef = await store.put('plan', {schemaVersion: 1, id: 'plan-stored', version: await version(), originalGoal: task.goal, taskIds: [task.id],
        dependencyTaskIds: [], scope: 'full', session: {...session, sessionId: 'qa-planner', writable: false}, createdAt: at, timing: 'late',
        advisoryReferences: [], cases: [answerCase, guideCase], scenarios, environment, questions: []});
      const held = await claimQaControl(store, {taskId: task.id, controllerId: 'qa-controller', session, state: 'testing', explicit: true, now: at, probe});
      await releaseQaControl(store, held, {state, plan: planRef}, at);
      return planRef;
    };
    /** The real CLI `agent-ops qa show` handler; show never starts a model, so deliver/adopt must stay unused. */
    const show = async () => await runQaCommand({args: {command: 'qa', action: 'show', taskId: task.id}, root, inRun: false, now: () => at,
      loadConfig: async () => structuredClone(config), fingerprint: async () => await fingerprint(),
      deliver: async () => {throw new Error('qa show must not deliver');}, adopt: async () => {throw new Error('qa show must not adopt');}});
    const deliver = async () => await runQaDelivery({store, root, rootTaskId: task.id, records: await records(), config, trusted: true, fingerprint, gitRunner,
      processRunner: new NodeVerificationProcessRunner(), planningRunner: planner, evidenceStore: new FileEvidenceStore(root, root),
      controllerId: 'qa-controller', available: ['claude'], implementationHost: 'codex', implementationSessionId: 'developer-session', advisory: null,
      host, probe, checkouts: outside, now: () => at, platform: 'darwin'});
    const review = async () => await qaReviewData(store, (await records()).find(r => r.task.id === task.id), await version());
    await check({commit, store, task, planner, authors, seed, show, deliver, review});
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
}

export const checks = {
  // Case cli-show-and-reviewer-gate-data-unknown-env.
  'indep-qa-cli-show-and-review-data-unknown-env': () => fixture(async f => {
    // 1. CLI qa show on a stored blocked control whose plan has only required unknown environment.
    const unknownPlan = await f.seed({environment: [toolchain, desktop], state: 'blocked'});
    const shown = await f.show();
    assert.equal(shown.status, 'ok', JSON.stringify(shown.errors));
    assert.equal(shown.code, 'QA_SHOWN');
    assert.deepEqual(envBlockers(shown.data.status.blockers), [], 'qa show names no unknown environment as a blocker');
    assert.deepEqual(shown.data.status.blockers, []);
    assert.doesNotMatch(shown.data.text, /environment:/u);
    assert.doesNotMatch(shown.data.text, /swift-5-10-macos-14-toolchain|macos-desktop-session-for-watchhub-ui/u);
    assert.equal(shown.data.show?.plan?.digest, unknownPlan.digest, 'qa show reads the stored plan without replanning');

    // 2. CLI qa show on a mixed plan: only the observed missing entry blocks.
    await f.seed({environment: [toolchain, browser], state: 'blocked'});
    const mixed = await f.show();
    assert.equal(mixed.status, 'ok', JSON.stringify(mixed.errors));
    assert.deepEqual(envBlockers(mixed.data.status.blockers), ['environment:installed-browser'], 'qa show names only the missing entry');
    assert.match(mixed.data.text, /environment:installed-browser/u);
    assert.doesNotMatch(mixed.data.text, /swift-5-10-macos-14-toolchain/u);

    // 3. Deliver the unknown-only plan to passed, then read the reviewer gate data.
    const stored = await f.seed({environment: [toolchain, desktop], state: 'blocked'});
    await f.commit(2);
    const delivered = await f.deliver();
    assert.equal(f.planner.calls, 0, 'A stored current plan is not replanned');
    assert.equal(delivered.state, 'passed', delivered.blockers.join('; '));
    assert.equal(delivered.plan.digest, stored.digest);
    assert.equal(f.authors.length, 1);
    const data = await f.review();
    assert.equal(data.state, 'passed');
    assert.equal(data.current, true, 'The sealed attestation matches the current delivery version');
    assert.notEqual(data.attestation, null);
    assert.deepEqual(data.plan.environment.filter(e => !e.name.startsWith('runner:')), [
      {name: toolchain.name, required: true, status: 'unknown'}, {name: desktop.name, required: true, status: 'unknown'}],
    'Reviewers still see every unknown environment entry exactly as planned');
  })
};
