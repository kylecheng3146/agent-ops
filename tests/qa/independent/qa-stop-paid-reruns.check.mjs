// Independent QA for task-56623dfd-fd20-44d2-8adc-dac09321d9aa: stop paying for QA reruns that change nothing QA tested.
// A surface-only revise, an unchanged 1.4.1 seal after upgrading and a config edit outside the QA binding keep sealed QA;
// discovery skips unmodified QA-imported materials; unsealed QA stops on an unready surface before any paid session;
// review and batch run zero-spend QA (reuse or re-execute, never a planner or author) before their QA gate.
// Run by tests/qa/acceptance.mjs from a built checkout (dist/, or AGENT_OPS_DEBUG_TEST_BUILD). Every fixture is a disposable temp repo.
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmod, mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter, dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
// A missing module or export is an assertion failure the controller can see, never a collection-time import error.
async function load(path, ...names) {
  const mod = await import(pathToFileURL(join(build, path)).href).catch(() => ({}));
  for (const name of names) assert.equal(typeof mod[name], 'function', `${path} must export ${name}`);
  return mod;
}
const sha = value => createHash('sha256').update(value).digest('hex');
const at = '2026-11-24T00:00:00.000Z';
const qaRunner = {id: 'qa-runner', command: process.execPath, args: ['{materials}'], cwd: '.', adapter: 'generic'};
const config = (extra = {}) => ({schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: [
  {id: 'tests', command: process.execPath, args: ['test.mjs'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}]},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [], qa: {enabled: true}, ...extra});
const withRunner = (extra = {}) => config({verification: {...config().verification, acceptanceRunners: [qaRunner]}, ...extra});
const scenarios = {initialState: {applies: true, behavior: 'First delivery of the answer'}, redo: {na: 'The fixture never replays a delivery'},
  timeBoundary: {na: 'Nothing in the fixture depends on dates'}, identitySwitch: {na: 'The fixture has a single task store'},
  concurrency: {na: 'The fixture has a single writer'}};
const axes = {dependents: {na: 'Nothing in the fixture imports the answer'}, duplicates: {na: 'The fixture has no copied answer logic'},
  otherPaths: {na: 'The fixture has one entry point'}, sharedState: {na: 'The fixture stores no shared state'}};
const audit = (extra = {}) => ({axes, included: [{id: 'app', path: 'src/app.mjs', behavior: 'Returns the answer'}], excluded: [], unknown: [],
  contracts: [], valueChanges: [], scenarios, ...extra});
/** Every surface-classification field changes; the included {id, path} set does not. */
const reclassified = () => audit({
  axes: {...axes, dependents: {queries: ['answerReaderQuery']}, sharedState: {na: 'The answer is computed on every call and never cached'}},
  included: [{id: 'app', path: 'src/app.mjs', behavior: 'Returns the corrected answer to every caller'}],
  excluded: [{glob: 'src/other.mjs', reason: 'Shares a helper name only; it never reads the answer'}],
  dismissed: [{query: 'qaRerunIncidental', reason: 'Appears only in fixture comments that never execute'}],
  unknown: [{id: 'dashboard', reader: 'A dashboard outside this repository', behavior: 'May display the answer'}],
  contracts: [{id: 'answer-fn', name: 'answer()', change: 'compatible', behavior: 'Same signature, corrected value'}],
  valueChanges: [{producer: 'answer()', kind: 'normalize', change: 'Returns 2 instead of 1', consumers: ['Callers of answer()'], indirectConsumers: []}],
  scenarios: {...scenarios, redo: {applies: true, behavior: 'Re-running gives the same corrected answer'}},
  lessons: {'lesson-fixture': {na: 'No escape lesson describes this fixture'}}});
const criteria = [{id: 'behavior', description: 'Observable behavior', verifierIds: ['tests']},
  {id: 'compatibility', description: 'Compatible readers', verifierIds: ['tests']}];
const session = {host: 'claude', sessionId: 'qa-author', implementationSessionId: 'developer', implementationHost: 'codex', writable: true, fallbackReason: null};
const usage = {inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null};
const unready = () => Object.assign(new Error('surface not ready'), {code: 'QA_SURFACE_NOT_READY'});
const question = {id: 'q-audience', prompt: 'Who reads the answer?', required: true, criterionIds: ['behavior']};
const docsCase = {id: 'case-docs', criterionIds: ['behavior'], surfaceIds: [], required: true, mode: 'nonmechanical', preconditions: [],
  actions: ['Read the guide'], expected: 'The guide is accurate', bindings: [], nonmechanicalReason: 'Prose accuracy needs human judgment'};
const materialFor = name => `tests/qa-independent/${name}.test.mjs`;
const answerCase = (path = materialFor('answer')) => ({id: 'case-answer', criterionIds: ['behavior'], surfaceIds: ['app'], required: true, mode: 'behavioral',
  preconditions: ['An enrolled delivery'], actions: ['Ask for the answer'], expected: 'The answer is two',
  bindings: [{runnerId: 'qa-runner', checkIds: ['answer-two'], redCheckIds: ['answer-two'], materials: [{path, role: 'test'}]}]});
/** Test-only material speaking the generic acceptance protocol (what a QA author would have committed); never production code. */
const ANSWER_TEST = `import {answer} from '../../src/app.mjs';
const executionId = process.env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID, phase = process.env.AGENT_OPS_ACCEPTANCE_PHASE;
const requested = (process.env.AGENT_OPS_ACCEPTANCE_CHECKS ?? '').split(',').filter(Boolean);
const checks = {'answer-two': answer() === 2};
const results = Object.entries(checks).filter(([id]) => requested.length === 0 || requested.includes(id)).map(([checkId, ok]) => ({executionId,
  framework: 'qa-fixture', frameworkVersion: '1', checkId, phase, status: ok ? 'PASS' : 'FAIL', failureClass: ok ? 'none' : 'assertion-failed',
  attempts: 1, evidence: [checkId + ' observed']}));
console.log(JSON.stringify({protocolVersion: 1, executionId, framework: 'qa-fixture', frameworkVersion: '1', phase, results,
  completed: true, completionEvidence: ['qa fixture finished'], diagnostics: []}));
process.exitCode = results.some(r => r.status === 'FAIL') ? 1 : 0;
`;

// ---------------------------------------------------------------------------------------------------------------- fixtures

