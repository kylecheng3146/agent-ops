// Live (watch-hub): verify and QA passed, then review stopped on SURFACE_UNCLASSIFIED. Classifying the surface with
// task revise made the sealed QA STALE and forced paid planner/author sessions again, and most unclassified hits came
// from tokens in the QA-imported tests themselves. These checks pin the three repairs.
// Run by tests/qa/acceptance.mjs from a built checkout (dist/, or AGENT_OPS_DEBUG_TEST_BUILD).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
// A missing export is an assertion failure the controller can see, never a collection-time import error.
async function load(path, ...names) {
  const mod = await import(pathToFileURL(join(build, path)).href).catch(() => ({}));
  for (const name of names) assert.ok(name in mod, `${path} must export ${name}`);
  return mod;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const at = '2026-11-24T00:00:00.000Z';
const qa = {schemaVersion: 1, required: true, policyHash: 'a'.repeat(64), enrolledAt: at, enrollment: 'new', late: false};
const config = () => ({schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: [
  {id: 'tests', command: 'node', args: ['test.mjs'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}]},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [], qa: {enabled: true}});
const scenarios = {initialState: {applies: true, behavior: 'First delivery'}, redo: {na: 'No replay'}, timeBoundary: {na: 'No dates'},
  identitySwitch: {na: 'One store'}, concurrency: {na: 'One writer'}};
const audit = (extra = {}) => ({axes: {dependents: {na: 'Fixture has no importers'}, duplicates: {na: 'Fixture has no copies'},
  otherPaths: {na: 'Fixture has one entry point'}, sharedState: {na: 'Fixture stores nothing'}},
  included: [{id: 'app', path: 'src/app.mjs', behavior: 'Returns the answer'}], excluded: [], unknown: [], contracts: [], valueChanges: [],
  scenarios, ...extra});
const session = {host: 'claude', sessionId: 'qa-author', implementationSessionId: 'developer', implementationHost: 'codex', writable: true, fallbackReason: null};
const usage = {inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null};

async function repo(check) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-qa-surface-rerun-'));
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
    // Product files outside the diff that share a token with QA-authored tests only.
    await write('src/other.mjs', 'export const qaFixtureHelperName = 1;\n');
    await write('src/third.mjs', 'export const siblingFixtureToken = 2;\n');
    git(['add', '.']); git(['commit', '-qm', 'baseline']);
    await check({root, git, gitRunner, write, baseline: git(['rev-parse', 'HEAD'])});
  } finally {await rm(root, {recursive: true, force: true});}
}

/** Commit QA materials the way the controller imports them and record them in that task's QA attempts. */
async function importMaterials(f, store, taskId, files, {history = false} = {}) {
  for (const [path, text] of Object.entries(files)) await f.write(path, text);
  f.git(['add', ...Object.keys(files)]);
  f.git(['commit', '-qm', `test(qa): import independent QA materials for ${taskId}\n\nQA-Material-Digest: ${'f'.repeat(64)}`]);
  const version = {taskId, goalHash: 'a'.repeat(64), taskContractHash: 'b'.repeat(64), treeContractHash: 'b'.repeat(64), scopeHash: 'c'.repeat(64),
    policyHash: qa.policyHash, configHash: 'd'.repeat(64), candidateCommit: f.git(['rev-parse', 'HEAD']), sourceFingerprint: 'e'.repeat(64)};
  const attempt = await store.put('attempt', {schemaVersion: 1, id: `attempt-${taskId}`, version, generation: 1, plan: {kind: 'plan', digest: 'd'.repeat(64)},
    session, startedAt: at, finishedAt: at, materials: Object.entries(files).map(([path, text]) => ({path, role: 'test', digest: hash(text)})),
    materialDigest: 'f'.repeat(64), executions: [], usage});
  const control = {schemaVersion: 1, taskId, revision: 1, generation: 1, state: 'testing', continuation: true, owner: null,
    plan: null, attempt, report: null, attestation: null, progress: null, updatedAt: at};
  await store.updateControl(taskId, 0, () => control);
  // The attempt may survive only in control history: a later control no longer names it.
  if (history) await store.updateControl(taskId, 1, c => ({...c, revision: 2, attempt: null}));
}

