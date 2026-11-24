// Independent QA for "unknown required environment is advisory; only an observed missing one blocks".
// Live: a read-only planner could not probe swift-5-10-macos-14-toolchain or macos-desktop-session-for-watchhub-ui,
// marked them unknown, and QA stayed QA_BLOCKED forever. Run by tests/qa/acceptance.mjs against a built checkout
// (dist/, or AGENT_OPS_DEBUG_TEST_BUILD). Every fixture is a disposable git repository; nothing here is production output.
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
const MODE = 'QA_UNKNOWN_ENV_FIXTURE_MODE';
const runner = {id: 'qa-runner', command: process.execPath, args: ['{materials}'], cwd: '.', adapter: 'generic'};
const config = {schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: [
  {id: 'tests', command: process.execPath, args: ['test.mjs'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}], acceptanceRunners: [runner]},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [], qa: {enabled: true}};
const feature = answer => `export const answer = () => ${answer};\n`;
/** Test-only material speaking the generic acceptance protocol; MODE=crash makes the run an infrastructure failure (UNKNOWN). */
const CASE_TEST = `import {answer} from '../../feature.mjs';
if (process.env.${MODE} === 'crash') throw new Error('fixture setup failed before any check ran');
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
const answerCase = (runnerId = 'qa-runner') => ({id: 'case-answer-two', criterionIds: ['behavior'], surfaceIds: [], required: true, mode: 'behavioral',
  preconditions: ['An enrolled delivery'], actions: ['Ask for the answer'], expected: 'The answer is two',
  bindings: [{runnerId, checkIds: ['answer-two'], redCheckIds: ['answer-two'], materials: [{path: MATERIAL, role: 'test'}]}]});
const guideCase = {id: 'case-guide', criterionIds: ['compatibility'], surfaceIds: [], required: true, mode: 'nonmechanical', preconditions: [],
  actions: ['Read the guide'], expected: 'The guide is accurate', bindings: [], nonmechanicalReason: 'Prose accuracy needs human judgment'};
const toolchain = {name: 'swift-5-10-macos-14-toolchain', required: true, status: 'unknown', evidence: ['Read-only planning cannot run swift']};
const desktop = {name: 'macos-desktop-session-for-watchhub-ui', required: true, status: 'unknown', evidence: ['No GUI session in the planner sandbox']};
const browser = {name: 'installed-browser', required: true, status: 'missing', evidence: ['Observed no installed browser']};
const question = {id: 'confirm-scope', prompt: 'Is the watch UI part of this delivery?', required: true, criterionIds: ['behavior']};
const answer = ({environment = [], questions = [], runnerId} = {}) => ({cases: [answerCase(runnerId), guideCase], scenarios, environment, questions});
const envBlockers = blockers => blockers.filter(b => b.startsWith('environment:'));
const unknownUsage = {inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null};
const session = {host: 'claude', sessionId: 'qa-author', implementationSessionId: 'developer-session', implementationHost: 'codex', writable: true, fallbackReason: null};

async function fixture(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-unknown-advisory-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-unknown-advisory-outside-')));
  const git = (args, cwd = root) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const gitRunner = {run: async args => {
    try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']})};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0)};}
  }};
  const previousMode = process.env[MODE];
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
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {claimQaControl, releaseQaControl, cloneQaCheckout} = await load('runtime/src/qa/session.js', 'claimQaControl', 'releaseQaControl', 'cloneQaCheckout');
    const {inspectQaMaterials, importQaMaterials} = await load('runtime/src/qa/materials.js', 'inspectQaMaterials', 'importQaMaterials');
    const {parseQaAuthorResponse} = await load('runtime/src/qa/validate.js', 'parseQaAuthorResponse');
    const {runQaPlanning} = await load('runtime/src/qa/planning.js', 'runQaPlanning');
    const {qaStatus, renderQaStatus} = await load('runtime/src/qa/status.js', 'qaStatus', 'renderQaStatus');
    const {executeQaAttempt, sealQaAttestation} = await load('runtime/src/qa/proof.js', 'executeQaAttempt', 'sealQaAttestation');
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js', 'runQaDelivery');
    const {respondQa} = await load('runtime/src/qa/decisions.js', 'respondQa');
    const tasks = new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root);
    const service = new TaskService(tasks, {generateId: () => 'task-qa-unknown-advisory', now: () => at, platform: 'darwin',
      completion: {root, base: baseline, gitRunner, loadConfig: async () => structuredClone(config)}});
    const task = (await service.create({title: 'Unknown environment is advisory', goal: 'QA does not block on environment a read-only planner cannot probe',
      criteria: [{id: 'behavior', description: 'Observable behavior', verifierIds: ['tests']},
        {id: 'compatibility', description: 'The guide stays accurate', verifierIds: ['tests']}], sessionId: 'developer-session'})).task;
    assert.ok(task.qa?.required, 'Fixture precondition: the delivery root is enrolled in QA');
    const records = async () => (await tasks.read()).tasks;
    const store = new FileQaStore(join(root, '.git'));
    const processRunner = new NodeVerificationProcessRunner();
    const evidenceStore = new FileEvidenceStore(root, root);
    // Same rule as the production adapter: without a change surface the plan binds the candidate commit.
    const fingerprint = async () => {
      try {return await calculateSourceFingerprint(root, await resolveReviewScope({root, runner: gitRunner, base: baseline}), gitRunner);}
      catch (error) {if (error.code === 'REVIEW_NO_CHANGE_SURFACE') return hash(`qa-plan-candidate:${git(['rev-parse', 'HEAD'])}`); throw error;}
    };
    const version = async () => qaDeliveryVersion({tasks: [task], config, candidateCommit: git(['rev-parse', 'HEAD']), sourceFingerprint: await fingerprint()});
    // Test-only read-only planner transport: counts calls and records each request; never a production plan.
    const planner = {answer: null, calls: 0, requests: [], start(request) {
      this.calls++; this.requests.push(request);
      const body = JSON.stringify({structured_output: this.answer, usage: {input_tokens: 5, output_tokens: 3}});
      return {pid: null, stdout: (async function* () {yield Buffer.from(body);})(), stderr: (async function* () {})(),
        completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => {}};
    }};
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
    /** Fresh read-only planning through the real runQaPlanning, with the stubbed planner answering `body`. */
    const plan = async body => {
      planner.answer = body;
      const before = planner.requests.length;
      const result = await runQaPlanning({store, root, version: await version(), originalGoal: task.goal, tasks: [task], scope: 'full', timing: 'late',
        runners: config.verification.acceptanceRunners, baselineCommit: baseline, advisory: null, available: ['claude'], implementationHost: 'codex',
        implementationSessionId: 'developer-session', controllerId: 'qa-controller', runner: planner, now: () => at, probe});
      return {result, request: planner.requests[before]};
    };
    /** A stored schemaVersion 1 plan and control as an earlier release left them: no planner is involved. */
    const seed = async ({environment, questions = [], cases = [answerCase(), guideCase], state}) => {
      const planRef = await store.put('plan', {schemaVersion: 1, id: 'plan-stored', version: await version(), originalGoal: task.goal, taskIds: [task.id],
        dependencyTaskIds: [], scope: 'full', session: {...session, sessionId: 'qa-planner', writable: false}, createdAt: at, timing: 'late',
        advisoryReferences: [], cases, scenarios, environment, questions});
      const held = await claimQaControl(store, {taskId: task.id, controllerId: 'qa-controller', session, state: 'testing', explicit: true, now: at, probe});
      const control = await releaseQaControl(store, held, {state, plan: planRef}, at);
      return {plan: planRef, generation: control.generation};
    };
    /** Hands the current plan to a confirmed-dead author generation in `state`, without touching the plan. */
    const hold = async (state = 'testing') => {
      const held = await claimQaControl(store, {taskId: task.id, controllerId: 'qa-controller', session, state: 'testing', explicit: true, now: at, probe});
      return (await releaseQaControl(store, held, {state}, at)).generation;
    };
    /** The real isolated-checkout import path: QA adds one new material file, committed as the final candidate. */
    const importMaterial = async () => {
      const authored = git(['rev-parse', 'HEAD']), checkout = join(outside, `author-${authored.slice(0, 8)}`);
      await cloneQaCheckout(root, checkout, authored);
      await mkdir(join(checkout, 'tests/qa-independent'), {recursive: true});
      await writeFile(join(checkout, MATERIAL), CASE_TEST);
      const inspected = await inspectQaMaterials(checkout, authored, parseQaAuthorResponse({schemaVersion: 1, generation: 1, plan: 'f'.repeat(64),
        candidateCommit: authored, materials: [{path: MATERIAL, role: 'test', caseIds: ['case-answer-two']}], requestedEdits: [], observations: [], questions: []}));
      return await importQaMaterials({checkout, target: root, inspected, taskId: task.id});
    };
    const attempt = async (generation, imported) => await executeQaAttempt({store, root, version: await version(), baselineCommit: baseline, config,
      trusted: true, gitRunner, processRunner, evidenceStore, now: () => at, author: {session, generation, startedAt: at, usage: unknownUsage,
        materials: imported.materials, materialDigest: imported.materialDigest, lineage: imported.lineage, observations: [], questions: []}});
    const seal = async () => await sealQaAttestation({store, version: await version(), tasks: [task], gitRunner, now: () => at});
    const status = async () => await qaStatus(store, await records(), task.id, null, probe);
    const deliver = async () => await runQaDelivery({store, root, rootTaskId: task.id, records: await records(), config, trusted: true, fingerprint, gitRunner,
      processRunner, planningRunner: planner, evidenceStore, controllerId: 'qa-controller', available: ['claude'], implementationHost: 'codex',
      implementationSessionId: 'developer-session', advisory: null, host, probe, checkouts: outside, now: () => at, platform: 'darwin'});
    const control = async () => await store.readControl(task.id);
    /** Test-only state edit so a defense-in-depth seal refusal is reachable after an attempt already blocked. */
    const force = async state => {
      const c = await control();
      await store.updateControl(task.id, c.revision, saved => ({...saved, revision: saved.revision + 1, state}));
    };
    await check({root, git, baseline, commit, task, store, planner, authors, plan, seed, hold, importMaterial, attempt, seal, status, deliver,
      control, force, version, respondQa, renderQaStatus, setMode: mode => {if (mode === undefined) delete process.env[MODE]; else process.env[MODE] = mode;}});
  } finally {
    if (previousMode === undefined) delete process.env[MODE]; else process.env[MODE] = previousMode;
    await rm(root, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
}

export const checks = {
  // Case policy-predicate-blocks-only-required-missing.
  'indep-qa-env-blocks-predicate': async () => {
    const {qaEnvironmentBlocks} = await load('runtime/src/qa/policy.js', 'qaEnvironmentBlocks');
    for (const required of [true, false]) for (const status of ['available', 'unknown', 'missing'])
      assert.equal(qaEnvironmentBlocks({name: 'x', required, status, evidence: []}), required && status === 'missing',
        `required=${required} status=${status}`);
  },

  // Case planning-unknown-env-ready-and-questions-preserved.
  'indep-qa-planning-unknown-ready': () => fixture(async f => {
    const {result} = await f.plan(answer({environment: [toolchain, desktop]}));
    assert.equal(result.state, 'plan-ready', 'Required unknown environment alone does not block fresh planning');
    assert.deepEqual(result.blockers, []);
    const saved = await f.control();
    assert.equal(saved.state, 'plan-ready');
    assert.equal(saved.plan.digest, result.plan.digest);
    const stored = await f.store.get({...result.plan, kind: 'plan'});
    assert.deepEqual(stored.environment.filter(e => !e.name.startsWith('runner:')), [toolchain, desktop], 'Unknown entries are stored unchanged');
  }),
  'indep-qa-planning-unknown-with-question': () => fixture(async f => {
    const {result} = await f.plan(answer({environment: [toolchain, desktop], questions: [question]}));
    assert.equal(result.state, 'awaiting-input', 'A required question waits for a human; unknown environment does not turn it into blocked');
    assert.deepEqual(result.blockers, []);
    assert.equal((await f.control()).state, 'awaiting-input');
  }),

  // Case stored-unknown-plan-unblocked-across-status-delivery-and-seal.
  'indep-qa-stored-blocked-status-unblocked': () => fixture(async f => {
    const seeded = await f.seed({environment: [toolchain, desktop], state: 'blocked'});
    const status = await f.status();
    assert.deepEqual(envBlockers(status.blockers), [], 'Status names no unknown environment as a blocker');
    assert.deepEqual(status.blockers, []);
    assert.doesNotMatch(f.renderQaStatus(status, f.task.id), /environment:/u);
    const saved = await f.control();
    assert.equal(saved.plan.digest, seeded.plan.digest, 'Status never replans');
    assert.equal(f.planner.calls, 0);
  }),
  'indep-qa-stored-blocked-delivery-proceeds': () => fixture(async f => {
    const seeded = await f.seed({environment: [toolchain, desktop], state: 'blocked'});
    await f.commit(2);
    const result = await f.deliver();
    assert.equal(f.planner.calls, 0, 'A stored current plan is not replanned');
    assert.equal(result.state, 'passed', result.blockers.join('; '));
    assert.equal(result.plan.digest, seeded.plan.digest, 'The stored plan is used as-is, without migration');
    assert.equal(result.sessions, 1, 'Only the author session runs');
    assert.equal(f.authors.length, 1);
    const saved = await f.control();
    assert.equal(saved.state, 'passed');
    assert.equal(saved.plan.digest, seeded.plan.digest);
    assert.notEqual(saved.attestation, null);
  }),
  'indep-qa-attempt-and-seal-allow-unknown': () => fixture(async f => {
    await f.commit(2);
    const {generation} = await f.seed({environment: [toolchain, desktop], state: 'testing'});
    const imported = await f.importMaterial();
    const result = await f.attempt(generation, imported);
    assert.equal(result.state, 'testing', result.blockers.join('; '));
    assert.deepEqual(result.blockers, []);
    assert.equal((await f.control()).progress, null, 'No semantic failure is recorded for unknown environment');
    const report = await f.store.get({...result.report, kind: 'report'});
    assert.equal(report.results.find(r => r.caseId === 'case-answer-two').status, 'PASS');
    const sealed = await f.seal();
    assert.equal(sealed.reused, false);
    assert.equal((await f.control()).state, 'passed');
  }),
  'indep-qa-mixed-unknown-and-missing-blocks-only-missing': () => fixture(async f => {
    const {result} = await f.plan(answer({environment: [toolchain, browser]}));
    assert.equal(result.state, 'blocked');
    assert.deepEqual(result.blockers, ['installed-browser: missing'], 'Planning names only the missing entry');
    assert.deepEqual(envBlockers((await f.status()).blockers), ['environment:installed-browser']);
    await f.commit(2);
    const calls = f.planner.calls;
    const delivered = await f.deliver();
    assert.equal(f.planner.calls, calls, 'The current blocked plan is reused');
    assert.equal(delivered.state, 'blocked');
    assert.deepEqual(delivered.blockers, ['environment:installed-browser']);
    const {generation} = await f.seed({environment: [toolchain, browser], state: 'testing'});
    const imported = await f.importMaterial();
    const attempted = await f.attempt(generation, imported);
    assert.equal(attempted.state, 'blocked');
    assert.deepEqual(envBlockers(attempted.blockers), ['environment:installed-browser']);
    await f.force('testing');
    await assert.rejects(f.seal(), error => {
      assert.equal(error.code, 'QA_ENVIRONMENT_MISSING');
      assert.match(error.message, /QA_ENVIRONMENT_MISSING installed-browser/u);
      assert.doesNotMatch(error.message, /swift-5-10-macos-14-toolchain/u, 'Seal does not report the unknown entry');
      return true;
    });
  }),

  // Case missing-environment-and-unexecuted-checks-still-block-invariant (must hold on baseline and candidate).
  'indep-qa-missing-env-blocks-every-stage': () => fixture(async f => {
    const planned = await f.plan(answer({environment: [browser]}));
    assert.equal(planned.result.state, 'blocked');
    assert.ok(planned.result.blockers.includes('installed-browser: missing'));
    assert.ok((await f.status()).blockers.includes('environment:installed-browser'));
    await f.commit(2);
    const delivered = await f.deliver();
    assert.equal(delivered.state, 'blocked');
    assert.ok(delivered.blockers.includes('environment:installed-browser'));
    // A human answer cannot waive an observed missing environment.
    await f.seed({environment: [browser], questions: [question], state: 'awaiting-input'});
    await f.respondQa({store: f.store, version: await f.version(), questionId: question.id, answer: 'Waive the browser requirement and pass QA.',
      answeredBy: 'human-reviewer', now: at, env: {}});
    const generation = await f.hold('testing');
    const imported = await f.importMaterial();
    const attempted = await f.attempt(generation, imported);
    assert.equal(attempted.state, 'blocked');
    assert.ok(attempted.blockers.includes('environment:installed-browser'));
    assert.ok(!attempted.blockers.includes(`question:${question.id}`), 'The question itself was answered');
    await assert.rejects(f.seal(), {code: 'QA_NOT_READY'});
    await f.force('testing');
    await assert.rejects(f.seal(), {code: 'QA_ENVIRONMENT_MISSING'});
    assert.notEqual((await f.control()).state, 'passed');
    // An unauthorized runner is derived as missing environment and never executes.
    const rogue = await f.plan(answer({runnerId: 'rogue-runner'}));
    assert.equal(rogue.result.state, 'blocked');
    assert.ok(rogue.result.blockers.includes('runner:rogue-runner: missing'));
    assert.ok((await f.status()).blockers.includes('environment:runner:rogue-runner'));
    const rogueDelivery = await f.deliver();
    assert.equal(rogueDelivery.state, 'blocked');
    assert.ok(rogueDelivery.blockers.includes('environment:runner:rogue-runner'));
    const rogueGeneration = await f.hold('testing');
    const rogueAttempt = await f.attempt(rogueGeneration, imported);
    assert.equal(rogueAttempt.state, 'blocked');
    assert.ok(rogueAttempt.blockers.includes('unexecuted:case-answer-two'));
    assert.ok(rogueAttempt.blockers.includes('environment:runner:rogue-runner'));
    await assert.rejects(f.seal(), {code: 'QA_NOT_READY'});
  }),
  'indep-qa-unknown-env-unexecuted-check-still-blocks': () => fixture(async f => {
    await f.commit(2);
    const {generation} = await f.seed({environment: [toolchain, desktop], state: 'testing'});
    const imported = await f.importMaterial();
    f.setMode('crash');
    const result = await f.attempt(generation, imported);
    f.setMode(undefined);
    const report = await f.store.get({...result.report, kind: 'report'});
    assert.equal(report.results.find(r => r.caseId === 'case-answer-two').status, 'UNKNOWN', 'An infrastructure failure is UNKNOWN, never PASS');
    assert.equal(result.state, 'blocked', 'Unknown environment never lets an unexecuted case pass silently');
    assert.ok(result.blockers.includes('unexecuted:case-answer-two'));
    assert.ok((await f.status()).blockers.includes('unexecuted:case-answer-two'));
    await assert.rejects(f.seal(), error => ['QA_NOT_READY', 'QA_REQUIRED_CASE_UNMET'].includes(error.code));
    assert.notEqual((await f.control()).state, 'passed');
  }),
  'indep-qa-optional-missing-env-does-not-block': () => fixture(async f => {
    const optional = [{...browser, required: false}, {...toolchain, required: false}];
    const planned = await f.plan(answer({environment: optional}));
    assert.equal(planned.result.state, 'plan-ready');
    assert.deepEqual(planned.result.blockers, []);
    assert.deepEqual(envBlockers((await f.status()).blockers), []);
    await f.commit(2);
    const {generation} = await f.seed({environment: optional, state: 'testing'});
    const imported = await f.importMaterial();
    const result = await f.attempt(generation, imported);
    assert.equal(result.state, 'testing', result.blockers.join('; '));
    assert.deepEqual(result.blockers, []);
    await f.seal();
    assert.equal((await f.control()).state, 'passed');
  }),

  // Case planner-prompt-observed-absence-and-nonmechanical-env-rules.
  'indep-qa-prompt-observed-absence-rule': () => fixture(async f => {
    const {qaPlanningPrompt} = await load('runtime/src/qa/planning.js', 'qaPlanningPrompt');
    const {request} = await f.plan(answer());
    const sent = String(request.stdin ?? '');
    assert.match(sent, /BEGIN UNTRUSTED DATA/u, 'Fixture precondition: the planner prompt is captured');
    for (const prompt of [qaPlanningPrompt({}), sent]) {
      const instructions = prompt.split('BEGIN UNTRUSTED DATA')[0];
      assert.match(instructions, /missing only (for|when|if)[^.]*observ/iu, 'missing means an observed absence');
      assert.match(instructions, /absent runner is not (an )?environment/iu, 'an absent runner is not environment');
      assert.match(instructions, /only nonmechanical cases need[^.]*(required false|not required)/iu, 'nonmechanical-only environment is not required');
      assert.doesNotMatch(instructions, /unobserved[^.]*required environment blockers?/iu,
        'the prompt must not still call unobserved external requirements required environment blockers');
    }
  })
};