async function repo(check, files = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-rerun-')));
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const gitRunner = {run: async args => {
    try {return {exitCode: 0, stdout: Buffer.from(execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']}))};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: Buffer.from(e.stdout ?? '')};}
  }};
  const write = async (path, text) => {await mkdir(dirname(join(root, path)), {recursive: true}); await writeFile(join(root, path), text);};
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    await write('.gitignore', '.agent-ops/\n');
    await write('src/app.mjs', 'export const answer = () => 1;\n');
    // A product file outside the diff whose only shared token lives in QA-authored tests or a later product change.
    await write('src/other.mjs', 'export const otherOnlyTokenAlpha = 1;\n');
    await write('test.mjs', 'process.exitCode = 0;\n');
    for (const [path, text] of Object.entries(files)) await write(path, text);
    git(['add', '.']); git(['commit', '-qm', 'baseline']);
    await check({root, git, gitRunner, write, baseline: git(['rev-parse', 'HEAD'])});
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(root + '-checkouts', {recursive: true, force: true});
  }
}

/** A task store and service in the repo; tasks created here record the baseline as their creation commit. */
async function taskFixture(check, {configured = config(), files = {}} = {}) {
  await repo(async f => {
    const {TaskService} = await load('runtime/src/task/service.js', 'TaskService');
    const {FileTaskStore} = await load('runtime/src/task/store.js', 'FileTaskStore');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    await f.write('.agent-ops/config.json', JSON.stringify(configured));
    const tasks = new FileTaskStore(join(f.root, '.agent-ops/tasks/state.json'), f.root);
    let id = 0, active = configured;
    const service = new TaskService(tasks, {generateId: () => `task-qa-rerun-${++id}`, now: () => at, platform: 'darwin',
      completion: {root: f.root, gitRunner: f.gitRunner, loadConfig: async () => structuredClone(active)}});
    /** The project config the task service and CLI boundaries read from now on. */
    const setConfig = async cfg => {active = cfg; await f.write('.agent-ops/config.json', JSON.stringify(cfg));};
    const records = async () => (await tasks.read()).tasks;
    const record = async taskId => (await records()).find(r => r.task.id === taskId);
    /** Commits a product change: the candidate QA is sealed for. */
    const candidate = async (text = 'export const answer = () => 2;\n') => {
      await f.write('src/app.mjs', text); f.git(['commit', '-qam', 'candidate']);
      return f.git(['rev-parse', 'HEAD']);
    };
    /** A live covers child, bound to the project config like the CLI binds it. */
    const child = async (parentTaskId, covers = ['app']) => {
      const {calculateConfigHash} = await load('runtime/src/config/hash.js', 'calculateConfigHash');
      return await service.create({title: 'Child', goal: 'Answer correctly', criteria, parentTaskId, surface: {covers},
        policyConfigHash: calculateConfigHash(active)});
    };
    await check({...f, service, tasks, records, record, candidate, configured, setConfig, child, store: new FileQaStore(join(f.root, '.git'))});
  }, files);
}

/** The source fingerprint the status reader and verify recompute for the task's creation base. */
async function fingerprint(f, base = f.baseline) {
  const {resolveReviewScope} = await load('runtime/src/review/scope.js', 'resolveReviewScope');
  const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js', 'calculateSourceFingerprint');
  return await calculateSourceFingerprint(f.root, await resolveReviewScope({root: f.root, runner: f.gitRunner, base}), f.gitRunner);
}

/** Writes the next QA control revision, keeping every field the patch does not name. */
async function setControl(store, taskId, patch) {
  const c = await store.readControl(taskId);
  const base = c ?? {schemaVersion: 1, taskId, revision: 0, generation: 1, state: 'testing', continuation: true, owner: null, plan: null,
    attempt: null, report: null, attestation: null, progress: null, updatedAt: at};
  return await store.updateControl(taskId, c?.revision ?? 0, () => ({...base, ...patch, revision: (c?.revision ?? 0) + 1, updatedAt: at}));
}
/** Restores a saved control snapshot as the next revision (nothing about its content changes). */
async function restoreControl(store, snapshot) {
  const c = await store.readControl(snapshot.taskId);
  return await store.updateControl(snapshot.taskId, c.revision, () => ({...snapshot, revision: c.revision + 1}));
}

async function savePlan(f, version, taskIds, {cases = [docsCase], questions = [question], id = 'plan-rerun'} = {}) {
  return await f.store.put('plan', {schemaVersion: 1, id, version, originalGoal: 'Answer correctly', taskIds, dependencyTaskIds: [], scope: 'full',
    session: {...session, sessionId: 'qa-planner', writable: false}, createdAt: at, timing: 'late', advisoryReferences: [], cases,
    scenarios, environment: [], questions});
}
/** An attempt and PASS report for the nonmechanical docs case, bound to `version`. */
async function saveTested(f, version, plan, n = 'rerun') {
  const head = f.git(['rev-parse', 'HEAD']);
  const attempt = await f.store.put('attempt', {schemaVersion: 1, id: `attempt-${n}`, version, generation: 1, plan, session, startedAt: at,
    finishedAt: at, materials: [], materialDigest: 'c'.repeat(64), executions: [], usage, lineage: {authoredCommit: head, importedCommit: head}});
  const report = await f.store.put('report', {schemaVersion: 1, id: `report-${n}`, version, attempt, createdAt: at,
    results: [{caseId: 'case-docs', status: 'PASS', executions: [], observations: ['Read and judged accurate']}], findings: [], questions: []});
  return {attempt, report};
}

/**
 * The real controller path to a sealed PASS whose plan asked a required question: plan, human answer (respondQa),
 * tested attempt and report, then sealQaAttestation. Returns the sealed control snapshot and its references.
 */
async function sealWithQuestion(f, version, tasks) {
  const {respondQa} = await load('runtime/src/qa/decisions.js', 'respondQa');
  const {sealQaAttestation} = await load('runtime/src/qa/proof.js', 'sealQaAttestation');
  const plan = await savePlan(f, version, tasks.map(t => t.id));
  await setControl(f.store, version.taskId, {state: 'awaiting-input', plan, attempt: null, report: null, attestation: null, decisions: []});
  await respondQa({store: f.store, version, questionId: question.id, answer: 'Everyone who calls answer()', answeredBy: 'human', now: at, env: {}});
  const {attempt, report} = await saveTested(f, version, plan);
  await setControl(f.store, version.taskId, {state: 'testing', attempt, report});
  const sealed = await sealQaAttestation({store: f.store, version, tasks, gitRunner: f.gitRunner, now: () => at});
  assert.equal(sealed.reused, false, 'The fixture seals a fresh attestation');
  return {plan, attempt, report, attestation: sealed.attestation, snapshot: await f.store.readControl(version.taskId)};
}
/** The saved plan waits for a human again; the answer is checked against `version` and the sealed state is restored after. */
async function respondOnSavedPlan(f, sealed, version) {
  const {respondQa} = await load('runtime/src/qa/decisions.js', 'respondQa');
  await setControl(f.store, sealed.snapshot.taskId, {state: 'awaiting-input', plan: sealed.plan, attempt: null, report: null, attestation: null, decisions: []});
  try {return await respondQa({store: f.store, version, questionId: question.id, answer: 'Everyone', answeredBy: 'human', now: at, env: {}});}
  finally {await restoreControl(f.store, sealed.snapshot);}
}

/** runQaDelivery options whose planner and author are spies: any session start is counted and no model ever runs. */
function delivery(f, records, rootTaskId, fp, extra = {}) {
  const spy = {planner: 0, author: 0, surface: 0};
  const planningRunner = {start() {
    spy.planner++;
    return {pid: null, stdout: (async function* () {yield Buffer.from('{}');})(), stderr: (async function* () {})(),
      completion: Promise.resolve({exitCode: 1, signal: null}), terminateTree: async () => {}};
  }};
  const options = {store: f.store, root: f.root, rootTaskId, records, config: f.configured ?? config(), trusted: false,
    fingerprint: typeof fp === 'function' ? fp : async () => fp, gitRunner: f.gitRunner, processRunner: planningRunner, planningRunner,
    evidenceStore: null, controllerId: 'qa-controller-rerun', available: ['claude'], implementationHost: 'codex', implementationSessionId: 'developer',
    advisory: null, host: () => {spy.author++; throw new Error('No author session may start in this fixture');}, platform: 'darwin', now: () => at,
    checkouts: f.root + '-checkouts', ...extra};
  return {spy, options};
}
const counting = (spy, outcome) => async () => {spy.surface++; if (outcome === 'throw') throw unready();};

/** With an isolated AGENT_OPS_HOME so no user config (or real review host) can leak into a CLI-boundary call. */
async function isolatedHome(run) {
  const previous = process.env.AGENT_OPS_HOME, home = await mkdtemp(join(tmpdir(), 'agent-ops-qa-rerun-home-'));
  process.env.AGENT_OPS_HOME = home;
  try {return await run(home);}
  finally {
    if (previous === undefined) delete process.env.AGENT_OPS_HOME; else process.env.AGENT_OPS_HOME = previous;
    await rm(home, {recursive: true, force: true});
  }
}

/** Test-only two-session PASS review, so the finish receipt can be observed; never production review output. */
async function reviewed(f, task, fp, head) {
  const {saveReviewAttestation, saveReviewReportArtifact, reviewReportDigest} = await load('runtime/src/review/attestation.js',
    'saveReviewAttestation', 'saveReviewReportArtifact', 'reviewReportDigest');
  const {taskContractHash, goalHash} = await load('runtime/src/task/contract.js', 'taskContractHash', 'goalHash');
  const report = {summary: 'Reviewed current candidate', results: task.criteria.map(c => ({criterionId: c.id, status: 'PASS', summary: 'ok', evidence: ['src/app.mjs:1']})),
    findings: [], residualRisks: [], changedFilesInspected: ['src/app.mjs'], supportingFilesInspected: []};
  const second = {...report, summary: 'Adversarial recheck'};
  const result = {status: 'PASS', harness: 'agy', plannedTargets: ['agy', 'agy'], sessionIsolation: 'fresh',
    attempts: [{target: 'agy', status: 'PASS', sessionId: 'first-fresh'}, {target: 'agy', status: 'PASS', sessionId: 'second-fresh'}],
    preflight: [], report, adversarial: {target: 'agy', refuted: false, report: second}};
  const binding = {taskContractHash: taskContractHash(task), taskContracts: {[task.id]: taskContractHash(task)}, goalHash: goalHash(task),
    candidateCommit: head, coverageDigest: sha('fixture coverage')};
  const reportArtifact = await saveReviewReportArtifact(f.root, result, fp, task.id, undefined, binding);
  await saveReviewAttestation(f.root, {schemaVersion: 3, ...binding, taskId: task.id, harness: 'agy', status: 'PASS', sourceFingerprint: fp,
    reviewTargets: ['agy', 'agy'], reviewSessionIds: ['first-fresh', 'second-fresh'], sessionIsolation: 'fresh',
    primaryReportDigest: reviewReportDigest(report), adversarialReportDigest: reviewReportDigest(second), reportArtifact, createdAt: at});
}
/** Fresh verification and review for each task under `cfg`, then the real finish receipt; returns its QA proof for rootId. */
async function finishReceipt(f, taskIds, rootId, cfg) {
  const {VerificationService} = await load('runtime/src/verify/service.js', 'VerificationService');
  const {NodeVerificationProcessRunner} = await load('runtime/src/verify/spawn.js', 'NodeVerificationProcessRunner');
  const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js', 'FileEvidenceStore');
  const {prepareFinishReceipt} = await load('runtime/src/parallel/receipt.js', 'prepareFinishReceipt');
  const fp = await fingerprint(f), head = f.git(['rev-parse', 'HEAD']);
  for (const id of taskIds) {
    await new VerificationService({root: f.root, scope: 'project', config: cfg, gitRunner: f.gitRunner, processRunner: new NodeVerificationProcessRunner(),
      taskService: f.service, evidenceStore: new FileEvidenceStore(f.root, f.root), trusted: true, base: f.baseline}).verify(id);
    await reviewed(f, (await f.record(id)).task, fp, head);
  }
  const records = await f.records();
  const {receipt} = await prepareFinishReceipt({commonDir: join(f.root, '.git'), record: {path: f.root, sessionId: 'developer-session'},
    candidateHead: head, targetCommit: f.baseline, expectedFingerprint: fp, tasks: taskIds.map(id => records.find(r => r.task.id === id)),
    children: [], config: cfg, gitRunner: f.gitRunner});
  return receipt.qa?.[rootId];
}

/**
 * Every downstream QA consumer treats the sealed attestation as current for `now`: version and contract matching, reuse with no
 * session or surface check, the delivery gate, status (root and covered children), show, qa show, the review artifact, the
 * finish receipt and a human answer on the saved plan.
 */
async function expectSealCurrent(f, {label, rootId, coveredIds = [], taskIds, sealedVersion, planVersion, now, attestation, sealed, cfg, fp}) {
  const {checkQaDeliveryEvidence, qaReviewArtifact} = await load('runtime/src/qa/gate.js', 'checkQaDeliveryEvidence', 'qaReviewArtifact');
  const {qaVersionMatches} = await load('runtime/src/qa/policy.js', 'qaVersionMatches');
  const {currentQaAttestation, qaContractsMatch} = await load('runtime/src/qa/proof.js', 'currentQaAttestation', 'qaContractsMatch');
  const {runQaDelivery} = await load('runtime/src/qa/delivery.js', 'runQaDelivery');
  const {qaStatus} = await load('runtime/src/qa/status.js', 'qaStatus');
  const {showQa} = await load('runtime/src/qa/decisions.js', 'showQa');
  const {runQaCommand} = await load('packages/cli/src/commands/qa.js', 'runQaCommand');
  const {parseArgs} = await load('packages/cli/src/args.js', 'parseArgs');
  assert.ok(qaVersionMatches(sealedVersion, now), `${label}: qaVersionMatches keeps the sealed version current`);
  assert.ok(qaContractsMatch(planVersion, now), `${label}: qaContractsMatch keeps the saved plan current`);
  assert.deepEqual(await currentQaAttestation(f.store, now), attestation, `${label}: currentQaAttestation returns the seal`);
  const records = await f.records();
  const {spy, options} = delivery(f, records, rootId, fp, {config: cfg});
  const result = await runQaDelivery({...options, surfaceCheck: counting(spy, 'throw')});
  assert.equal(result.state, 'passed', `${label}: runQaDelivery reuses the sealed PASS`);
  assert.equal(result.sessions, 0, `${label}: reuse spends no session`);
  assert.deepEqual(spy, {planner: 0, author: 0, surface: 0}, `${label}: reuse starts no planner, author or surface check`);
  assert.equal(await checkQaDeliveryEvidence(records.find(r => r.task.id === rootId), {root: f.root, config: cfg, sourceFingerprint: fp, records,
    platform: 'darwin'}), null, `${label}: the delivery gate accepts the seal`);
  const current = {root: f.root, loadConfig: async () => structuredClone(cfg), base: f.baseline, gitRunner: f.gitRunner};
  for (const id of [rootId, ...coveredIds])
    assert.equal((await qaStatus(f.store, records, id, current)).outcome, 'PASS', `${label}: qaStatus reads PASS for ${id}`);
  assert.equal((await showQa(f.store, rootId, now)).stale, false, `${label}: showQa reads not stale`);
  const shown = await runQaCommand({args: parseArgs(['qa', 'show', '--task', rootId]), root: f.root,
    deliver: async () => assert.fail('qa show never delivers'), adopt: async () => assert.fail('qa show never adopts'),
    loadConfig: async () => structuredClone(cfg), fingerprint: async () => fp, inRun: false, now: () => at});
  assert.equal(shown.code, 'QA_SHOWN', `${label}: qa show succeeds`);
  assert.equal(shown.data?.status?.outcome, 'PASS', `${label}: qa show reports PASS, not STALE`);
  const artifact = await qaReviewArtifact(f.store, records.find(r => r.task.id === rootId), now, f.root);
  assert.equal(JSON.parse(artifact.content).proof.attestation, attestation.digest, `${label}: the review artifact carries the seal`);
  const proof = await finishReceipt(f, taskIds, rootId, cfg);
  assert.equal(proof?.attestation, attestation.digest, `${label}: the finish receipt seals the QA proof`);
  const answered = await respondOnSavedPlan(f, sealed, now);
  assert.ok(answered.decisions?.length >= 1, `${label}: respondQa records a human answer on the saved plan`);
}

/** Every QA consumer treats `now` as a different QA contract than the seal and the saved plan. */
async function expectSealStale(f, {label, rootId, records, sealedVersion, planVersion, now, cfg, fp, contract = true}) {
  const {checkQaDeliveryEvidence} = await load('runtime/src/qa/gate.js', 'checkQaDeliveryEvidence');
  const {qaVersionMatches} = await load('runtime/src/qa/policy.js', 'qaVersionMatches');
  const {currentQaAttestation, qaContractsMatch} = await load('runtime/src/qa/proof.js', 'currentQaAttestation', 'qaContractsMatch');
  const {qaStatus} = await load('runtime/src/qa/status.js', 'qaStatus');
  const {showQa} = await load('runtime/src/qa/decisions.js', 'showQa');
  assert.ok(!qaVersionMatches(sealedVersion, now), `${label}: qaVersionMatches is false`);
  if (contract) assert.ok(!qaContractsMatch(planVersion, now), `${label}: qaContractsMatch is false`);
  assert.equal(await currentQaAttestation(f.store, now), null, `${label}: currentQaAttestation is null`);
  if (records !== undefined) {
    assert.equal((await checkQaDeliveryEvidence(records.find(r => r.task.id === rootId), {root: f.root, config: cfg, sourceFingerprint: fp, records,
      platform: 'darwin'}))?.code, 'QA_REQUIRED', `${label}: the delivery gate requires QA`);
    const current = {root: f.root, loadConfig: async () => structuredClone(cfg), base: f.baseline, gitRunner: f.gitRunner};
    assert.equal((await qaStatus(f.store, records, rootId, current)).outcome, 'STALE', `${label}: qaStatus reads STALE`);
  }
  assert.equal((await showQa(f.store, rootId, now)).stale, true, `${label}: showQa reads stale`);
}
async function expectRespondStale(f, sealed, now, label) {
  await assert.rejects(respondOnSavedPlan(f, sealed, now), {code: 'QA_PLAN_STALE'}, `${label}: respondQa rejects the stale plan`);
}

// ---------------------------------------------------------------------------------------------------------------- materials

/** The real controller import: QA-authored bytes copied from an author checkout and committed with the import subject. */
async function realImport(f, taskId, files, caseIds = ['case-answer']) {
  const {importQaMaterials, qaMaterialDigest} = await load('runtime/src/qa/materials.js', 'importQaMaterials', 'qaMaterialDigest');
  const checkout = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-rerun-author-')));
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(checkout, path)), {recursive: true}); await writeFile(join(checkout, path), text);
    }
    const materials = Object.entries(files).map(([path, text]) => ({path, role: 'test', digest: sha(text), caseIds}));
    const inspected = {authoredCommit: f.git(['rev-parse', 'HEAD']), materials, materialDigest: qaMaterialDigest(materials), requestedEdits: []};
    return await importQaMaterials({checkout, target: f.root, inspected, taskId});
  } finally {await rm(checkout, {recursive: true, force: true});}
}
/** Commits files with the controller's import subject without going through importQaMaterials (spoofs and unrecorded imports). */
function subjectImport(f, taskId, files, subject = `test(qa): import independent QA materials for ${taskId}`) {
  return (async () => {
    for (const [path, text] of Object.entries(files)) await f.write(path, text);
    f.git(['add', ...Object.keys(files)]);
    f.git(['commit', '-qm', `${subject}\n\nQA-Material-Digest: ${'f'.repeat(64)}`]);
    return f.git(['rev-parse', 'HEAD']);
  })();
}
/** Saves an attempt naming `materials` for taskId (optionally under a plan and lineage) and makes it that task's current attempt. */
async function recordAttempt(store, taskId, materials, {id, plan = {kind: 'plan', digest: 'd'.repeat(64)}, version, lineage, materialDigest = 'f'.repeat(64)} = {}) {
  version ??= {taskId, goalHash: 'a'.repeat(64), taskContractHash: 'b'.repeat(64), treeContractHash: 'b'.repeat(64), scopeHash: 'c'.repeat(64),
    policyHash: 'a'.repeat(64), configHash: 'd'.repeat(64), candidateCommit: '0'.repeat(40), sourceFingerprint: 'e'.repeat(64)};
  const attempt = await store.put('attempt', {schemaVersion: 1, id: id ?? `attempt-${taskId}`, version, generation: 1, plan, session, startedAt: at,
    finishedAt: at, materials, materialDigest, executions: [], usage, ...(lineage === undefined ? {} : {lineage})});
  await setControl(store, taskId, {attempt});
  return attempt;
}
const recorded = files => Object.entries(files).map(([path, text]) => ({path, role: 'test', digest: sha(text)}));
async function surfaceFixture(check, files) {
  await repo(async f => {
    const {runSurfaceGate} = await load('runtime/src/surface/discovery.js', 'runSurfaceGate');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const gate = (surface, taskId = 'task-qa-rerun-root') => runSurfaceGate({root: f.root, taskId, surface, required: true, base: f.baseline,
      changedFiles: f.git(['diff', '--name-only', f.baseline]).split('\n').filter(Boolean), configHash: 'x'});
    await check({...f, gate, store: new FileQaStore(join(f.root, '.git'))});
  }, files);
}
const unclassified = (result, path, label) => {
  assert.equal(result.status, 'NOT_RUN', `${label}: review would stop`);
  assert.equal(result.code, 'SURFACE_UNCLASSIFIED', `${label}: the stop names an unclassified surface`);
  assert.ok(JSON.stringify(result.details).includes(path), `${label}: the stop names ${path}`);
};