async function taskFixture(check) {
  await repo(async f => {
    const {TaskService} = await load('runtime/src/task/service.js', 'TaskService');
    const {FileTaskStore} = await load('runtime/src/task/store.js', 'FileTaskStore');
    const store = new FileTaskStore(join(f.root, '.agent-ops/tasks/state.json'), f.root);
    let id = 0;
    const service = new TaskService(store, {generateId: () => `task-qa-surface-${++id}`, now: () => at, platform: 'darwin',
      completion: {root: f.root, gitRunner: f.gitRunner, loadConfig: async () => config()}});
    await check({...f, service, store});
  });
}
const criteria = [{id: 'behavior', description: 'Observable behavior', verifierIds: ['tests']},
  {id: 'compatibility', description: 'Compatible readers', verifierIds: ['tests']}];

export const checks = {
  'qa-version-ignores-surface-reclassification': () => taskFixture(async f => {
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {qaVersionMatches} = await load('runtime/src/qa/policy.js', 'qaVersionMatches');
    const {taskContractHash} = await load('runtime/src/task/contract.js', 'taskContractHash');
    const root = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const child = await f.service.create({title: 'Child', goal: 'Answer correctly', criteria, parentTaskId: root.task.id, surface: {covers: ['app']}});
    assert.ok(root.task.qa, 'The fixture root is an enrolled delivery');
    const version = tasks => qaDeliveryVersion({tasks, config: config(), candidateCommit: f.baseline, sourceFingerprint: 'e'.repeat(64)});
    const sealed = version([root.task]), sealedTree = version([root.task, child.task]);
    // Classify discovery hits after QA sealed: an exclusion, a scenario, behavior text and the revision counter all move.
    const revised = await f.service.revise(root.task.id, {expectedContractHash: taskContractHash(root.task), reason: 'Classify discovery hits',
      surface: audit({included: [{id: 'app', path: 'src/app.mjs', behavior: 'Returns the answer, reworded'}],
        excluded: [{glob: 'src/other.mjs', reason: 'Shares a test helper name only; nothing reads the answer'}],
        unknown: [{id: 'external', reader: 'A dashboard outside this repository', behavior: 'May display the answer'}],
        contracts: [{id: 'answer', name: 'answer()', change: 'compatible', behavior: 'Same signature'}],
        scenarios: {...scenarios, redo: {applies: true, behavior: 'Re-running gives the same answer'}}})});
    assert.notEqual(taskContractHash(revised.task), taskContractHash(root.task), 'Review still sees a new contract');
    assert.ok(qaVersionMatches(sealed, version([revised.task])), 'A surface-only revise keeps the sealed QA current');
    assert.ok(qaVersionMatches(sealedTree, version([revised.task, child.task])), 'The tree version survives it too');
  }),
  'qa-version-tracks-included-and-criteria': () => taskFixture(async f => {
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {qaVersionMatches} = await load('runtime/src/qa/policy.js', 'qaVersionMatches');
    const {taskContractHash} = await load('runtime/src/task/contract.js', 'taskContractHash');
    const root = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const child = await f.service.create({title: 'Child', goal: 'Answer correctly', criteria, parentTaskId: root.task.id, surface: {covers: ['app']}});
    const version = tasks => qaDeliveryVersion({tasks, config: config(), candidateCommit: f.baseline, sourceFingerprint: 'e'.repeat(64)});
    const sealed = version([root.task]), sealedTree = version([root.task, child.task]);
    const included = await f.service.revise(root.task.id, {expectedContractHash: taskContractHash(root.task), reason: 'New product surface',
      surface: audit({included: [...audit().included, {id: 'cli', path: 'src/other.mjs', behavior: 'Prints the answer'}]})});
    assert.ok(!qaVersionMatches(sealed, version([included.task])), 'A new included surface needs a new QA plan');
    const moved = {...root.task, surface: audit({included: [{id: 'app', path: 'src/third.mjs', behavior: 'Returns the answer'}]})};
    assert.ok(!qaVersionMatches(sealed, version([moved])), 'A moved included path is a new surface');
    const criteriaChanged = {...root.task, criteria: [...criteria, {id: 'extra', description: 'Another behavior', verifierIds: ['tests']}]};
    assert.ok(!qaVersionMatches(sealed, version([criteriaChanged])), 'Criteria still bind QA');
    assert.ok(!qaVersionMatches(sealed, version([{...root.task, intent: 'A different plan'}])), 'Intent still binds QA');
    assert.ok(!qaVersionMatches(sealed, version([{...root.task, goal: 'Answer something else'}])), 'Goal still binds QA');
    assert.ok(!qaVersionMatches(sealedTree, version([root.task, {...child.task, surface: {covers: []}}])), "A child's covers still bind the tree");
  }),
  'qa-legacy-seal-stays-current': () => taskFixture(async f => {
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {qaVersionMatches} = await load('runtime/src/qa/policy.js', 'qaVersionMatches');
    const {qaContractsMatch} = await load('runtime/src/qa/proof.js', 'qaContractsMatch');
    const {calculateConfigHash} = await load('runtime/src/config/hash.js', 'calculateConfigHash');
    const {taskContractHash, treeContractHash} = await load('runtime/src/task/contract.js', 'taskContractHash', 'treeContractHash');
    const root = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const version = tasks => qaDeliveryVersion({tasks, config: config(), candidateCommit: f.baseline, sourceFingerprint: 'e'.repeat(64)});
    const current = version([root.task]);
    // What 1.4.1 sealed for the same inputs: full task/tree contract and config hashes.
    const legacy = {...current, taskContractHash: taskContractHash(root.task), treeContractHash: treeContractHash([root.task]),
      configHash: calculateConfigHash(config())};
    assert.ok(qaVersionMatches(legacy, current), 'An unchanged 1.4.1 seal stays current after upgrading');
    assert.ok(qaContractsMatch(legacy, current), 'An unchanged 1.4.1 plan stays current after upgrading');
    const changed = version([{...root.task, criteria: [...criteria, {id: 'extra', description: 'Another behavior', verifierIds: ['tests']}]}]);
    assert.ok(!qaVersionMatches(legacy, changed), 'A changed task still invalidates a legacy seal');
    assert.ok(!qaContractsMatch(legacy, changed), 'A changed task still invalidates a legacy plan');
    assert.ok(!qaVersionMatches({...legacy, candidateCommit: '0'.repeat(40)}, current), 'A legacy seal for another candidate stays stale');
  }),
  'qa-pin-accepts-qa-contract-hash': () => taskFixture(async f => {
    const {loadFindingPin} = await load('runtime/src/task/pin-finding.js', 'loadFindingPin');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {qaTaskContractHash, taskContractHash} = await load('runtime/src/task/contract.js', 'qaTaskContractHash', 'taskContractHash');
    const created = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const base = qaDeliveryVersion({tasks: [created.task], config: config(), candidateCommit: f.baseline, sourceFingerprint: 'e'.repeat(64)});
    const earlier = {...base, taskContractHash: qaTaskContractHash(created.task)};
    // The report was made before a criteria revise: its QA hash names an earlier revision.
    const record = await f.service.revise(created.task.id, {expectedContractHash: taskContractHash(created.task), reason: 'Add a criterion',
      criteria: [...criteria, {id: 'extra', description: 'Another behavior', verifierIds: ['tests']}]});
    const store = new FileQaStore(join(f.root, '.git'));
    const finding = {id: 'finding-one', caseId: 'case-one', criterionIds: ['behavior'], surfaceIds: ['app'], blocking: true, introduced: false,
      reproducible: false, summary: 'Wrong answer', reproduction: ['Call answer()'], expected: '2', actual: '1', locations: [], executions: []};
    const report = version => store.put('report', {schemaVersion: 1, id: `report-${version.taskContractHash.slice(0, 8)}`, version,
      attempt: {kind: 'attempt', digest: 'a'.repeat(64)}, createdAt: at,
      results: [{caseId: 'case-one', status: 'FAIL', executions: [], observations: ['Wrong answer']}], findings: [finding], questions: []});
    const pin = {id: 'pin', description: 'Pinned finding', verifierIds: ['tests']};
    const current = {...base, taskContractHash: qaTaskContractHash(record.task)};
    const legacy = {...base, taskContractHash: taskContractHash(record.task)};
    // An accepted contract reaches the reproduction rule; an unknown one is not found at all.
    for (const version of [current, earlier, legacy])
      await assert.rejects(loadFindingPin(f.root, record, `qa:${(await report(version)).digest}:0`, pin), {code: 'TASK_QA_FINDING_UNREPRODUCED'});
    await assert.rejects(loadFindingPin(f.root, record, `qa:${(await report({...current, taskContractHash: '9'.repeat(64)})).digest}:0`, pin),
      {code: 'TASK_FINDING_NOT_FOUND'});
  }),

  'surface-skips-qa-imported-materials': () => repo(async f => {
    const {runSurfaceGate} = await load('runtime/src/surface/discovery.js', 'runSurfaceGate');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const store = new FileQaStore(join(f.root, '.git'));
    await f.write('src/app.mjs', 'export const answer = () => 2;\n'); f.git(['commit', '-qam', 'fix answer']);
    await importMaterials(f, store, 'task-qa-root', {'tests/qa/independent/a.check.mjs': 'export const checks = {one: () => qaFixtureHelperName};\n'});
    // A sibling task's import in the same range resolves against that task's own (historical) attempt.
    await importMaterials(f, store, 'task-qa-sibling', {'tests/qa/independent/b.check.mjs': 'export const checks = {two: () => siblingFixtureToken};\n'},
      {history: true});
    const changedFiles = f.git(['diff', '--name-only', f.baseline]).split('\n');
    const gate = surface => runSurfaceGate({root: f.root, taskId: 'task-qa-root', surface, required: true, base: f.baseline, changedFiles, configHash: 'x'});
    const result = await gate(audit());
    assert.equal(result.status, 'PASS', `QA-material tokens must not make product files unclassified: ${JSON.stringify(result.details ?? [])}`);
    // A recorded axis query is the agent's own question and still searches everything.
    const asked = await gate(audit({axes: {...audit().axes, dependents: {queries: ['qaFixtureHelperName']}}}));
    assert.equal(asked.status, 'NOT_RUN');
    assert.equal(asked.code, 'SURFACE_UNCLASSIFIED');
    assert.ok(JSON.stringify(asked.details).includes('src/other.mjs'));
  }),
  'surface-searches-edited-qa-materials': () => repo(async f => {
    const {runSurfaceGate} = await load('runtime/src/surface/discovery.js', 'runSurfaceGate');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const store = new FileQaStore(join(f.root, '.git'));
    await importMaterials(f, store, 'task-qa-root', {'tests/qa/independent/a.check.mjs': 'export const checks = {one: () => 1};\n'});
    // Edited after import: no longer the controller's bytes, so its tokens are searched like any change.
    await f.write('tests/qa/independent/a.check.mjs', 'export const checks = {one: () => qaFixtureHelperName};\n');
    f.git(['commit', '-qam', 'edit imported QA material']);
    const changedFiles = f.git(['diff', '--name-only', f.baseline]).split('\n');
    const result = await runSurfaceGate({root: f.root, taskId: 'task-qa-root', surface: audit(), required: true, base: f.baseline, changedFiles, configHash: 'x'});
    assert.equal(result.status, 'NOT_RUN');
    assert.equal(result.code, 'SURFACE_UNCLASSIFIED');
    assert.ok(JSON.stringify(result.details).includes('src/other.mjs'));
  }),

  'qa-surface-check-before-sessions': () => repo(async f => {
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js', 'runQaDelivery');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js', 'FileEvidenceStore');
    const task = {schemaVersion: 2, id: 'task-qa-delivery', title: 'Deliver app', goal: 'Answer correctly', criteria, qa, surface: audit()};
    const records = [{task, status: 'active', createdSourceCommit: f.baseline}];
    const starts = [];
    const planningRunner = {start(request) {
      starts.push(request);
      return {pid: null, stdout: (async function* () {yield Buffer.from('{}');})(), stderr: (async function* () {})(),
        completion: Promise.resolve({exitCode: 1, signal: null}), terminateTree: async () => {}};
    }};
    const options = surfaceCheck => ({store: new FileQaStore(join(f.root, '.git')), root: f.root, rootTaskId: task.id, records, config: config(),
      trusted: false, fingerprint: async () => 'e'.repeat(64), gitRunner: f.gitRunner, processRunner: planningRunner, planningRunner,
      evidenceStore: new FileEvidenceStore(f.root, f.root), controllerId: 'qa-controller-fixture', available: ['claude'], implementationHost: 'codex',
      implementationSessionId: 'developer', advisory: null, host: () => {throw new Error('No author session may start');}, platform: 'darwin',
      now: () => at, surfaceCheck});
    const unready = Object.assign(new Error('surface not ready'), {code: 'QA_SURFACE_NOT_READY'});
    await assert.rejects(runQaDelivery(options(async () => {throw unready;})), {code: 'QA_SURFACE_NOT_READY'});
    assert.equal(starts.length, 0, 'An unready surface starts no planner session');
    // A classified surface lets unsealed QA proceed to planning as before.
    await runQaDelivery(options(async () => undefined)).catch(() => undefined);
    assert.equal(starts.length, 1, 'A passing surface check lets QA plan');
  }),
  'qa-surface-check-skipped-when-sealed-or-plan-only': () => repo(async f => {
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js', 'runQaDelivery');
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js', 'FileEvidenceStore');
    const {runDeliveryQa} = await load('packages/cli/src/qa-delivery.js', 'runDeliveryQa');
    const task = {schemaVersion: 2, id: 'task-qa-sealed', title: 'Deliver app', goal: 'Answer correctly', criteria, qa, surface: audit()};
    const records = [{task, status: 'active', createdSourceCommit: f.baseline}];
    const store = new FileQaStore(join(f.root, '.git'));
    let checked = 0, starts = 0;
    const planningRunner = {start() {
      starts++;
      return {pid: null, stdout: (async function* () {yield Buffer.from('{}');})(), stderr: (async function* () {})(),
        completion: Promise.resolve({exitCode: 1, signal: null}), terminateTree: async () => {}};
    }};
    const options = extra => ({store, root: f.root, rootTaskId: task.id, records, config: config(), trusted: false,
      fingerprint: async () => 'e'.repeat(64), gitRunner: f.gitRunner, processRunner: planningRunner, planningRunner,
      evidenceStore: new FileEvidenceStore(f.root, f.root), controllerId: 'qa-controller-fixture', available: ['claude'], implementationHost: 'codex',
      implementationSessionId: 'developer', advisory: null, host: () => {throw new Error('No author session may start');}, platform: 'darwin',
      now: () => at, surfaceCheck: async () => {checked++; throw Object.assign(new Error('unready'), {code: 'QA_SURFACE_NOT_READY'});}, ...extra});
    // Plan-only QA runs before implementation: there is no surface to classify yet.
    await runQaDelivery(options({planOnly: true, timing: 'early'})).catch(() => undefined);
    assert.equal(checked, 0, 'Plan-only QA never runs the surface check');
    assert.equal(starts, 1, 'Plan-only QA still plans');
    // A sealed, current QA is reused without the check and without any session.
    const version = qaDeliveryVersion({tasks: [task], config: config(), candidateCommit: f.git(['rev-parse', 'HEAD']), sourceFingerprint: 'e'.repeat(64)});
    const attestation = await store.put('attestation', {schemaVersion: 1, version, plan: {kind: 'plan', digest: 'd'.repeat(64)},
      report: {kind: 'report', digest: 'e'.repeat(64)}, executions: [], decisions: [], materialDigest: 'c'.repeat(64), caseIds: ['case-one'],
      session, generation: 1, sealedAt: at});
    const control = await store.readControl(task.id);
    await store.updateControl(task.id, control?.revision ?? 0, () => ({schemaVersion: 1, taskId: task.id, revision: (control?.revision ?? 0) + 1,
      generation: (control?.generation ?? 0) + 1, state: 'passed', continuation: true, owner: null, plan: null, attempt: null, report: null,
      attestation, progress: null, updatedAt: at}));
    const sealed = await runQaDelivery(options({}));
    assert.equal(sealed.state, 'passed');
    assert.equal(checked, 0, 'A sealed, current QA never runs the surface check');
    assert.equal(starts, 1, 'Reuse starts no session');
    // An unenrolled task never reaches QA at all.
    await mkdir(join(f.root, '.agent-ops/tasks'), {recursive: true});
    await writeFile(join(f.root, '.agent-ops/tasks/state.json'), JSON.stringify({schemaVersion: 1, tasks: [], sessions: []}));
    assert.equal(await runDeliveryQa({root: f.root, taskId: 'task-unenrolled'}), null);
  }),
  'qa-config-change-outside-qa-keeps-version': () => taskFixture(async f => {
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {qaVersionMatches} = await load('runtime/src/qa/policy.js', 'qaVersionMatches');
    const {qaContractsMatch} = await load('runtime/src/qa/proof.js', 'qaContractsMatch');
    const root = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const version = c => qaDeliveryVersion({tasks: [root.task], config: c, candidateCommit: f.baseline, sourceFingerprint: 'e'.repeat(64)});
    const sealed = version(config());
    for (const edited of [{...config(), reviewRoles: [{role: 'independent-review', targets: ['agy']}]},
      {...config(), verification: {...config().verification, commands: [...config().verification.commands,
        {id: 'lint', command: 'node', args: ['lint.mjs'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}]}},
      {...config(), features: {...config().features, office: {enabled: true}}}, {...config(), worktree: {mode: 'auto'}}]) {
      assert.ok(qaVersionMatches(sealed, version(edited)), `Config outside QA keeps the seal: ${JSON.stringify(Object.keys(edited))}`);
      assert.ok(qaContractsMatch(sealed, version(edited)), 'and the plan');
    }
  }),
  'qa-runner-change-stales-version': () => taskFixture(async f => {
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js', 'qaDeliveryVersion');
    const {qaVersionMatches} = await load('runtime/src/qa/policy.js', 'qaVersionMatches');
    const {qaContractsMatch} = await load('runtime/src/qa/proof.js', 'qaContractsMatch');
    const root = await f.service.create({title: 'Deliver app', goal: 'Answer correctly', criteria, surface: audit()});
    const version = c => qaDeliveryVersion({tasks: [root.task], config: c, candidateCommit: f.baseline, sourceFingerprint: 'e'.repeat(64)});
    const sealed = version(config());
    const runner = {id: 'independent-qa', command: 'node', args: ['tests/qa/acceptance.mjs'], cwd: '.', adapter: 'generic'};
    for (const edited of [{...config(), verification: {...config().verification, acceptanceRunners: [runner]}},
      {...config(), qa: {enabled: true, extra: 'policy'}}]) {
      assert.ok(!qaVersionMatches(sealed, version(edited)), 'A changed runner or qa field invalidates the seal');
      assert.ok(!qaContractsMatch(sealed, version(edited)), 'and the plan');
    }
  }),
  'qa-zero-spend-never-starts-sessions': () => repo(async f => {
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js', 'runQaDelivery');
    const {FileQaStore} = await load('runtime/src/qa/store.js', 'FileQaStore');
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js', 'FileEvidenceStore');
    const task = {schemaVersion: 2, id: 'task-qa-zero-spend', title: 'Deliver app', goal: 'Answer correctly', criteria, qa, surface: audit()};
    const records = [{task, status: 'active', createdSourceCommit: f.baseline}];
    let starts = 0, checked = 0;
    const planningRunner = {start() {
      starts++;
      return {pid: null, stdout: (async function* () {yield Buffer.from('{}');})(), stderr: (async function* () {})(),
        completion: Promise.resolve({exitCode: 1, signal: null}), terminateTree: async () => {}};
    }};
    const result = await runQaDelivery({store: new FileQaStore(join(f.root, '.git')), root: f.root, rootTaskId: task.id, records, config: config(),
      trusted: false, fingerprint: async () => 'e'.repeat(64), gitRunner: f.gitRunner, processRunner: planningRunner, planningRunner,
      evidenceStore: new FileEvidenceStore(f.root, f.root), controllerId: 'qa-controller-fixture', available: ['claude'], implementationHost: 'codex',
      implementationSessionId: 'developer', advisory: null, host: () => {throw new Error('No author session may start');}, platform: 'darwin',
      now: () => at, surfaceCheck: async () => {checked++;}, spend: false}).catch(error => ({error}));
    assert.equal(starts, 0, 'Zero-spend QA never starts a planner');
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.sessions, 0);
    assert.equal(result.state, 'blocked');
    assert.deepEqual(result.blockers, ['qa:session-required'], 'It says a paid session is needed instead of starting one');
    assert.equal(checked, 1, 'The surface check still runs: it spends nothing');
  }),
  'qa-delivery-cli-surface-not-ready': () => repo(async f => {
    const {qaSurfaceCheck} = await load('packages/cli/src/qa-delivery.js', 'qaSurfaceCheck');
    const rootTask = {schemaVersion: 2, id: 'task-qa-cli', title: 'Deliver app', goal: 'Answer correctly', criteria, qa, surface: audit()};
    const child = {schemaVersion: 2, id: 'task-qa-cli-child', parentTaskId: rootTask.id, title: 'Child', goal: 'Answer correctly', criteria,
      surface: {covers: ['app']}};
    const records = tasks => tasks.map(task => ({task, status: 'active', createdSourceCommit: f.baseline}));
    // A product change whose own token hits a file nobody classified.
    await f.write('src/app.mjs', 'export const answer = () => qaFixtureHelperName + 1;\n'); f.git(['commit', '-qam', 'use helper']);
    const run = tasks => qaSurfaceCheck({root: f.root, taskId: rootTask.id, records: records(tasks), config: config(), base: f.baseline});
    await assert.rejects(run([rootTask, child]), error => {
      assert.equal(error.code, 'QA_SURFACE_NOT_READY');
      assert.match(error.message, /SURFACE_UNCLASSIFIED/u);
      assert.match(error.message, /src\/other\.mjs/u);
      return true;
    });
    // Classified, with the child covering the root's included surface: QA may start.
    const classified = {...rootTask, surface: audit({excluded: [{glob: 'src/other.mjs', reason: 'Defines the helper value only; the answer is computed in src/app.mjs'}]})};
    await run([classified, child]);
    // A child that leaves an included surface uncovered still stops before QA.
    await assert.rejects(run([classified, {...child, surface: {covers: []}}]), {code: 'QA_SURFACE_NOT_READY'});
  })
};
