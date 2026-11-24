// Independent QA acceptance for task-3c37ef5b-118e-4c13-b8bc-8fd0beefa664: a surface-only task revise must not void a sealed QA,
// discovery must skip unmodified QA-imported materials, and unsealed QA must stop on an unready surface before any paid session.
// Run by tests/qa/acceptance.mjs from a built checkout (dist/, or AGENT_OPS_DEBUG_TEST_BUILD). Every fixture is a disposable temp repo.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
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
const config = (extra = {}) => ({schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: [
  {id: 'tests', command: 'node', args: ['test.mjs'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}]},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [], qa: {enabled: true}, ...extra});
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
  dismissed: [{query: 'qaAcceptanceIncidental', reason: 'Appears only in fixture comments that never execute'}],
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

async function repo(check, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-qa-reclass-'));
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const gitRunner = {run: async args => {
    try {return {exitCode: 0, stdout: Buffer.from(execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']}))};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: Buffer.from(e.stdout ?? '')};}
  }};
  const write = async (path, text) => {await mkdir(dirname(join(root, path)), {recursive: true}); await writeFile(join(root, path), text);};
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    await write('.gitignore', '.agent-ops/\n');
    await write('src/app.mjs', 'export const answer = () => 1;\n');
    await write('src/other.mjs', 'export const otherOnlyTokenAlpha = 1;\n');
    for (const [path, text] of Object.entries(files)) await write(path, text);
    git(['add', '.']); git(['commit', '-qm', 'baseline']);
    await check({root, git, gitRunner, write, baseline: git(['rev-parse', 'HEAD'])});
  } finally {await rm(root, {recursive: true, force: true});}
}

/** A task store and service in the repo; tasks created here record the baseline as their creation commit. */
async function taskFixture(check, {configured = config()} = {}) {
  await repo(async f => {
    const {TaskService} = await load('runtime/src/task/service.js', 'TaskService');
    const {FileTaskStore} = await load('runtime/src/task/store.js', 'FileTaskStore');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const tasks = new FileTaskStore(join(f.root, '.agent-ops/tasks/state.json'), f.root);
    let id = 0;
    const service = new TaskService(tasks, {generateId: () => `task-qa-acc-${++id}`, now: () => at, platform: 'darwin',
      completion: {root: f.root, gitRunner: f.gitRunner, loadConfig: async () => structuredClone(configured)}});
    const records = async () => (await tasks.read()).tasks;
    /** Commits a product change: the candidate QA is sealed for. */
    const candidate = async (text = 'export const answer = () => 2;\n') => {
      await f.write('src/app.mjs', text); f.git(['commit', '-qam', 'candidate']);
      return f.git(['rev-parse', 'HEAD']);
    };
    await check({...f, service, tasks, records, candidate, store: new FileQaStore(join(f.root, '.git'))});
  });
}

/** The source fingerprint the status reader recomputes for the task's creation base. */
async function fingerprint(f, base) {
  const {resolveReviewScope} = await load('runtime/src/review/scope.js', 'resolveReviewScope');
  const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js', 'calculateSourceFingerprint');
  return await calculateSourceFingerprint(f.root, await resolveReviewScope({root: f.root, runner: f.gitRunner, base}), f.gitRunner);
}

async function setControl(store, taskId, patch) {
  const c = await store.readControl(taskId);
  return await store.updateControl(taskId, c?.revision ?? 0, () => ({schemaVersion: 1, taskId, revision: (c?.revision ?? 0) + 1,
    generation: (c?.generation ?? 0) + 1, state: 'testing', continuation: true, owner: null, plan: null, attempt: null, report: null,
    attestation: null, progress: null, updatedAt: at, ...patch}));
}

/** A tested candidate: plan, attempt and report bound to `version`, waiting in state testing for the controller to seal. */
async function prepareTesting(f, version, taskIds) {
  const head = f.git(['rev-parse', 'HEAD']);
  const plan = await f.store.put('plan', {schemaVersion: 1, id: 'plan-acc', version, originalGoal: 'Answer correctly', taskIds, dependencyTaskIds: [],
    scope: 'full', session: {...session, sessionId: 'qa-planner', writable: false}, createdAt: at, timing: 'late', advisoryReferences: [],
    cases: [{id: 'case-docs', criterionIds: ['behavior'], surfaceIds: [], required: true, mode: 'nonmechanical', preconditions: [],
      actions: ['Read the guide'], expected: 'The guide is accurate', bindings: [], nonmechanicalReason: 'Prose accuracy needs human judgment'}],
    scenarios, environment: [], questions: []});
  const attempt = await f.store.put('attempt', {schemaVersion: 1, id: 'attempt-acc', version, generation: 1, plan, session, startedAt: at,
    finishedAt: at, materials: [], materialDigest: 'c'.repeat(64), executions: [], usage, lineage: {authoredCommit: head, importedCommit: head}});
  const report = await f.store.put('report', {schemaVersion: 1, id: 'report-acc', version, attempt, createdAt: at,
    results: [{caseId: 'case-docs', status: 'PASS', executions: [], observations: ['Read and judged accurate']}], findings: [], questions: []});
  await setControl(f.store, version.taskId, {state: 'testing', plan, attempt, report});
  return {plan, attempt, report};
}

/** The real controller seal over a prepared testing state. */
async function seal(f, version, tasks) {
  const {sealQaAttestation} = await load('runtime/src/qa/proof.js', 'sealQaAttestation');
  const prepared = await prepareTesting(f, version, tasks.map(t => t.id));
  const sealed = await sealQaAttestation({store: f.store, version, tasks, gitRunner: f.gitRunner, now: () => at});
  assert.equal(sealed.reused, false, 'The fixture seals a fresh attestation');
  return {...prepared, attestation: sealed.attestation};
}

/** runQaDelivery options whose planner and author are spies: any session start is counted and no model ever runs. */
function delivery(f, records, rootTaskId, fp, extra = {}) {
  const spy = {planner: 0, author: 0, surface: 0};
  const planningRunner = {start() {
    spy.planner++;
    return {pid: null, stdout: (async function* () {yield Buffer.from('{}');})(), stderr: (async function* () {})(),
      completion: Promise.resolve({exitCode: 1, signal: null}), terminateTree: async () => {}};
  }};
  const options = {store: f.store, root: f.root, rootTaskId, records, config: config(), trusted: false, fingerprint: async () => fp,
    gitRunner: f.gitRunner, processRunner: planningRunner, planningRunner, evidenceStore: null, controllerId: 'qa-controller-acc',
    available: ['claude'], implementationHost: 'codex', implementationSessionId: 'developer', advisory: null,
    host: () => {spy.author++; throw new Error('No author session may start in this fixture');}, platform: 'darwin', now: () => at,
    checkouts: f.root + '-checkouts', ...extra};
  return {spy, options};
}
const counting = (spy, outcome) => async () => {spy.surface++; if (outcome === 'throw') throw unready();};

/** With an isolated AGENT_OPS_HOME so no user config (or real review host) can leak into a CLI-boundary call. */
async function isolatedHome(f, run) {
  const previous = process.env.AGENT_OPS_HOME, home = await mkdtemp(join(tmpdir(), 'agent-ops-qa-reclass-home-'));
  process.env.AGENT_OPS_HOME = home;
  try {return await run();}
  finally {
    if (previous === undefined) delete process.env.AGENT_OPS_HOME; else process.env.AGENT_OPS_HOME = previous;
    await rm(home, {recursive: true, force: true}); await rm(f.root + '-checkouts', {recursive: true, force: true});
  }
}

/** Commits materials the way the controller imports them; the caller records (or withholds) their digests. */
async function importCommit(f, taskId, files) {
  for (const [path, text] of Object.entries(files)) await f.write(path, text);
  f.git(['add', ...Object.keys(files)]);
  f.git(['commit', '-qm', `test(qa): import independent QA materials for ${taskId}\n\nQA-Material-Digest: ${'f'.repeat(64)}`]);
  return f.git(['rev-parse', 'HEAD']);
}
/** Saves an attempt naming `files` (path -> recorded bytes) for taskId and makes it that task's current control attempt. */
async function recordAttempt(store, taskId, commit, files, id) {
  const version = {taskId, goalHash: 'a'.repeat(64), taskContractHash: 'b'.repeat(64), treeContractHash: 'b'.repeat(64), scopeHash: 'c'.repeat(64),
    policyHash: 'a'.repeat(64), configHash: 'd'.repeat(64), candidateCommit: commit, sourceFingerprint: 'e'.repeat(64)};
  const attempt = await store.put('attempt', {schemaVersion: 1, id, version, generation: 1, plan: {kind: 'plan', digest: 'd'.repeat(64)},
    session, startedAt: at, finishedAt: at, materials: Object.entries(files).map(([path, text]) => ({path, role: 'test', digest: sha(text)})),
    materialDigest: 'f'.repeat(64), executions: [], usage});
  await setControl(store, taskId, {attempt});
  return attempt;
}
async function surfaceFixture(check, files) {
  await repo(async f => {
    const {runSurfaceGate} = await load('runtime/src/surface/discovery.js', 'runSurfaceGate');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const gate = (surface, taskId = 'task-qa-root') => runSurfaceGate({root: f.root, taskId, surface, required: true, base: f.baseline,
      changedFiles: f.git(['diff', '--name-only', f.baseline]).split('\n').filter(Boolean), configHash: 'x'});
    await check({...f, gate, store: new FileQaStore(join(f.root, '.git'))});
  }, files);
}
const unclassified = (result, path, label) => {
  assert.equal(result.status, 'NOT_RUN', `${label}: review would stop`);
  assert.equal(result.code, 'SURFACE_UNCLASSIFIED', `${label}: the stop names an unclassified surface`);
  assert.ok(JSON.stringify(result.details).includes(path), `${label}: the stop names ${path}`);
};

export const checks = {
  'qa-accept-seal-and-reuse-after-surface-revise': () => taskFixture(async f => {
    const {qaDeliveryVersion, checkQaDeliveryEvidence} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion', 'checkQaDeliveryEvidence');
    const {qaVersionMatches} = await load('runtime/src/qa/policy.js', 'qaVersionMatches');
    const {currentQaAttestation, qaContractsMatch} = await load('runtime/src/qa/proof.js', 'currentQaAttestation', 'qaContractsMatch');
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js', 'runQaDelivery');
    const {qaStatus} = await load('runtime/src/qa/status.js', 'qaStatus');
    const {showQa} = await load('runtime/src/qa/decisions.js', 'showQa');
    const {taskContractHash} = await load('runtime/src/task/contract.js', 'taskContractHash');
    const root = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    assert.ok(root.task.qa, 'The fixture root is an enrolled delivery');
    const head = await f.candidate(), fp = await fingerprint(f, f.baseline);
    const version = task => qaDeliveryVersion({tasks: [task], config: config(), candidateCommit: head, sourceFingerprint: fp});
    const sealedVersion = version(root.task);
    const {plan, attestation} = await seal(f, sealedVersion, [root.task]);
    // The live repair: classify discovery hits after QA sealed.
    const revised = await f.service.revise(root.task.id, {expectedContractHash: taskContractHash(root.task), reason: 'Classify discovery hits',
      surface: reclassified()});
    assert.notEqual(taskContractHash(revised.task), taskContractHash(root.task), 'Review still sees a new full contract');
    assert.notEqual(revised.task.contractRevision ?? 0, root.task.contractRevision ?? 0, 'The revise moved the contract revision');
    assert.deepEqual(revised.task.surface.included.map(r => ({id: r.id, path: r.path})), [{id: 'app', path: 'src/app.mjs'}]);
    const now = version(revised.task);
    assert.ok(qaVersionMatches(sealedVersion, now), 'A surface-only revise keeps the sealed QA version current');
    assert.deepEqual(await currentQaAttestation(f.store, now), attestation, 'The sealed attestation is still current');
    assert.ok(qaContractsMatch((await f.store.get(plan)).version, now), 'The saved plan contracts still match');
    // Re-running delivery QA reuses the seal: no surface check, planner or author.
    const records = await f.records();
    const {spy, options} = delivery(f, records, root.task.id, fp);
    const result = await runQaDelivery({...options, surfaceCheck: counting(spy, 'throw')});
    assert.equal(result.state, 'passed', 'Delivery QA reuses the sealed PASS');
    assert.equal(result.sessions, 0, 'Reuse spends no session');
    assert.deepEqual(spy, {planner: 0, author: 0, surface: 0}, 'Reuse starts nothing and never runs the surface check');
    const stored = records.find(r => r.task.id === root.task.id);
    assert.equal(await checkQaDeliveryEvidence(stored, {root: f.root, config: config(), sourceFingerprint: fp, records, platform: 'darwin'}), null,
      'The delivery gate accepts the seal after the surface-only revise');
    const status = await qaStatus(f.store, records, root.task.id, {root: f.root, loadConfig: async () => config(), base: f.baseline, gitRunner: f.gitRunner});
    assert.equal(status.outcome, 'PASS', 'task status reads PASS, not STALE');
    assert.equal((await showQa(f.store, root.task.id, now)).stale, false, 'qa show reads not stale');
  }),
  'qa-accept-tree-seal-survives-surface-revise': () => taskFixture(async f => {
    const {qaDeliveryVersion, qaDeliveryTree, checkQaDeliveryEvidence} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion', 'qaDeliveryTree', 'checkQaDeliveryEvidence');
    const {qaVersionMatches} = await load('runtime/src/qa/policy.js', 'qaVersionMatches');
    const {currentQaAttestation} = await load('runtime/src/qa/proof.js', 'currentQaAttestation');
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js', 'runQaDelivery');
    const {qaStatus} = await load('runtime/src/qa/status.js', 'qaStatus');
    const {taskContractHash} = await load('runtime/src/task/contract.js', 'taskContractHash');
    const root = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const child = await f.service.create({title: 'Child', goal: 'Answer correctly', criteria, parentTaskId: root.task.id, surface: {covers: ['app']}});
    const head = await f.candidate(), fp = await fingerprint(f, f.baseline);
    const tree = async () => qaDeliveryTree(await f.records(), root.task.id).map(r => r.task);
    const version = tasks => qaDeliveryVersion({tasks, config: config(), candidateCommit: head, sourceFingerprint: fp});
    const sealedTasks = await tree();
    assert.deepEqual(sealedTasks.map(t => t.id), [root.task.id, child.task.id], 'The delivery tree is the root and its covers child');
    const sealedVersion = version(sealedTasks);
    const {attestation} = await seal(f, sealedVersion, sealedTasks);
    await f.service.revise(root.task.id, {expectedContractHash: taskContractHash(root.task), reason: 'Classify discovery hits', surface: reclassified()});
    const now = version(await tree());
    assert.ok(qaVersionMatches(sealedVersion, now), 'The tree QA version survives a root surface-only revise');
    assert.deepEqual(await currentQaAttestation(f.store, now), attestation);
    const records = await f.records();
    const {spy, options} = delivery(f, records, root.task.id, fp);
    const result = await runQaDelivery({...options, surfaceCheck: counting(spy, 'throw')});
    assert.equal(result.state, 'passed');
    assert.equal(result.sessions, 0);
    assert.deepEqual(spy, {planner: 0, author: 0, surface: 0});
    assert.equal(await checkQaDeliveryEvidence(records.find(r => r.task.id === root.task.id),
      {root: f.root, config: config(), sourceFingerprint: fp, records, platform: 'darwin'}), null);
    const current = {root: f.root, loadConfig: async () => config(), base: f.baseline, gitRunner: f.gitRunner};
    assert.equal((await qaStatus(f.store, records, root.task.id, current)).outcome, 'PASS', 'The root reads PASS');
    assert.equal((await qaStatus(f.store, records, child.task.id, current)).outcome, 'PASS', 'The covers child reads its root PASS');
  }),

  'qa-accept-legacy-full-hash-stale-and-proof-reject': () => taskFixture(async f => {
    const {qaDeliveryVersion, checkQaDeliveryEvidence} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion', 'checkQaDeliveryEvidence');
    const {qaVersionMatches} = await load('runtime/src/qa/policy.js', 'qaVersionMatches');
    const {currentQaAttestation, sealQaAttestation} = await load('runtime/src/qa/proof.js', 'currentQaAttestation', 'sealQaAttestation');
    const {qaStatus} = await load('runtime/src/qa/status.js', 'qaStatus');
    const {showQa} = await load('runtime/src/qa/decisions.js', 'showQa');
    const {taskContractHash, treeContractHash} = await load('runtime/src/task/contract.js', 'taskContractHash', 'treeContractHash');
    const surfaced = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const bare = await f.service.create({title: 'Deliver bare', goal: 'Answer without a surface', criteria});
    assert.equal(bare.task.surface, undefined, 'The second fixture task has no surface field');
    const head = await f.candidate(), fp = await fingerprint(f, f.baseline);
    const records = await f.records();
    const current = {root: f.root, loadConfig: async () => config(), base: f.baseline, gitRunner: f.gitRunner};
    for (const task of [surfaced.task, bare.task]) {
      const now = qaDeliveryVersion({tasks: [task], config: config(), candidateCommit: head, sourceFingerprint: fp});
      const legacy = {...now, taskContractHash: taskContractHash(task), treeContractHash: treeContractHash([task])};
      assert.ok(!qaVersionMatches(legacy, now), `${task.title}: a pre-1.4.2 seal bound to full contract hashes is not current`);
      const attestation = await f.store.put('attestation', {schemaVersion: 1, version: legacy, plan: {kind: 'plan', digest: 'd'.repeat(64)},
        report: {kind: 'report', digest: 'e'.repeat(64)}, executions: [], decisions: [], materialDigest: 'c'.repeat(64), caseIds: ['case-docs'],
        session, generation: 1, sealedAt: at});
      await setControl(f.store, task.id, {state: 'passed', attestation});
      assert.equal(await currentQaAttestation(f.store, now), null, `${task.title}: the legacy seal is not reused`);
      assert.equal((await checkQaDeliveryEvidence(records.find(r => r.task.id === task.id),
        {root: f.root, config: config(), sourceFingerprint: fp, records, platform: 'darwin'}))?.code, 'QA_REQUIRED', `${task.title}: delivery requires QA again`);
      assert.equal((await qaStatus(f.store, records, task.id, current)).outcome, 'STALE', `${task.title}: status reads STALE`);
      assert.equal((await showQa(f.store, task.id, now)).stale, true, `${task.title}: qa show reads stale`);
      // A tested state still carrying legacy full hashes cannot be sealed, by the current version or by its own.
      await prepareTesting(f, legacy, [task.id]);
      await assert.rejects(sealQaAttestation({store: f.store, version: now, tasks: [task], gitRunner: f.gitRunner, now: () => at}),
        {code: 'QA_PROOF_STALE'}, `${task.title}: legacy observations are stale for the current version`);
      await assert.rejects(sealQaAttestation({store: f.store, version: legacy, tasks: [task], gitRunner: f.gitRunner, now: () => at}),
        {code: 'QA_PROOF_STALE'}, `${task.title}: the legacy version no longer names the task's QA contract`);
    }
  }),

  // Invariant (baseline and candidate): every tracked QA contract field still voids a seal.
  'qa-accept-tracked-contract-fields-invalidate-seal': () => taskFixture(async f => {
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {qaVersionMatches} = await load('runtime/src/qa/policy.js', 'qaVersionMatches');
    const {currentQaAttestation, sealQaAttestation} = await load('runtime/src/qa/proof.js', 'currentQaAttestation', 'sealQaAttestation');
    const {qaStatus} = await load('runtime/src/qa/status.js', 'qaStatus');
    const root = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const child = await f.service.create({title: 'Child', goal: 'Answer correctly', criteria, parentTaskId: root.task.id, surface: {covers: ['app']}});
    const head = await f.candidate(), fp = await fingerprint(f, f.baseline);
    const records = await f.records();
    const r = records.find(x => x.task.id === root.task.id), c = records.find(x => x.task.id === child.task.id);
    const version = tasks => qaDeliveryVersion({tasks, config: config(), candidateCommit: head, sourceFingerprint: fp});
    const sealedVersion = version([r.task, c.task]);
    await seal(f, sealedVersion, [r.task, c.task]);
    const surface = r.task.surface;
    const mutations = {
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
    const current = {root: f.root, loadConfig: async () => config(), base: f.baseline, gitRunner: f.gitRunner};
    for (const [field, tasks] of Object.entries(mutations)) {
      assert.ok(!qaVersionMatches(sealedVersion, version(tasks)), `${field}: the sealed version is no longer current`);
      assert.equal(await currentQaAttestation(f.store, version(tasks)), null, `${field}: the seal is not reused`);
      const mutated = [{...r, task: tasks[0]}, {...c, task: tasks[1]}];
      assert.equal((await qaStatus(f.store, mutated, r.task.id, current)).outcome, 'STALE', `${field}: status reads STALE`);
    }
    // Seal-time proof validation: the tested state names the original contracts; a changed root or tree cannot be sealed.
    await prepareTesting(f, sealedVersion, [r.task.id, c.task.id]);
    for (const [field, tasks] of Object.entries(mutations))
      await assert.rejects(sealQaAttestation({store: f.store, version: sealedVersion, tasks, gitRunner: f.gitRunner, now: () => at}),
        {code: 'QA_PROOF_STALE'}, `${field}: seal rejects the changed contract`);
  }),

  'qa-accept-pin-finding-qa-and-legacy-hashes': () => taskFixture(async f => {
    const {loadFindingPin} = await load('runtime/src/task/pin-finding.js', 'loadFindingPin');
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {qaTaskContractHash, taskContractHash} = await load('runtime/src/task/contract.js', 'qaTaskContractHash', 'taskContractHash');
    const created = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const head = await f.candidate('export const answer = () => 3;\n');
    const base = qaDeliveryVersion({tasks: [created.task], config: config(), candidateCommit: head, sourceFingerprint: 'e'.repeat(64)});
    const record = await f.service.revise(created.task.id, {expectedContractHash: taskContractHash(created.task), reason: 'Add a criterion',
      criteria: [...criteria, {id: 'extra', description: 'Another behavior', verifierIds: ['tests']}]});
    assert.ok((record.revisions ?? []).some(rev => rev.previousTask !== undefined), 'The revise keeps the earlier task');
    const binding = {runnerId: 'independent-qa', checkIds: ['answer-two'], redCheckIds: ['answer-two'],
      materials: [{path: 'tests/qa/independent/answer.check.mjs', role: 'test'}]};
    let n = 0;
    /** A saved plan, attempt and failing candidate execution behind one reproducible (or not) finding. */
    const failingReport = async (taskContract, reproducible = true) => {
      const version = {...base, taskContractHash: taskContract};
      const plan = await f.store.put('plan', {schemaVersion: 1, id: `plan-pin-${++n}`, version, originalGoal: 'Answer correctly', taskIds: [created.task.id],
        dependencyTaskIds: [], scope: 'full', session: {...session, sessionId: 'qa-planner', writable: false}, createdAt: at, timing: 'late',
        advisoryReferences: [], cases: [{id: 'case-answer', criterionIds: ['behavior'], surfaceIds: ['app'], required: true, mode: 'behavioral',
          preconditions: ['An enrolled delivery'], actions: ['Ask for the answer'], expected: 'The answer is two', bindings: [binding]}],
        scenarios, environment: [], questions: []});
      const executionId = `exec-pin-${n}`;
      const execution = await f.store.put('execution', {schemaVersion: 1, version, caseId: 'case-answer', runnerId: 'independent-qa',
        materialDigest: 'c'.repeat(64), evidenceReferences: [{path: 'evidence/answer-two.log', digest: 'a'.repeat(64)}], run: {protocolVersion: 1, executionId, framework: 'node-assert', frameworkVersion: '1',
          phase: 'candidate', results: [{executionId, framework: 'node-assert', frameworkVersion: '1', checkId: 'answer-two', phase: 'candidate',
            status: 'FAIL', failureClass: 'assertion-failed', attempts: 1, evidence: ['answer() returned 3']}],
          completed: true, completionEvidence: ['Collection finished'], diagnostics: []}});
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
      'legacy full hash (current)': taskContractHash(record.task), 'legacy full hash (earlier revision)': taskContractHash(created.task)};
    let i = 0;
    for (const [label, hash] of Object.entries(accepted)) {
      const report = await failingReport(hash);
      const pinned = await loadFindingPin(f.root, record, `qa:${report.digest}:0`, pinInput(`qa-pin-${++i}`));
      assert.equal(pinned.finding?.source, 'qa', `${label}: pins as a QA finding`);
      assert.equal(pinned.finding?.candidateCommit, head, `${label}: pins the failing candidate`);
      assert.equal(pinned.finding?.reportDigest, report.digest, `${label}: pins this report`);
      assert.deepEqual(pinned.finding?.criterionIds, ['behavior'], `${label}: pins the finding's criteria`);
    }
    // An accepted contract reaches the reproduction rule; an unknown one is not found at all.
    await assert.rejects(loadFindingPin(f.root, record, `qa:${(await failingReport(qaTaskContractHash(record.task), false)).digest}:0`, pinInput('qa-pin-x')),
      {code: 'TASK_QA_FINDING_UNREPRODUCED'});
    await assert.rejects(loadFindingPin(f.root, record, `qa:${(await failingReport('9'.repeat(64))).digest}:0`, pinInput('qa-pin-y')),
      {code: 'TASK_FINDING_NOT_FOUND'});
  }),

  'qa-accept-discovery-skips-multi-commit-and-sibling-qa-materials': () => surfaceFixture(async f => {
    await f.write('src/app.mjs', 'export const answer = () => 2;\n'); f.git(['commit', '-qam', 'fix answer']);
    // Round 1 for the root: later replaced in control, so its attempt survives only in control history.
    const round1 = {'tests/qa/independent/round1.check.mjs': 'export const checks = {one: () => roundOneTokenGamma};\n'};
    await recordAttempt(f.store, 'task-qa-root', await importCommit(f, 'task-qa-root', round1), round1, 'attempt-round-1');
    // Round 2 for the same root, current in control.
    const round2 = {'tests/qa/independent/round2.check.mjs': 'export const checks = {two: () => otherOnlyTokenAlpha};\n'};
    await recordAttempt(f.store, 'task-qa-root', await importCommit(f, 'task-qa-root', round2), round2, 'attempt-round-2');
    assert.equal((await f.store.readControl('task-qa-root')).attempt.digest !== undefined, true);
    // A sibling/child task's import in the same range resolves against that task's own store.
    const sibling = {'tests/qa/independent/sibling.check.mjs': 'export const checks = {three: () => siblingOnlyTokenBeta};\n'};
    await recordAttempt(f.store, 'task-qa-sibling', await importCommit(f, 'task-qa-sibling', sibling), sibling, 'attempt-sibling');
    const result = await f.gate(audit());
    assert.equal(result.status, 'PASS', `Unmodified QA materials seed no derived queries: ${JSON.stringify(result.details ?? [])}`);
    // A recorded axis query is the author's own question and still searches the whole repository.
    unclassified(await f.gate(audit({axes: {...axes, dependents: {queries: ['otherOnlyTokenAlpha']}}})), 'src/other.mjs', 'Recorded query');
  }, {'src/sibling.mjs': 'export const siblingOnlyTokenBeta = 2;\n', 'src/round1.mjs': 'export const roundOneTokenGamma = 3;\n'}),

  // Invariant (baseline and candidate): edited, unrecorded and wrong-task QA imports are searched; no imports means unchanged discovery.
  'qa-accept-discovery-searches-edited-and-unverified-qa-materials': async () => {
    const material = 'tests/qa/independent/a.check.mjs', text = 'export const checks = {one: () => otherOnlyTokenAlpha};\n';
    await surfaceFixture(async f => {
      await recordAttempt(f.store, 'task-qa-root', await importCommit(f, 'task-qa-root', {[material]: text}), {[material]: text}, 'attempt-edited');
      await f.write(material, `${text}// edited after import\n`); f.git(['commit', '-qam', 'edit imported QA material']);
      unclassified(await f.gate(audit()), 'src/other.mjs', 'Committed edit of an imported material');
    });
    await surfaceFixture(async f => {
      await recordAttempt(f.store, 'task-qa-root', await importCommit(f, 'task-qa-root', {[material]: text}), {[material]: text}, 'attempt-dirty');
      await f.write(material, `${text}// uncommitted edit\n`);
      unclassified(await f.gate(audit()), 'src/other.mjs', 'Uncommitted edit of an imported material');
    });
    await surfaceFixture(async f => {
      // The subject names task-qa-root, but only task-qa-other recorded these bytes; task-qa-root recorded other bytes for the path.
      const commit = await importCommit(f, 'task-qa-root', {[material]: text});
      await recordAttempt(f.store, 'task-qa-other', commit, {[material]: text}, 'attempt-other');
      await recordAttempt(f.store, 'task-qa-root', commit, {[material]: 'export const checks = {};\n'}, 'attempt-root-different');
      unclassified(await f.gate(audit()), 'src/other.mjs', 'Spoofed import subject');
    });
  },
  'qa-accept-discovery-unchanged-without-qa-imports': () => surfaceFixture(async f => {
    await f.write('src/app.mjs', 'import {otherOnlyTokenAlpha} from "./other.mjs";\nexport const answer = () => otherOnlyTokenAlpha + 1;\n');
    f.git(['commit', '-qam', 'use other token']);
    unclassified(await f.gate(audit()), 'src/other.mjs', 'A plain product diff');
    const excluded = await f.gate(audit({excluded: [{glob: 'src/other.mjs', reason: 'Defines the constant only; the answer is computed in src/app.mjs'}]}));
    assert.equal(excluded.status, 'PASS', `A valid exclusion classifies it: ${JSON.stringify(excluded.details ?? [])}`);
  }),

  'qa-accept-delivery-runs-surface-check-before-planner-and-author': () => taskFixture(async f => {
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js', 'runQaDelivery');
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {runDeliveryQa} = await load('packages/cli/src/qa-delivery.js', 'runDeliveryQa');
    await mkdir(join(f.root, '.agent-ops'), {recursive: true});
    await writeFile(join(f.root, '.agent-ops/config.json'), JSON.stringify(config()));
    const planless = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const planned = await f.service.create({title: 'Deliver planned', goal: 'Answer with a plan', criteria, surface: audit()});
    // The product change references a token only an unclassified file defines.
    const head = await f.candidate('import {otherOnlyTokenAlpha} from "./other.mjs";\nexport const answer = () => otherOnlyTokenAlpha + 1;\n');
    const fp = 'e'.repeat(64), records = await f.records();
    const planVersion = qaDeliveryVersion({tasks: [planned.task], config: config(), candidateCommit: head, sourceFingerprint: fp});
    const plan = await f.store.put('plan', {schemaVersion: 1, id: 'plan-ready', version: planVersion, originalGoal: 'Answer with a plan',
      taskIds: [planned.task.id], dependencyTaskIds: [], scope: 'full', session: {...session, sessionId: 'qa-planner', writable: false}, createdAt: at,
      timing: 'late', advisoryReferences: [], cases: [{id: 'case-docs', criterionIds: ['behavior'], surfaceIds: [], required: true, mode: 'nonmechanical',
        preconditions: [], actions: ['Read the guide'], expected: 'The guide is accurate', bindings: [], nonmechanicalReason: 'Prose accuracy'}],
      scenarios, environment: [], questions: []});
    await setControl(f.store, planned.task.id, {state: 'plan-ready', plan});
    await isolatedHome(f, async () => {
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
      // The CLI boundary (verify --task, qa run, task advance): no review host configured, so only the surface check can stop it.
      await assert.rejects(runDeliveryQa({root: f.root, taskId: planless.task.id, base: f.baseline}), error => {
        assert.equal(error.code, 'QA_SURFACE_NOT_READY', `The CLI stops on the surface first, not on ${error.code}`);
        assert.match(error.message, /SURFACE_UNCLASSIFIED/u);
        assert.match(error.message, /src\/other\.mjs/u);
        return true;
      });
    });
  }),
  'qa-accept-cli-surface-check-tree-scope-and-path-cap': () => {
    const many = Object.fromEntries(Array.from({length: 22}, (_, i) => [`src/many/m${String(i).padStart(2, '0')}.mjs`,
      `export const manyFilesTokenDelta${i} = 'manyFilesTokenDelta';\n`]));
    return repo(async f => {
      const {qaSurfaceCheck} = await load('packages/cli/src/qa-delivery.js', 'qaSurfaceCheck');
      const qa = {schemaVersion: 1, required: true, policyHash: 'a'.repeat(64), enrolledAt: at, enrollment: 'new', late: false};
      const holder = surface => ({schemaVersion: 2, id: 'task-qa-cli', title: 'Deliver app', goal: 'Answer correctly', criteria, qa, surface});
      const child = (id, covers) => ({schemaVersion: 2, id, parentTaskId: 'task-qa-cli', title: 'Child', goal: 'Answer correctly', criteria, surface: {covers}});
      const live = task => ({task, status: 'active', createdSourceCommit: f.baseline});
      await f.write('src/app.mjs', 'import {otherOnlyTokenAlpha} from "./other.mjs";\nexport const answer = () => otherOnlyTokenAlpha + 1;\n');
      f.git(['commit', '-qam', 'use other token']);
      const run = records => qaSurfaceCheck({root: f.root, taskId: 'task-qa-cli', records, config: config(), base: f.baseline});
      const notReady = (code, check = () => {}) => error => {
        assert.equal(error.code, 'QA_SURFACE_NOT_READY'); assert.match(error.message, new RegExp(code, 'u')); check(error.message); return true;
      };
      // (a) An unclassified hit across the root holder and its live covers child.
      await assert.rejects(run([live(holder(audit())), live(child('task-qa-cli-a', ['app']))]),
        notReady('SURFACE_UNCLASSIFIED', message => assert.match(message, /src\/other\.mjs/u)));
      // (b) 22 unclassified files: at most 20 paths and a summary of the rest.
      const classified = audit({excluded: [{glob: 'src/other.mjs', reason: 'Defines the constant only; the answer is computed in src/app.mjs'}]});
      await assert.rejects(run([live(holder({...classified, axes: {...axes, dependents: {queries: ['manyFilesTokenDelta']}}}))]),
        notReady('SURFACE_UNCLASSIFIED', message => {
          const listed = message.split('\n').filter(line => /^\s+- src\/many\//u.test(line));
          assert.ok(listed.length > 0 && listed.length <= 20, `At most 20 paths are listed (saw ${listed.length})`);
          assert.match(message, /\.\.\. 2 more/u, 'The rest are summarized');
        }));
      // (c) Classified and covered by live children; archived and superseded children are ignored.
      await run([live(holder(classified)), live(child('task-qa-cli-a', ['app'])),
        {...live(child('task-qa-cli-b', ['ghost'])), status: 'archived'}, {...live(child('task-qa-cli-c', ['phantom'])), supersededBy: 'task-qa-cli-a'}]);
      // (d) A live child leaving an included surface uncovered stops before QA.
      const two = {...classified, included: [...classified.included, {id: 'cli', path: 'src/cli.mjs', behavior: 'Prints the answer'}]};
      await assert.rejects(run([live(holder(two)), live(child('task-qa-cli-a', ['app']))]), notReady('SURFACE_UNASSIGNED'));
    }, many);
  },

  // Invariant (baseline and candidate): plan-only, sealed-current, unenrolled and check-less callers never run or block on the surface check.
  'qa-accept-surface-check-skipped-sealed-plan-only-unenrolled-and-omitted': () => taskFixture(async f => {
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js', 'runQaDelivery');
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const early = await f.service.create({title: 'Plan early', goal: 'Answer early', criteria, surface: audit()});
    const sealedTask = await f.service.create({title: 'Deliver sealed', goal: 'Answer correctly', criteria, surface: audit()});
    const omitted = await f.service.create({title: 'Deliver without check', goal: 'Answer plainly', criteria, surface: audit()});
    const head = await f.candidate(), fp = 'e'.repeat(64), records = await f.records();
    // Plan-only QA runs before implementation: nothing to classify yet.
    let {spy, options} = delivery(f, records, early.task.id, fp);
    await runQaDelivery({...options, planOnly: true, timing: 'early', surfaceCheck: counting(spy, 'throw')}).catch(() => undefined);
    assert.equal(spy.surface, 0, 'Plan-only QA never runs the surface check');
    assert.equal(spy.planner, 1, 'Plan-only QA still plans');
    // A sealed, current QA is reused without the check and without any session.
    await seal(f, qaDeliveryVersion({tasks: [sealedTask.task], config: config(), candidateCommit: head, sourceFingerprint: fp}), [sealedTask.task]);
    ({spy, options} = delivery(f, records, sealedTask.task.id, fp));
    const reused = await runQaDelivery({...options, surfaceCheck: counting(spy, 'throw')});
    assert.equal(reused.state, 'passed');
    assert.equal(reused.sessions, 0);
    assert.deepEqual(spy, {planner: 0, author: 0, surface: 0}, 'Sealed-current QA runs nothing');
    // Callers that pass no surface check (native run finalize/land) plan as before.
    ({spy, options} = delivery(f, records, omitted.task.id, fp));
    await runQaDelivery(options).catch(() => undefined);
    assert.equal(spy.planner, 1, 'Omitting surfaceCheck leaves unsealed QA planning unchanged');
  }).then(() => taskFixture(async f => {
    // An unenrolled task never reaches QA at all.
    const {runDeliveryQa} = await load('packages/cli/src/qa-delivery.js', 'runDeliveryQa');
    const bare = await f.service.create({title: 'Unenrolled', goal: 'Answer without QA', criteria, surface: audit()});
    assert.equal(bare.task.qa, undefined, 'The fixture task is not enrolled');
    await f.candidate('import {otherOnlyTokenAlpha} from "./other.mjs";\nexport const answer = () => otherOnlyTokenAlpha;\n');
    assert.equal(await isolatedHome(f, () => runDeliveryQa({root: f.root, taskId: bare.task.id, base: f.baseline})), null,
      'runDeliveryQa returns null for an unenrolled task, even with an unclassified surface');
  }, {configured: (() => {const {qa, ...rest} = config(); return rest;})()}))
};