// ---------------------------------------------------------------------------------------------------------------- checks

/** Surface-only revise after sealing, for a standalone root or a root with its live covers child. */
async function surfaceReviseKeepsSeal(withChild) {
  await taskFixture(async f => {
    const {qaDeliveryVersion, qaDeliveryTree} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion', 'qaDeliveryTree');
    const {taskContractHash} = await load('runtime/src/task/contract.js', 'taskContractHash');
    const root = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    assert.ok(root.task.qa, 'The fixture root is an enrolled delivery');
    const child = withChild ? await f.child(root.task.id) : null;
    const head = await f.candidate(), fp = await fingerprint(f);
    const tree = async () => qaDeliveryTree(await f.records(), root.task.id).map(r => r.task);
    const version = tasks => qaDeliveryVersion({tasks, config: config(), candidateCommit: head, sourceFingerprint: fp});
    const sealedTasks = await tree();
    assert.deepEqual(sealedTasks.map(t => t.id), [root.task.id, ...(child ? [child.task.id] : [])], 'The delivery tree is the root and its covers child');
    const sealedVersion = version(sealedTasks);
    const sealed = await sealWithQuestion(f, sealedVersion, sealedTasks);
    const revised = await f.service.revise(root.task.id, {expectedContractHash: taskContractHash(root.task), reason: 'Classify discovery hits',
      surface: reclassified()});
    assert.notEqual(taskContractHash(revised.task), taskContractHash(root.task), 'Review still sees a new full task contract');
    assert.notEqual(revised.task.contractRevision ?? 0, root.task.contractRevision ?? 0, 'The revise bumped contractRevision');
    assert.deepEqual(revised.task.surface.included.map(r => ({id: r.id, path: r.path})), [{id: 'app', path: 'src/app.mjs'}]);
    const label = withChild ? 'root+child tree' : 'standalone root';
    await expectSealCurrent(f, {label, rootId: root.task.id, coveredIds: child ? [child.task.id] : [], taskIds: (await tree()).map(t => t.id),
      sealedVersion, planVersion: (await f.store.get(sealed.plan)).version, now: version(await tree()), attestation: sealed.attestation, sealed,
      cfg: config(), fp});
  });
}

/** Ten tracked QA contract inputs of a root+covers tree, each mutated alone. */
const trackedMutations = (r, c) => {
  const surface = r.task.surface;
  return {
    'new included surface': [{...r.task, surface: {...surface, included: [...surface.included, {id: 'cli', path: 'src/other.mjs', behavior: 'Prints the answer'}]}}, c.task],
    'moved included path': [{...r.task, surface: {...surface, included: [{...surface.included[0], path: 'src/moved.mjs'}]}}, c.task],
    'renamed included id': [{...r.task, surface: {...surface, included: [{...surface.included[0], id: 'app-renamed'}]}}, c.task],
    'child covers': [r.task, {...c.task, surface: {covers: ['app', 'cli']}}],
    criteria: [{...r.task, criteria: [...r.task.criteria, {id: 'extra', description: 'Another behavior', verifierIds: ['tests']}]}, c.task],
    intent: [{...r.task, intent: 'A different intended behavior'}, c.task],
    goal: [{...r.task, goal: 'Answer something else'}, c.task],
    title: [{...r.task, title: 'A different title'}, c.task],
    debug: [{...r.task, debug: {rootTaskId: r.task.id, facts: ['A new fact'], unknowns: []}}, c.task],
    'qa policy': [{...r.task, qa: {...r.task.qa, policyHash: 'f'.repeat(64)}}, c.task]
  };
};

/** Delivery spies plus a trusted generic runner that really executes committed QA material. */
async function trustedDelivery(f, records, rootTaskId, extra = {}) {
  const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js', 'FileEvidenceStore');
  const {NodeVerificationProcessRunner} = await load('runtime/src/verify/spawn.js', 'NodeVerificationProcessRunner');
  return delivery(f, records, rootTaskId, () => fingerprint(f), {trusted: true, processRunner: new NodeVerificationProcessRunner(),
    evidenceStore: new FileEvidenceStore(f.root, f.root), ...extra});
}
/** A current plan for one behavioral case and the committed QA material an earlier author left for it (real import). */
async function plannedWithMaterial(f, task, cfg, path) {
  const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
  const imported = await realImport(f, task.id, {[path]: ANSWER_TEST});
  const version = qaDeliveryVersion({tasks: [task], config: cfg, candidateCommit: imported.lineage.importedCommit, sourceFingerprint: await fingerprint(f)});
  const plan = await savePlan(f, version, [task.id], {cases: [answerCase(path)], questions: [], id: `plan-${task.id}`});
  await setControl(f.store, task.id, {state: 'testing', plan, report: null, attestation: null, decisions: []});
  await recordAttempt(f.store, task.id, imported.materials, {id: `attempt-${task.id}`, plan, version, lineage: imported.lineage,
    materialDigest: imported.materialDigest});
  return {plan, imported};
}

export const checks = {
  'qa-rerun-surface-revise-reuses-root-and-tree-seal': async () => {
    await surfaceReviseKeepsSeal(false);
    await surfaceReviseKeepsSeal(true);
  },

  // Invariant (baseline and candidate): every tracked QA contract input still voids the seal and the saved plan.
  'qa-rerun-tracked-contract-changes-stale-qa': () => taskFixture(async f => {
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {sealQaAttestation} = await load('runtime/src/qa/proof.js', 'sealQaAttestation');
    const root = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const child = await f.service.create({title: 'Child', goal: 'Answer correctly', criteria, parentTaskId: root.task.id, surface: {covers: ['app']}});
    const head = await f.candidate(), fp = await fingerprint(f);
    const records = await f.records();
    const r = records.find(x => x.task.id === root.task.id), c = records.find(x => x.task.id === child.task.id);
    const version = tasks => qaDeliveryVersion({tasks, config: config(), candidateCommit: head, sourceFingerprint: fp});
    const sealedVersion = version([r.task, c.task]);
    const sealed = await sealWithQuestion(f, sealedVersion, [r.task, c.task]);
    const planVersion = (await f.store.get(sealed.plan)).version;
    // Positive control: the unchanged tree is current and the saved plan accepts an answer.
    assert.ok((await respondOnSavedPlan(f, sealed, version([r.task, c.task]))).decisions.length >= 1, 'Unchanged: respondQa accepts');
    const mutations = trackedMutations(r, c);
    for (const [field, tasks] of Object.entries(mutations)) {
      const now = version(tasks);
      await expectSealStale(f, {label: field, rootId: r.task.id, records: [{...r, task: tasks[0]}, {...c, task: tasks[1]}], sealedVersion, planVersion,
        now, cfg: config(), fp});
      await expectRespondStale(f, sealed, now, field);
    }
    // Seal-time proof validation: a tested state for the original contracts cannot be sealed for a changed root or tree.
    const tested = await saveTested(f, sealedVersion, sealed.plan, 'reseal');
    await setControl(f.store, r.task.id, {state: 'testing', attestation: null, ...tested});
    for (const [field, tasks] of Object.entries(mutations))
      await assert.rejects(sealQaAttestation({store: f.store, version: sealedVersion, tasks, gitRunner: f.gitRunner, now: () => at}),
        {code: 'QA_PROOF_STALE'}, `${field}: sealQaAttestation rejects the changed contract`);
  }),

  // Invariant (baseline and candidate): what 1.4.1 sealed for unchanged inputs stays current; any tracked change voids it.
  'qa-rerun-legacy-1-4-1-compat-and-invalidation': () => taskFixture(async f => {
    const {qaDeliveryVersion, qaDeliveryTree} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion', 'qaDeliveryTree');
    const {sealQaAttestation} = await load('runtime/src/qa/proof.js', 'sealQaAttestation');
    const {calculateConfigHash} = await load('runtime/src/config/hash.js', 'calculateConfigHash');
    const {taskContractHash, treeContractHash} = await load('runtime/src/task/contract.js', 'taskContractHash', 'treeContractHash');
    const surfaced = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const child = await f.child(surfaced.task.id);
    const bare = await f.service.create({title: 'Deliver bare', goal: 'Answer without a surface', criteria});
    assert.equal(bare.task.surface, undefined, 'The bare task has no surface field');
    assert.ok(bare.task.qa, 'The bare task is enrolled');
    const head = await f.candidate(), fp = await fingerprint(f);
    const tree = async id => qaDeliveryTree(await f.records(), id).map(r => r.task);
    const version = (tasks, cfg = config(), patch = {}) => qaDeliveryVersion({tasks, config: cfg, candidateCommit: head, sourceFingerprint: fp, ...patch});
    // What 1.4.1 wrote for the exact same inputs: full task and tree contract hashes and the full config hash.
    const legacyOf = tasks => ({...version(tasks), taskContractHash: taskContractHash(tasks[0]), treeContractHash: treeContractHash(tasks),
      configHash: calculateConfigHash(config())});
    for (const [label, rootId, coveredIds] of [['surfaced root+child', surfaced.task.id, [child.task.id]], ['bare root', bare.task.id, []]]) {
      const tasks = await tree(rootId), legacy = legacyOf(tasks);
      // A plan, human decision, tested attempt, report and attestation exactly as 1.4.1 stored them.
      const plan = await savePlan(f, legacy, tasks.map(t => t.id), {id: `plan-legacy-${rootId}`});
      const decision = await f.store.put('decision', {schemaVersion: 1, version: legacy, plan, questionId: question.id, answer: 'Everyone',
        answeredBy: 'human', answeredAt: at});
      const tested = await saveTested(f, legacy, plan, `legacy-${rootId}`);
      const attestation = await f.store.put('attestation', {schemaVersion: 1, version: legacy, plan, report: tested.report, executions: [],
        decisions: [decision], materialDigest: 'c'.repeat(64), caseIds: ['case-docs'], nonmechanicalCaseIds: ['case-docs'], session, generation: 1,
        sealedAt: at});
      await setControl(f.store, rootId, {state: 'passed', plan, ...tested, attestation, decisions: [decision], generation: 1});
      const sealed = {plan, attestation, snapshot: await f.store.readControl(rootId)};
      await expectSealCurrent(f, {label: `${label} (1.4.1 seal)`, rootId, coveredIds, taskIds: tasks.map(t => t.id), sealedVersion: legacy,
        planVersion: legacy, now: version(await tree(rootId)), attestation, sealed, cfg: config(), fp});
      // Sealing a current tested attempt against the legacy plan and its legacy human decision.
      const now = version(await tree(rootId));
      const current = await saveTested(f, now, plan, `current-${rootId}`);
      await setControl(f.store, rootId, {state: 'testing', plan, ...current, attestation: null, decisions: [decision]});
      const resealed = await sealQaAttestation({store: f.store, version: now, tasks: await tree(rootId), gitRunner: f.gitRunner, now: () => at});
      assert.ok(resealed.attestation?.digest, `${label}: a current attempt seals against the legacy plan and decision`);
      assert.deepEqual((await f.store.get(resealed.attestation)).decisions, [decision], `${label}: the legacy human decision is honored`);
      await restoreControl(f.store, sealed.snapshot);
      // Every tracked input still voids the legacy seal and plan.
      const records = await f.records();
      const r = records.find(x => x.task.id === rootId), c = records.find(x => x.task.id === coveredIds[0]);
      const cfgRunner = config({verification: {...config().verification, acceptanceRunners: [qaRunner]}});
      const withTasks = list => records.map(x => list.find(t => t.id === x.task.id) ? {...x, task: list.find(t => t.id === x.task.id)} : x);
      const mutated = {
        criteria: {tasks: [{...r.task, criteria: [...r.task.criteria, {id: 'extra', description: 'Another behavior', verifierIds: ['tests']}]}, ...tasks.slice(1)]},
        intent: {tasks: [{...r.task, intent: 'A different intended behavior'}, ...tasks.slice(1)]},
        goal: {tasks: [{...r.task, goal: 'Answer something else'}, ...tasks.slice(1)]},
        ...(c === undefined ? {} : {
          'included surface': {tasks: [{...r.task, surface: {...r.task.surface, included: [...r.task.surface.included,
            {id: 'cli', path: 'src/other.mjs', behavior: 'Prints the answer'}]}}, c.task]},
          'child covers': {tasks: [r.task, {...c.task, surface: {covers: ['app', 'cli']}}]}}),
        acceptanceRunners: {cfg: cfgRunner},
        'qa field': {cfg: config({qa: {enabled: true, strict: true}})},
        candidateCommit: {patch: {candidateCommit: '0'.repeat(40)}, contract: false},
        sourceFingerprint: {patch: {sourceFingerprint: '0'.repeat(64)}, contract: false}
      };
      for (const [field, m] of Object.entries(mutated)) {
        const list = m.tasks ?? tasks, cfg = m.cfg ?? config(), contract = m.contract !== false;
        const now = version(list, cfg, m.patch ?? {});
        await expectSealStale(f, {label: `${label} legacy ${field}`, rootId, records: m.patch === undefined ? withTasks(list) : undefined,
          sealedVersion: legacy, planVersion: legacy, now, cfg, fp, contract});
        if (contract) await expectRespondStale(f, sealed, now, `${label} legacy ${field}`);
      }
      // The delivery gate with another source fingerprint than the legacy seal names.
      assert.equal((await (await load('runtime/src/qa/gate.js')).checkQaDeliveryEvidence(r, {root: f.root, config: config(),
        sourceFingerprint: '0'.repeat(64), records, platform: 'darwin'}))?.code, 'QA_REQUIRED', `${label}: another source fingerprint requires QA`);
    }
    // A moved candidate: status recomputes HEAD and the fingerprint itself.
    const {qaStatus} = await load('runtime/src/qa/status.js', 'qaStatus');
    await f.candidate('export const answer = () => 2; // moved\n');
    const current = {root: f.root, loadConfig: async () => config(), base: f.baseline, gitRunner: f.gitRunner};
    for (const id of [surfaced.task.id, bare.task.id])
      assert.equal((await qaStatus(f.store, await f.records(), id, current)).outcome, 'STALE', `${id}: a moved candidate stales the legacy seal`);
  }),

  'qa-rerun-pin-finding-qa-and-legacy-hashes': () => taskFixture(async f => {
    const {loadFindingPin} = await load('runtime/src/task/pin-finding.js', 'loadFindingPin');
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {qaTaskContractHash, taskContractHash} = await load('runtime/src/task/contract.js', 'qaTaskContractHash', 'taskContractHash');
    const created = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const head = await f.candidate('export const answer = () => 3;\n');
    const base = {...qaDeliveryVersion({tasks: [created.task], config: config(), candidateCommit: head, sourceFingerprint: 'e'.repeat(64)})};
    const record = await f.service.revise(created.task.id, {expectedContractHash: taskContractHash(created.task), reason: 'Add a criterion',
      criteria: [...criteria, {id: 'extra', description: 'Another behavior', verifierIds: ['tests']}]});
    assert.ok((record.revisions ?? []).some(rev => rev.previousTask !== undefined), 'Revision history retains previousTask');
    const binding = {runnerId: 'independent-qa', checkIds: ['answer-two'], redCheckIds: ['answer-two'],
      materials: [{path: 'tests/qa/independent/answer.check.mjs', role: 'test'}]};
    let n = 0;
    /** A saved plan, attempt and failing candidate execution behind one reproducible (or not) finding. */
    const failingReport = async (patch, reproducible = true) => {
      const version = {...base, ...patch};
      const plan = await f.store.put('plan', {schemaVersion: 1, id: `plan-pin-${++n}`, version, originalGoal: 'Answer correctly', taskIds: [version.taskId],
        dependencyTaskIds: [], scope: 'full', session: {...session, sessionId: 'qa-planner', writable: false}, createdAt: at, timing: 'late',
        advisoryReferences: [], cases: [{id: 'case-answer', criterionIds: ['behavior'], surfaceIds: ['app'], required: true, mode: 'behavioral',
          preconditions: ['An enrolled delivery'], actions: ['Ask for the answer'], expected: 'The answer is two', bindings: [binding]}],
        scenarios, environment: [], questions: []});
      const executionId = `exec-pin-${n}`;
      const execution = await f.store.put('execution', {schemaVersion: 1, version, caseId: 'case-answer', runnerId: 'independent-qa',
        materialDigest: 'c'.repeat(64), evidenceReferences: [{path: 'evidence/answer-two.log', digest: 'a'.repeat(64)}], run: {protocolVersion: 1,
          executionId, framework: 'node-assert', frameworkVersion: '1', phase: 'candidate', results: [{executionId, framework: 'node-assert',
            frameworkVersion: '1', checkId: 'answer-two', phase: 'candidate', status: 'FAIL', failureClass: 'assertion-failed', attempts: 1,
            evidence: ['answer() returned 3']}], completed: true, completionEvidence: ['Collection finished'], diagnostics: []}});
      const attempt = await f.store.put('attempt', {schemaVersion: 1, id: `attempt-pin-${n}`, version, generation: 1, plan, session, startedAt: at,
        finishedAt: at, materials: [], materialDigest: 'c'.repeat(64), executions: [execution], usage, lineage: {authoredCommit: head, importedCommit: head}});
      const finding = {id: 'finding-case-answer', caseId: 'case-answer', criterionIds: ['behavior'], surfaceIds: ['app'], blocking: true, introduced: false,
        reproducible, summary: 'Wrong answer', reproduction: ['Call answer()'], expected: '2', actual: '3', locations: [], executions: [execution]};
      return await f.store.put('report', {schemaVersion: 1, id: `report-pin-${n}`, version, attempt, createdAt: at,
        results: [{caseId: 'case-answer', status: 'FAIL', executions: [execution], observations: ['Wrong answer']}], findings: [finding], questions: []});
    };
    const pinInput = id => ({id, description: 'The QA answer finding stays fixed', verifierIds: ['tests'],
      acceptance: {mode: 'behavioral', baselineCommit: head, bindings: [binding]}});
    const accepted = {'current QA contract hash': qaTaskContractHash(record.task), 'earlier revision QA contract hash': qaTaskContractHash(created.task),
      'current legacy full hash': taskContractHash(record.task), 'earlier revision legacy full hash': taskContractHash(created.task)};
    let i = 0;
    for (const [label, hash] of Object.entries(accepted)) {
      const report = await failingReport({taskContractHash: hash});
      const pinned = await loadFindingPin(f.root, record, `qa:${report.digest}:0`, pinInput(`qa-pin-${++i}`));
      assert.equal(pinned.finding?.source, 'qa', `${label}: pins as a QA finding`);
      assert.equal(pinned.finding?.reportDigest, report.digest, `${label}: pins this report`);
      assert.equal(pinned.finding?.candidateCommit, head, `${label}: pins the failing candidate`);
    }
    await assert.rejects(loadFindingPin(f.root, record, `qa:${(await failingReport({taskContractHash: qaTaskContractHash(record.task)}, false)).digest}:0`,
      pinInput('qa-pin-unreproduced')), {code: 'TASK_QA_FINDING_UNREPRODUCED'}, 'An unreproduced finding is never pinned');
    const rejected = {'unrelated contract hash': {taskContractHash: '9'.repeat(64)},
      'another task': {taskId: 'task-qa-rerun-elsewhere', taskContractHash: qaTaskContractHash(record.task)},
      'another goal': {goalHash: '7'.repeat(64), taskContractHash: qaTaskContractHash(record.task)}};
    for (const [label, patch] of Object.entries(rejected))
      await assert.rejects(loadFindingPin(f.root, record, `qa:${(await failingReport(patch)).digest}:0`, pinInput(`qa-pin-${++i}`)),
        {code: 'TASK_FINDING_NOT_FOUND'}, `${label}: not this task's finding`);
  }),

  'qa-rerun-discovery-skips-qa-imports': () => taskFixture(async f => {
    const {runSurfaceGate} = await load('runtime/src/surface/discovery.js', 'runSurfaceGate');
    const {runReviewCommand} = await load('packages/cli/src/commands/review.js', 'runReviewCommand');
    const {parseArgs} = await load('packages/cli/src/args.js', 'parseArgs');
    const {calculateConfigHash} = await load('runtime/src/config/hash.js', 'calculateConfigHash');
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js', 'FileEvidenceStore');
    const root = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const sibling = await f.service.create({title: 'Deliver sibling', goal: 'Answer for the sibling', criteria});
    await f.candidate();
    // Round 1 for the root through the real import, later superseded: its attempt survives only in control history.
    const round1 = {'tests/qa/independent/round1.check.mjs': 'export const checks = {one: () => roundOneTokenGamma};\n'};
    await recordAttempt(f.store, root.task.id, (await realImport(f, root.task.id, round1)).materials, {id: 'attempt-round-1'});
    // Round 2 for the root through the real import, current in control.
    const round2 = {'tests/qa/independent/round2.check.mjs': 'export const checks = {two: () => otherOnlyTokenAlpha};\n'};
    await recordAttempt(f.store, root.task.id, (await realImport(f, root.task.id, round2)).materials, {id: 'attempt-round-2'});
    // A sibling task's import in the same range, recorded only in the sibling's own QA attempts.
    const siblingFiles = {'tests/qa/independent/sibling.check.mjs': 'export const checks = {three: () => siblingOnlyTokenBeta};\n'};
    await recordAttempt(f.store, sibling.task.id, (await realImport(f, sibling.task.id, siblingFiles)).materials, {id: 'attempt-sibling'});
    assert.equal(f.git(['status', '--porcelain']), '', 'Every import is committed');
    const changedFiles = f.git(['diff', '--name-only', f.baseline]).split('\n').filter(Boolean);
    const gate = surface => runSurfaceGate({root: f.root, taskId: root.task.id, surface, required: true, base: f.baseline, changedFiles, configHash: 'x'});
    const result = await gate(audit());
    assert.equal(result.status, 'PASS', `Unmodified QA materials seed no derived queries: ${JSON.stringify(result.details ?? [])}`);
    // Review's own surface gate over the same range inherits the skip.
    let executed = 0;
    const reviewed = await runReviewCommand({args: parseArgs(['review', '--task', root.task.id, '--base', f.baseline, '--yes', '--json']), authorized: true,
      tasks: f.service, taskId: root.task.id, root: f.root, gitRunner: f.gitRunner, config: config(), policyConfigHash: calculateConfigHash(config()),
      evidenceStore: new FileEvidenceStore(f.root, f.root), execute: async () => {executed++; return {status: 'NOT_RUN', reason: 'missing-cli'};}});
    assert.notEqual(reviewed.data?.result?.reason, 'surface-unclassified',
      `Review does not stop on QA-material tokens: ${JSON.stringify(reviewed.data?.result?.surface ?? reviewed.errors ?? null)}`);
    assert.equal(reviewed.data?.result?.surface, undefined, 'Review reports no surface stop');
    assert.equal(executed, 0, 'No reviewer ran in this fixture');
    // A recorded axis query is the author's own question and still searches the entire repository.
    unclassified(await gate(audit({axes: {...axes, dependents: {queries: ['otherOnlyTokenAlpha']}}})), 'src/other.mjs', 'Recorded query');
  }, {files: {'src/sibling.mjs': 'export const siblingOnlyTokenBeta = 2;\n', 'src/round1.mjs': 'export const roundOneTokenGamma = 3;\n'}}),

  // Invariant (baseline and candidate): edited, cross-task, non-QA-subject and unrecorded materials are searched; no imports means unchanged discovery.
  'qa-rerun-discovery-searches-edited-and-unverified': async () => {
    const material = 'tests/qa/independent/a.check.mjs', text = 'export const checks = {one: () => otherOnlyTokenAlpha};\n';
    await surfaceFixture(async f => {
      const imported = await realImport(f, 'task-qa-rerun-root', {[material]: text});
      await recordAttempt(f.store, 'task-qa-rerun-root', imported.materials);
      await f.write(material, `${text}// edited after import\n`); f.git(['commit', '-qam', 'edit imported QA material']);
      unclassified(await f.gate(audit()), 'src/other.mjs', '(a) committed edit of an imported material');
    });
    await surfaceFixture(async f => {
      const imported = await realImport(f, 'task-qa-rerun-root', {[material]: text});
      await recordAttempt(f.store, 'task-qa-rerun-root', imported.materials);
      await f.write(material, `${text}// uncommitted edit\n`);
      unclassified(await f.gate(audit()), 'src/other.mjs', '(b) uncommitted edit of an imported material');
    });
    await surfaceFixture(async f => {
      // The subject names task-a; only task-b recorded these bytes, and task-a recorded other bytes for the path.
      await subjectImport(f, 'task-qa-rerun-a', {[material]: text});
      await recordAttempt(f.store, 'task-qa-rerun-b', recorded({[material]: text}));
      await recordAttempt(f.store, 'task-qa-rerun-a', recorded({[material]: 'export const checks = {};\n'}));
      unclassified(await f.gate(audit()), 'src/other.mjs', '(c) cross-task digest mismatch');
    });
    await surfaceFixture(async f => {
      // Not the controller's import subject, even though the bytes match a recorded digest.
      await subjectImport(f, 'task-qa-rerun-root', {[material]: text}, 'test: add a check under the QA directory');
      await recordAttempt(f.store, 'task-qa-rerun-root', recorded({[material]: text}));
      unclassified(await f.gate(audit()), 'src/other.mjs', '(d) non-QA commit subject');
    });
    await surfaceFixture(async f => {
      await subjectImport(f, 'task-qa-rerun-root', {[material]: text});
      unclassified(await f.gate(audit()), 'src/other.mjs', '(e) import commit with no recorded QA attempt');
    });
    await surfaceFixture(async f => {
      await f.write('src/app.mjs', 'import {otherOnlyTokenAlpha} from "./other.mjs";\nexport const answer = () => otherOnlyTokenAlpha + 1;\n');
      f.git(['commit', '-qam', 'use other token']);
      unclassified(await f.gate(audit()), 'src/other.mjs', '(f) plain product diff');
      const excluded = await f.gate(audit({excluded: [{glob: 'src/other.mjs', reason: 'Defines the constant only; the answer is computed in src/app.mjs'}]}));
      assert.equal(excluded.status, 'PASS', `(f) a valid exclusion classifies it: ${JSON.stringify(excluded.details ?? [])}`);
    });
  },

  'qa-rerun-pre-qa-surface-check-blocks-sessions': () => taskFixture(async f => {
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js', 'runQaDelivery');
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {runDeliveryQa} = await load('packages/cli/src/qa-delivery.js', 'runDeliveryQa');
    const {runQaCommand} = await load('packages/cli/src/commands/qa.js', 'runQaCommand');
    const {parseArgs} = await load('packages/cli/src/args.js', 'parseArgs');
    const planless = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const planned = await f.service.create({title: 'Deliver planned', goal: 'Answer with a plan', criteria, surface: audit()});
    // The product change references a token only an unclassified file defines.
    const head = await f.candidate('import {otherOnlyTokenAlpha} from "./other.mjs";\nexport const answer = () => otherOnlyTokenAlpha + 1;\n');
    const fp = 'e'.repeat(64), records = await f.records();
    const planVersion = qaDeliveryVersion({tasks: [planned.task], config: config(), candidateCommit: head, sourceFingerprint: fp});
    const plan = await savePlan(f, planVersion, [planned.task.id], {questions: [], id: 'plan-ready'});
    await setControl(f.store, planned.task.id, {state: 'plan-ready', plan});
    await isolatedHome(async () => {
      for (const task of [planless.task, planned.task]) {
        const {spy, options} = delivery(f, records, task.id, fp);
        await assert.rejects(runQaDelivery({...options, surfaceCheck: counting(spy, 'throw')}), {code: 'QA_SURFACE_NOT_READY'},
          `${task.title}: an unready surface stops QA`);
        assert.deepEqual(spy, {planner: 0, author: 0, surface: 1}, `${task.title}: the check ran once and no session started`);
      }
      const {spy, options} = delivery(f, records, planless.task.id, fp);
      await runQaDelivery({...options, surfaceCheck: counting(spy, 'pass')}).catch(() => undefined);
      assert.equal(spy.surface, 1, 'A passing check runs once');
      assert.equal(spy.planner, 1, 'A ready surface lets unsealed QA plan');
      const notReady = error => {
        assert.equal(error.code, 'QA_SURFACE_NOT_READY', `The CLI stops on the surface first, not on ${error.code}`);
        assert.match(error.message, /SURFACE_UNCLASSIFIED/u);
        assert.match(error.message, /src\/other\.mjs/u);
        return true;
      };
      await assert.rejects(runDeliveryQa({root: f.root, taskId: planless.task.id, base: f.baseline}), notReady, 'runDeliveryQa stops');
      const ran = await runQaCommand({args: parseArgs(['qa', 'run', '--task', planless.task.id, '--yes', '--base', f.baseline]), root: f.root,
        deliver: runDeliveryQa, adopt: async () => assert.fail('An enrolled task is never adopted again'), loadConfig: async () => config(),
        fingerprint: async () => fp, inRun: false, now: () => at});
      assert.equal(ran.status, 'error', 'qa run stops');
      notReady({code: ran.code, message: (ran.errors ?? []).map(e => e.message).join('\n')});
    });
  }),

  'qa-rerun-cli-surface-check-tree-and-cap': () => {
    const many = Object.fromEntries(Array.from({length: 22}, (_, i) => [`src/many/m${String(i).padStart(2, '0')}.mjs`,
      `export const manyFilesTokenDelta${i} = 'manyFilesTokenDelta';\n`]));
    return repo(async f => {
      const {qaSurfaceCheck} = await load('packages/cli/src/qa-delivery.js', 'qaSurfaceCheck');
      const qa = {schemaVersion: 1, required: true, policyHash: 'a'.repeat(64), enrolledAt: at, enrollment: 'new', late: false};
      const holder = surface => ({schemaVersion: 2, id: 'task-qa-rerun-cli', title: 'Deliver app', goal: 'Answer correctly', criteria, qa, surface});
      const child = (id, covers) => ({schemaVersion: 2, id, parentTaskId: 'task-qa-rerun-cli', title: 'Child', goal: 'Answer correctly', criteria, surface: {covers}});
      const live = task => ({task, status: 'active', createdSourceCommit: f.baseline});
      await f.write('src/app.mjs', 'import {otherOnlyTokenAlpha} from "./other.mjs";\nexport const answer = () => otherOnlyTokenAlpha + 1;\n');
      f.git(['commit', '-qam', 'use other token']);
      const run = records => qaSurfaceCheck({root: f.root, taskId: 'task-qa-rerun-cli', records, config: config(), base: f.baseline});
      const notReady = (code, check = () => {}) => error => {
        assert.equal(error.code, 'QA_SURFACE_NOT_READY'); assert.match(error.message, new RegExp(code, 'u')); check(error.message); return true;
      };
      // (a) Root holder plus live covers child with an unclassified hit.
      await assert.rejects(run([live(holder(audit())), live(child('task-qa-rerun-cli-a', ['app']))]),
        notReady('SURFACE_UNCLASSIFIED', message => assert.match(message, /src\/other\.mjs/u)), '(a) unclassified hit');
      // (b) 22 unclassified files: 20 listed paths and a summary of the rest.
      const classified = audit({excluded: [{glob: 'src/other.mjs', reason: 'Defines the constant only; the answer is computed in src/app.mjs'}]});
      await assert.rejects(run([live(holder({...classified, axes: {...axes, dependents: {queries: ['manyFilesTokenDelta']}}}))]),
        notReady('SURFACE_UNCLASSIFIED', message => {
          const listed = message.split('\n').filter(line => /src\/many\/m\d\d\.mjs/u.test(line));
          assert.equal(listed.length, 20, `Exactly 20 paths are listed (saw ${listed.length})`);
          assert.match(message, /\.\.\. 2 more/u, 'The rest are summarized as "... 2 more"');
        }), '(b) path cap');
      // (c) Classified and covered by a live child; archived and superseded children with bogus covers are ignored.
      await run([live(holder(classified)), live(child('task-qa-rerun-cli-a', ['app'])),
        {...live(child('task-qa-rerun-cli-b', ['ghost'])), status: 'archived'},
        {...live(child('task-qa-rerun-cli-c', ['phantom'])), supersededBy: 'task-qa-rerun-cli-a'}]);
      // (d) A live covers child leaving an included surface uncovered.
      const two = {...classified, included: [...classified.included, {id: 'cli', path: 'src/cli.mjs', behavior: 'Prints the answer'}]};
      await assert.rejects(run([live(holder(two)), live(child('task-qa-rerun-cli-a', ['app']))]), notReady('SURFACE_UNASSIGNED'), '(d) uncovered surface');
    }, many);
  },

  // Invariant (baseline and candidate): plan-only, sealed-current, check-less and unenrolled callers never run or block on the surface check.
  'qa-rerun-surface-check-skipped-when-exempt': async () => {
    await taskFixture(async f => {
      const {runQaDelivery} = await load('runtime/src/qa/delivery.js', 'runQaDelivery');
      const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
      const early = await f.service.create({title: 'Plan early', goal: 'Answer early', criteria, surface: audit()});
      const sealedTask = await f.service.create({title: 'Deliver sealed', goal: 'Answer correctly', criteria, surface: audit()});
      const omitted = await f.service.create({title: 'Deliver without check', goal: 'Answer plainly', criteria, surface: audit()});
      const head = await f.candidate('import {otherOnlyTokenAlpha} from "./other.mjs";\nexport const answer = () => otherOnlyTokenAlpha + 1;\n');
      const fp = 'e'.repeat(64), records = await f.records();
      // (a) Plan-only QA (after the criteria advisory): nothing to classify yet.
      let {spy, options} = delivery(f, records, early.task.id, fp);
      await runQaDelivery({...options, planOnly: true, timing: 'early', surfaceCheck: counting(spy, 'throw')}).catch(() => undefined);
      assert.equal(spy.surface, 0, '(a) plan-only QA never runs the surface check');
      assert.equal(spy.planner, 1, '(a) plan-only QA still plans');
      // (b) A sealed, current QA is reused without the check and without any session.
      await sealWithQuestion(f, qaDeliveryVersion({tasks: [sealedTask.task], config: config(), candidateCommit: head, sourceFingerprint: fp}), [sealedTask.task]);
      ({spy, options} = delivery(f, records, sealedTask.task.id, fp));
      const reused = await runQaDelivery({...options, surfaceCheck: counting(spy, 'throw')});
      assert.equal(reused.state, 'passed', '(b) sealed-current QA passes');
      assert.equal(reused.sessions, 0, '(b) with no session');
      assert.deepEqual(spy, {planner: 0, author: 0, surface: 0}, '(b) and no surface check');
      // (c) Callers passing no surfaceCheck (native run finalize/land) plan as before.
      ({spy, options} = delivery(f, records, omitted.task.id, fp));
      await runQaDelivery(options).catch(() => undefined);
      assert.equal(spy.planner, 1, '(c) omitting surfaceCheck leaves unsealed QA planning unchanged');
    });
    const {qa: _qa, ...off} = config();
    await taskFixture(async f => {
      const {runDeliveryQa} = await load('packages/cli/src/qa-delivery.js', 'runDeliveryQa');
      const bare = await f.service.create({title: 'Unenrolled', goal: 'Answer without QA', criteria, surface: audit()});
      assert.equal(bare.task.qa, undefined, 'The task in a QA-disabled repo is not enrolled');
      await f.candidate('import {otherOnlyTokenAlpha} from "./other.mjs";\nexport const answer = () => otherOnlyTokenAlpha;\n');
      assert.equal(await isolatedHome(() => runDeliveryQa({root: f.root, taskId: bare.task.id, base: f.baseline})), null,
        'runDeliveryQa returns null for an unenrolled task without checking the surface');
    }, {configured: off});
  },

  'qa-rerun-zero-spend-delivery-outcomes': () => taskFixture(async f => {
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js', 'runQaDelivery');
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {currentQaAttestation} = await load('runtime/src/qa/proof.js', 'currentQaAttestation');
    const cfg = f.configured;
    const make = title => f.service.create({title, goal: `${title} correctly`, criteria, surface: audit()});
    const sealedTask = (await make('Sealed')).task, noPlan = (await make('No plan')).task, missing = (await make('Missing material')).task;
    const modified = (await make('Modified material')).task, moved = (await make('Moved head')).task, notReady = (await make('Not ready')).task;
    await f.candidate();
    const spendNothing = async (task, outcome) => {
      const {spy, options} = await trustedDelivery(f, await f.records(), task.id);
      const result = await runQaDelivery({...options, spend: false, surfaceCheck: counting(spy, outcome)}).catch(error => ({error}));
      return {spy, result};
    };
    // (a) Sealed-current: reuse, no surface check.
    await sealWithQuestion(f, qaDeliveryVersion({tasks: [sealedTask], config: cfg, candidateCommit: f.git(['rev-parse', 'HEAD']),
      sourceFingerprint: await fingerprint(f)}), [sealedTask]);
    let {spy, result} = await spendNothing(sealedTask, 'throw');
    assert.equal(result.error, undefined, `(a) ${result.error?.code}`);
    assert.deepEqual({state: result.state, sessions: result.sessions}, {state: 'passed', sessions: 0}, '(a) sealed-current reuses PASS');
    assert.deepEqual(spy, {planner: 0, author: 0, surface: 0}, '(a) and skips the surface check');
    // (b) No plan: the surface check runs, no session starts, and QA says a paid session is required.
    ({spy, result} = await spendNothing(noPlan, 'pass'));
    assert.equal(result.error, undefined, `(b) ${result.error?.code}`);
    assert.deepEqual(spy, {planner: 0, author: 0, surface: 1}, '(b) no planner or author session');
    assert.deepEqual({state: result.state, blockers: result.blockers, sessions: result.sessions},
      {state: 'blocked', blockers: ['qa:session-required'], sessions: 0}, '(b) blocked on qa:session-required');
    // (e) An unready surface stops before re-execution or session checks.
    ({spy, result} = await spendNothing(notReady, 'throw'));
    assert.equal(result.error?.code, 'QA_SURFACE_NOT_READY', '(e) the unready surface throws');
    assert.deepEqual(spy, {planner: 0, author: 0, surface: 1}, '(e) nothing else ran');
    // (c) A current plan whose committed materials are missing.
    const missingVersion = qaDeliveryVersion({tasks: [missing], config: cfg, candidateCommit: f.git(['rev-parse', 'HEAD']), sourceFingerprint: await fingerprint(f)});
    const missingPlan = await savePlan(f, missingVersion, [missing.id], {cases: [answerCase(materialFor('missing'))], questions: [], id: 'plan-missing'});
    await setControl(f.store, missing.id, {state: 'testing', plan: missingPlan});
    const head = f.git(['rev-parse', 'HEAD']);
    await recordAttempt(f.store, missing.id, recorded({[materialFor('missing')]: ANSWER_TEST}), {plan: missingPlan, version: missingVersion,
      lineage: {authoredCommit: f.baseline, importedCommit: head}});
    ({spy, result} = await spendNothing(missing, 'pass'));
    assert.equal(result.error, undefined, `(c missing) ${result.error?.code}`);
    assert.deepEqual(spy, {planner: 0, author: 0, surface: 1}, '(c missing) no session');
    assert.deepEqual({state: result.state, blockers: result.blockers, sessions: result.sessions},
      {state: 'blocked', blockers: ['qa:session-required'], sessions: 0}, '(c missing) blocked on qa:session-required');
    // (c) A current plan whose committed material was altered after import.
    await plannedWithMaterial(f, modified, cfg, materialFor('modified'));
    await f.write(materialFor('modified'), `${ANSWER_TEST}// altered after import\n`); f.git(['commit', '-qam', 'alter QA material']);
    ({spy, result} = await spendNothing(modified, 'pass'));
    assert.equal(result.error, undefined, `(c altered) ${result.error?.code}`);
    assert.deepEqual(spy, {planner: 0, author: 0, surface: 1}, '(c altered) no session');
    assert.deepEqual({state: result.state, blockers: result.blockers, sessions: result.sessions},
      {state: 'blocked', blockers: ['qa:session-required'], sessions: 0}, '(c altered) blocked on qa:session-required');
    // (d) Intact committed materials on a moved HEAD re-execute through the trusted runner with no session.
    await plannedWithMaterial(f, moved, cfg, materialFor('moved'));
    await f.write('NOTES.md', 'HEAD moved after QA materials were committed\n'); f.git(['add', 'NOTES.md']); f.git(['commit', '-qm', 'move head']);
    ({spy, result} = await spendNothing(moved, 'pass'));
    assert.equal(result.error, undefined, `(d pass) ${result.error?.code}: ${result.error?.message}`);
    assert.deepEqual(spy, {planner: 0, author: 0, surface: 1}, '(d pass) re-execution starts no session');
    assert.equal(result.sessions, 0, '(d pass) sessions=0');
    assert.equal(result.state, 'passed', `(d pass) passing checks seal: ${result.blockers?.join('; ')}`);
    const sealedNow = await f.store.get(result.attestation);
    assert.equal(sealedNow.version.candidateCommit, f.git(['rev-parse', 'HEAD']), '(d pass) the new seal names the moved HEAD');
    assert.ok(await currentQaAttestation(f.store, qaDeliveryVersion({tasks: [moved], config: cfg, candidateCommit: f.git(['rev-parse', 'HEAD']),
      sourceFingerprint: await fingerprint(f)})), '(d pass) the seal is current');
    // (d) A buggy commit: the trusted runner fails by assertion; QA awaits repair with a pin and no session.
    await f.candidate('export const answer = () => 3;\n');
    ({spy, result} = await spendNothing(moved, 'pass'));
    assert.equal(result.error, undefined, `(d fail) ${result.error?.code}: ${result.error?.message}`);
    assert.deepEqual(spy, {planner: 0, author: 0, surface: 1}, '(d fail) re-execution starts no session');
    assert.equal(result.sessions, 0, '(d fail) sessions=0');
    assert.equal(result.state, 'awaiting-repair', `(d fail) a failing check awaits repair: ${result.blockers?.join('; ')}`);
    assert.ok(result.pins.length > 0 && result.pins.every(pin => /^qa:[a-f0-9]{64}:\d+$/u.test(pin)), `(d fail) qa:<digest>:<index> pins: ${result.pins}`);
  }, {configured: withRunner()}),

  'qa-rerun-review-and-batch-zero-spend-cli': async () => {
    await reviewAndBatchCli();
  },

  'qa-rerun-config-outside-qa-keeps-seal': () => taskFixture(async f => {
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const root = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const head = await f.candidate(), fp = await fingerprint(f);
    const version = cfg => qaDeliveryVersion({tasks: [root.task], config: cfg, candidateCommit: head, sourceFingerprint: fp});
    const sealedVersion = version(config());
    const sealed = await sealWithQuestion(f, sealedVersion, [root.task]);
    const base = config();
    const edits = {
      reviewRoles: {...base, reviewRoles: [{role: 'independent-review', targets: ['agy']}]},
      'verification.commands': {...base, verification: {...base.verification, commands: [...base.verification.commands,
        {id: 'lint', command: process.execPath, args: ['test.mjs'], cwd: '.', required: false, evidence: {kind: 'exit-code'}}]}},
      features: {...base, features: {...base.features, stopVerification: {enabled: true}}},
      worktree: {...base, worktree: {mode: 'auto'}},
      pathMappings: {...base, pathMappings: [{path: 'src', verifierIds: ['tests']}]},
      profiles: {...base, profiles: ['core']}
    };
    const {qaVersionMatches} = await load('runtime/src/qa/policy.js', 'qaVersionMatches');
    const {taskContractHash} = await load('runtime/src/task/contract.js', 'taskContractHash');
    for (const [field, cfg] of Object.entries(edits)) {
      assert.ok(qaVersionMatches(sealedVersion, version(cfg)), `config ${field}: the edit alone keeps the sealed version current`);
      // The developer rebinds the task to the edited config (as review asks), then verifies, reviews and finishes.
      await f.setConfig(cfg);
      const current = (await f.record(root.task.id)).task;
      const rebound = await f.service.revise(root.task.id, {expectedContractHash: taskContractHash(current), reason: 'Rebind to the current configuration'});
      await expectSealCurrent(f, {label: `config ${field}`, rootId: root.task.id, taskIds: [root.task.id], sealedVersion,
        planVersion: (await f.store.get(sealed.plan)).version,
        now: qaDeliveryVersion({tasks: [rebound.task], config: cfg, candidateCommit: head, sourceFingerprint: fp}), attestation: sealed.attestation, sealed, cfg, fp});
    }
  }),

  // Invariant (baseline and candidate): the acceptance runners and the qa field still bind the seal and the plan.
  'qa-rerun-config-runner-or-qa-stales': () => taskFixture(async f => {
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const root = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const head = await f.candidate(), fp = await fingerprint(f);
    const version = cfg => qaDeliveryVersion({tasks: [root.task], config: cfg, candidateCommit: head, sourceFingerprint: fp});
    const base = f.configured;
    const sealedVersion = version(base);
    const sealed = await sealWithQuestion(f, sealedVersion, [root.task]);
    const planVersion = (await f.store.get(sealed.plan)).version;
    const runners = base.verification.acceptanceRunners;
    const withRunners = list => ({...base, verification: {...base.verification, acceptanceRunners: list}});
    const {qa: _qa, ...omitted} = base;
    const edits = {
      'runner added': withRunners([...runners, {...qaRunner, id: 'qa-runner-two'}]),
      'runner args': withRunners([{...runners[0], args: ['{materials}', '--strict']}]),
      'runner command': withRunners([{...runners[0], command: 'node'}]),
      'runner cwd': withRunners([{...runners[0], cwd: 'tests'}]),
      'runner adapter': withRunners([{...runners[0], adapter: 'node'}]),
      'runner removed': withRunners([]),
      'qa disabled': {...base, qa: {enabled: false}},
      'qa omitted': omitted,
      'qa property': {...base, qa: {enabled: true, strict: true}}
    };
    const records = await f.records();
    for (const [field, cfg] of Object.entries(edits)) {
      const now = version(cfg);
      await expectSealStale(f, {label: field, rootId: root.task.id, records, sealedVersion, planVersion, now, cfg, fp});
      await expectRespondStale(f, sealed, now, field);
    }
  }, {configured: withRunner()})
};

// ---------------------------------------------------------------------------------------------------------------- review/batch CLI

/**
 * The built CLI end to end in a trusted disposable repository: an isolated AGENT_OPS_HOME, repository trust granted through the CLI,
 * a configured generic acceptance runner, fresh PASS verification and an offline stub `codex` on PATH (no model, no network).
 */
async function reviewAndBatchCli() {
  const cliConfig = withRunner({reviewRoles: [{role: 'independent-review', targets: ['codex']}]});
  await taskFixture(async f => {
    const {VerificationService} = await load('runtime/src/verify/service.js', 'VerificationService');
    const {NodeVerificationProcessRunner} = await load('runtime/src/verify/spawn.js', 'NodeVerificationProcessRunner');
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js', 'FileEvidenceStore');
    const bin = join(build, 'packages/cli/src/bin.js');
    await isolatedHome(async home => {
      const stubs = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-rerun-stub-')));
      try {
        // Offline stand-in for the review target: answers --version, refuses any session with a sandbox permission error.
        await writeFile(join(stubs, 'codex'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-qa-stub"; exit 0; fi\n' +
          'echo "Error: sandbox setup failed: Operation not permitted (permission denied)" >&2\nexit 1\n');
        await chmod(join(stubs, 'codex'), 0o755);
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_OPS_')));
        Object.assign(env, {AGENT_OPS_HOME: home, PATH: `${stubs}${delimiter}${process.env.PATH}`});
        const cli = args => {
          const run = spawnSync(process.execPath, [bin, ...args], {cwd: f.root, env, encoding: 'utf8', timeout: 240_000});
          let json = null;
          try {json = JSON.parse(run.stdout);} catch { /* not JSON */ }
          return {status: run.status, stdout: run.stdout, stderr: run.stderr, json};
        };
        const trust = cli(['trust', 'grant', '--yes']);
        assert.equal(trust.status, 0, `Repository trust is granted through the CLI: ${trust.stderr}${trust.stdout}`);
        const make = title => f.service.create({title, goal: `${title} correctly`, criteria, surface: audit()});
        const reviewPass = (await make('Review passing')).task, reviewUnplanned = (await make('Review unplanned')).task;
        const reviewBuggy = (await make('Review buggy')).task, batchPass = (await make('Batch passing')).task;
        const batchUnplanned = (await make('Batch unplanned')).task;
        await f.candidate();
        for (const [task, name] of [[reviewPass, 'review-pass'], [reviewBuggy, 'review-buggy'], [batchPass, 'batch-pass']])
          await plannedWithMaterial(f, task, cliConfig, materialFor(name));
        // The developer moves HEAD after QA materials were committed.
        await f.candidate('export const answer = () => 2; // moved\n');
        const verify = async id => {
          const report = await new VerificationService({root: f.root, scope: 'project', config: cliConfig, gitRunner: f.gitRunner,
            processRunner: new NodeVerificationProcessRunner(), taskService: f.service, evidenceStore: new FileEvidenceStore(f.root, f.root),
            trusted: true, base: f.baseline}).verify(id);
          assert.equal(report.status, 'PASS', `Fresh PASS verification for ${id}`);
        };
        const reason = run => run.json?.data?.result?.reason ?? run.json?.data?.tasks?.map(t => t.reason ?? t.status).join(',') ?? run.json?.code;
        const noSessions = (run, label) => assert.doesNotMatch(run.stderr, /QA planning for|QA author for/u, `${label}: no planner or author session started`);
        const sealedFor = async (taskId, head, label) => {
          const control = await f.store.readControl(taskId);
          assert.equal(control?.state, 'passed', `${label}: zero-spend QA sealed a PASS`);
          assert.equal((await f.store.get(control.attestation)).version.candidateCommit, head, `${label}: the seal names HEAD`);
          assert.equal((await f.store.get(control.attempt)).session.sessionId, session.sessionId, `${label}: the earlier author's session is reused, not a new one`);
        };
        const sessionRequired = (run, taskId, label) => {
          assert.match(run.stderr, /qa:session-required/u, `${label}: stderr names qa:session-required`);
          assert.ok(run.stderr.includes(`agent-ops qa run --task ${taskId} --yes`), `${label}: stderr names the paid QA command`);
        };
        let head = f.git(['rev-parse', 'HEAD']);
        for (const task of [reviewPass, reviewUnplanned, batchPass, batchUnplanned]) await verify(task.id);
        // review (a): intact committed passing materials on a moved HEAD.
        let run = cli(['review', '--task', reviewPass.id, '--base', f.baseline, '--yes', '--json']);
        noSessions(run, 'review (a)');
        await sealedFor(reviewPass.id, head, `review (a) [${run.stderr.slice(0, 600)}]`);
        // `review` requires --yes at the CLI, so the offline stub target is what stops it once the QA gate is passed.
        assert.notEqual(reason(run), 'qa-required', 'review (a) passes the QA gate');
        assert.equal(reason(run), 'capability-unavailable', `review (a) reaches the review target: ${run.stdout.slice(0, 600)} ${run.stderr.slice(0, 600)}`);
        // review (b): an unplanned enrolled task.
        run = cli(['review', '--task', reviewUnplanned.id, '--base', f.baseline, '--yes', '--json']);
        noSessions(run, 'review (b)');
        sessionRequired(run, reviewUnplanned.id, 'review (b)');
        assert.equal(reason(run), 'qa-required', `review (b) stops on QA: ${run.stdout.slice(0, 600)}`);
        assert.equal((await f.store.readControl(reviewUnplanned.id))?.plan ?? null, null, 'review (b) planned nothing');
        // batch (a): an enrolled parent with intact committed passing materials on a moved HEAD.
        run = cli(['batch', '--parent', batchPass.id, '--yes', '--base', f.baseline, '--parent-base', f.baseline, '--json']);
        noSessions(run, 'batch (a)');
        await sealedFor(batchPass.id, head, 'batch (a)');
        assert.doesNotMatch(run.stdout, /qa-required/u, `batch (a) passes the QA gate: ${run.stdout.slice(0, 800)}`);
        assert.match(run.stdout, /capability-unavailable/u, `batch (a) reaches the review target: ${run.stdout.slice(0, 800)} ${run.stderr.slice(0, 800)}`);
        // batch (b): an unplanned enrolled parent.
        run = cli(['batch', '--parent', batchUnplanned.id, '--yes', '--base', f.baseline, '--parent-base', f.baseline, '--json']);
        noSessions(run, 'batch (b)');
        sessionRequired(run, batchUnplanned.id, 'batch (b)');
        assert.match(run.stdout, /qa-required/u, `batch (b) stops on QA: ${run.stdout.slice(0, 800)}`);
        // review (c): a buggy moved candidate with intact committed failing materials.
        await f.candidate('export const answer = () => 3;\n');
        head = f.git(['rev-parse', 'HEAD']);
        await verify(reviewBuggy.id);
        run = cli(['review', '--task', reviewBuggy.id, '--base', f.baseline, '--yes', '--json']);
        noSessions(run, 'review (c)');
        const control = await f.store.readControl(reviewBuggy.id);
        assert.equal(control?.state, 'awaiting-repair', 'review (c) records awaiting-repair');
        assert.equal(control.attestation, null, 'review (c) seals no PASS');
        assert.ok((await f.store.get(control.report)).findings.some(finding => finding.blocking), 'review (c) records a blocking finding');
        assert.match(run.stderr, /awaiting-repair/u, 'review (c) prints the QA state');
        assert.ok(run.stderr.includes(`agent-ops qa run --task ${reviewBuggy.id} --yes`), 'review (c) prints guidance');
        assert.equal(reason(run), 'qa-required', `review (c) stops on QA: ${run.stdout.slice(0, 600)}`);
      } finally {await rm(stubs, {recursive: true, force: true});}
    });
  }, {configured: cliConfig});
}
