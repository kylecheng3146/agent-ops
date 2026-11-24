import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Decision #6: QA materials are never committed. They live in the private QA store, are placed untracked
// only while executing, and the seal binds the implementation HEAD plus the material digest.
const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const load = path => import(pathToFileURL(join(build, path)).href);
const at = '2026-11-25T00:00:00.000Z';
const material = taskId => `tests/qa-independent/${taskId}.test.mjs`;
const runner = {id: 'qa-runner', command: process.execPath, args: ['{materials}'], cwd: '.', adapter: 'generic'};
const config = {schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: [
  {id: 'tests', command: process.execPath, args: ['test.mjs'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}], acceptanceRunners: [runner]},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [], qa: {enabled: true}};
const feature = answer => `export const answer = () => ${answer};\n`;
/** Test-only material speaking the generic acceptance protocol; never a production QA artifact. */
const CASE_TEST = `import {answer} from '../../feature.mjs';
const executionId = process.env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID, phase = process.env.AGENT_OPS_ACCEPTANCE_PHASE;
const ok = answer() === 2;
console.log(JSON.stringify({protocolVersion: 1, executionId, framework: 'qa-fixture', frameworkVersion: '1', phase, results: [{executionId,
  framework: 'qa-fixture', frameworkVersion: '1', checkId: 'answer-two', phase, status: ok ? 'PASS' : 'FAIL', failureClass: ok ? 'none' : 'assertion-failed',
  attempts: 1, evidence: ['answer observed']}], completed: true, completionEvidence: ['qa fixture finished'], diagnostics: []}));
process.exitCode = ok ? 0 : 1;
`;
const scenarios = {initialState: {applies: true, behavior: 'Fresh enrolled delivery'}, redo: {na: 'No replay here'},
  timeBoundary: {na: 'No deadline'}, identitySwitch: {applies: true, behavior: 'QA host differs from the developer'}, concurrency: {na: 'One controller'}};
/** Test-only planner answer; never a production plan. */
const planFor = taskId => ({cases: [{id: 'case-answer-two', criterionIds: ['behavior'], surfaceIds: [], required: true, mode: 'behavioral',
  preconditions: ['An enrolled delivery'], actions: ['Run answer-two'], expected: 'answer is two',
  bindings: [{runnerId: 'qa-runner', checkIds: ['answer-two'], redCheckIds: ['answer-two'], materials: [{path: material(taskId), role: 'test'}]}]},
  {id: 'case-guide', criterionIds: ['compatibility'], surfaceIds: [], required: true, mode: 'nonmechanical', preconditions: [], actions: ['Read the guide'],
    expected: 'The guide is accurate', bindings: [], nonmechanicalReason: 'Prose accuracy needs human judgment'}],
  scenarios, environment: [], questions: []});
const criteria = [{id: 'behavior', description: 'answer returns two', verifierIds: ['tests']},
  {id: 'compatibility', description: 'The guide stays accurate', verifierIds: ['tests']}];

async function fixture(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-material-store-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-material-store-outside-')));
  const git = (args, cwd = root) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const gitRunner = {run: async args => {
    try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']})};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0)};}
  }};
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA material fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(root, 'feature.mjs'), feature(1));
    await writeFile(join(root, 'test.mjs'), 'process.exitCode = 0;\n');
    git(['add', '.']); git(['commit', '-qm', 'baseline']);
    const baseline = git(['rev-parse', 'HEAD']);
    await mkdir(join(root, '.agent-ops'), {recursive: true});
    await writeFile(join(root, '.agent-ops/config.json'), JSON.stringify(config));
    const commit = async (answer, note = '') => {
      await writeFile(join(root, 'feature.mjs'), feature(answer));
      if (note) await writeFile(join(root, 'NOTES.md'), note);
      git(['add', '.']); git(['commit', '-qm', `candidate ${answer} ${note}`]);
      return git(['rev-parse', 'HEAD']);
    };
    const {TaskService} = await load('runtime/src/task/service.js');
    const {FileTaskStore} = await load('runtime/src/task/store.js');
    const {FileQaStore} = await load('runtime/src/qa/store.js');
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js');
    const {NodeVerificationProcessRunner} = await load('runtime/src/verify/spawn.js');
    const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js');
    const {resolveReviewScope} = await load('runtime/src/review/scope.js');
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js');
    const tasks = new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root);
    const service = () => new TaskService(tasks, {generateId: () => 'task-qa-material-store-1', now: () => at, platform: 'darwin',
      completion: {root, base: baseline, gitRunner, loadConfig: async () => structuredClone(config)}});
    const store = new FileQaStore(join(root, '.git'));
    // Observes the delivery checkout each time a QA material executes: what is placed there, and only then.
    const during = [];
    const base = new NodeVerificationProcessRunner();
    const processRunner = {start(request) {
      if (request.args.some(arg => /^tests\/qa-independent\//u.test(arg)))
        during.push(git(['status', '--porcelain=v1', '--untracked-files=all']));
      return base.start(request);
    }};
    const fingerprint = async () => await calculateSourceFingerprint(root, await resolveReviewScope({root, runner: gitRunner, base: baseline}), gitRunner);
    // Test-only planner transport answering like a read-only Claude envelope; never a production plan.
    const planner = {calls: 0, start() {
      this.calls++;
      const body = JSON.stringify({structured_output: planFor('task-qa-material-store-1'), usage: {input_tokens: 5, output_tokens: 3}});
      return {pid: null, stdout: (async function* () {yield Buffer.from(body);})(), stderr: (async function* () {})(),
        completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => {}};
    }};
    // Test-only writable host: scripted session with a fake process identity that writes one new material file.
    const alive = new Set(), authors = [];
    let pid = 7000;
    const probe = {identity: async p => p === process.pid || alive.has(p) ? `identity-${p}` : null, groupAlive: () => false, signalGroup: async p => {alive.delete(p);}};
    const host = kind => ({kind,
      async start(input) {authors.push(input); const p = ++pid; alive.add(p); await input.registerProcess(p);
        return {...input, kind, sessionId: input.sessionId, threadId: null, nativeVersion: null, processId: p, startedAt: at, process: null, goalStatus: 'unknown'};},
      async resume() {throw new Error('unused');},
      async activate() {return {actionId: 'a', accepted: true, nativeStatus: 'active', payload: null};},
      async *observe(handle) {
        const taskId = handle.runId.slice(3), control = await store.readControl(taskId);
        await mkdir(join(handle.cwd, 'tests/qa-independent'), {recursive: true});
        await writeFile(join(handle.cwd, material(taskId)), CASE_TEST);
        await mkdir(join(handle.cwd, '.agent-ops'), {recursive: true});
        await writeFile(join(handle.cwd, '.agent-ops/qa-author-response.json'), JSON.stringify({schemaVersion: 1, generation: handle.generation,
          plan: control.plan.digest, candidateCommit: git(['rev-parse', 'HEAD'], handle.cwd),
          materials: [{path: material(taskId), role: 'test', caseIds: ['case-answer-two']}], requestedEdits: [], observations: [], questions: []}));
        yield {runId: handle.runId, workerId: handle.workerId, generation: handle.generation, contractHash: handle.contractHash, host: kind,
          nativeStatus: 'unknown', payload: {}, proof: false, type: 'completed', at};
      },
      async stop(handle) {alive.delete(handle.processId); return {actionId: 's', accepted: true, nativeStatus: 'paused', payload: null};},
      async update() {throw new Error('unused');}, async interrupt() {throw new Error('unused');}});
    const orchestrate = async (taskId, patch = {}) => await runQaDelivery({store, root, rootTaskId: taskId, records: (await tasks.read()).tasks, config,
      trusted: true, fingerprint, gitRunner, processRunner, planningRunner: planner, evidenceStore: new FileEvidenceStore(root, root),
      controllerId: 'qa-controller', available: ['claude'], implementationHost: 'codex', implementationSessionId: 'developer-session', advisory: null,
      host, probe, checkouts: outside, now: () => at, platform: 'darwin', ...patch});
    const task = (await service().create({title: 'Deliver with independent QA', goal: 'Users get the answer two', criteria,
      sessionId: 'developer-session'})).task;
    assert.ok(task.qa?.required, 'The delivery root is QA-enrolled');
    const version = async () => {
      const {qaDeliveryTree, qaDeliveryVersion} = await load('runtime/src/qa/gate.js');
      return qaDeliveryVersion({tasks: qaDeliveryTree((await tasks.read()).tasks, task.id).map(r => r.task), config,
        candidateCommit: git(['rev-parse', 'HEAD']), sourceFingerprint: await fingerprint()});
    };
    const record = async () => (await tasks.read()).tasks.find(r => r.task.id === task.id);
    await check({root, git, commit, store, task, during, planner, authors, orchestrate, version, fingerprint, record});
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
}
const commits = f => Number(f.git(['rev-list', '--count', 'HEAD']));
const status = f => f.git(['status', '--porcelain=v1', '--untracked-files=all']);

export const materialStoreChecks = {
  'qa-materials-uncommitted': () => fixture(async f => {
    const path = material(f.task.id);
    const developed = await f.commit(2), count = commits(f);
    const passed = await f.orchestrate(f.task.id);
    assert.equal(passed.state, 'passed', passed.blockers.join('; '));
    assert.deepEqual({head: f.git(['rev-parse', 'HEAD']), commits: commits(f), imported: passed.imported, candidate: passed.candidateCommit},
      {head: developed, commits: count, imported: false, candidate: developed}, 'A full QA PASS creates no commit: HEAD stays the implementation');
    assert.equal(status(f), '', 'No tracked or untracked QA material is left in the worktree');
    assert.equal(existsSync(join(f.root, path)), false);
    assert.equal(f.git(['ls-files', '--', 'tests']), '', 'No QA material is tracked');
    // Present untracked in the delivery checkout only while executing (baseline and candidate phases).
    assert.ok(f.during.length >= 2 && f.during.every(s => s === `?? ${path}`), `Placed untracked while executing: ${JSON.stringify(f.during)}`);
    // The bytes live in the private store under the Git common directory, addressed by digest.
    const attempt = await f.store.get({...(await f.store.get({...passed.report, kind: 'report'})).attempt, kind: 'attempt'});
    assert.deepEqual(attempt.materials.map(m => m.path), [path]);
    const digest = attempt.materials[0].digest;
    assert.ok(existsSync(join(f.root, '.git/agent-ops/qa/materials', digest)), 'Material stored under .git/agent-ops/qa/materials/');
    assert.equal(String(await f.store.readMaterial(digest)), CASE_TEST);
    // A new candidate re-executes the stored materials with zero author sessions, then removes them again.
    const authors = f.authors.length, executed = f.during.length;
    await f.commit(2, 'unrelated note');
    const again = await f.orchestrate(f.task.id);
    assert.deepEqual({state: again.state, sessions: again.sessions, authors: f.authors.length}, {state: 'passed', sessions: 0, authors},
      'Stored materials re-execute without a new author session');
    assert.ok(f.during.length > executed, 'The stored materials were executed again');
    assert.equal(status(f), '');
    // A failing execution removes the placed materials too.
    await f.commit(3);
    const broken = await f.orchestrate(f.task.id);
    assert.deepEqual({state: broken.state, sessions: broken.sessions}, {state: 'awaiting-repair', sessions: 0});
    assert.equal(status(f), '', 'A failed execution leaves no material behind');
    // An erroring execution (evidence cannot be saved) removes them as well.
    await f.commit(2);
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js');
    const real = new FileEvidenceStore(f.root, f.root);
    const failing = {load: path => real.load(path), save: async () => {throw new Error('evidence disk full');}};
    await assert.rejects(f.orchestrate(f.task.id, {evidenceStore: failing}), /evidence disk full/u);
    assert.equal(status(f), '', 'An erroring execution leaves no material behind');
    // A material path that is tracked in the delivery checkout is refused and the tracked file stays untouched.
    await mkdir(join(f.root, 'tests/qa-independent'), {recursive: true});
    await writeFile(join(f.root, path), 'developer-owned\n');
    f.git(['add', '.']); f.git(['commit', '-qm', 'developer test at the QA path']);
    await assert.rejects(f.orchestrate(f.task.id), {code: 'QA_MATERIAL_REJECTED'});
    assert.equal(await readFile(join(f.root, path), 'utf8'), 'developer-owned\n');
    assert.equal(status(f), '', 'The tracked file is neither overwritten nor deleted');
    // qa run output never claims materials were committed.
    f.git(['rm', '-q', path]); f.git(['commit', '-qm', 'drop developer test']);
    const {runQaCommand} = await load('packages/cli/src/commands/qa.js');
    const envelope = await runQaCommand({args: {profiles: [], dryRun: false, json: true, yes: true, rerun: false, command: 'qa', action: 'run', taskId: f.task.id},
      root: f.root, deliver: async input => await f.orchestrate(input.taskId, {explicit: input.explicit}), adopt: async () => {throw new Error('unused');},
      loadConfig: async () => structuredClone(config), fingerprint: async () => await f.fingerprint(), inRun: false, now: () => at});
    assert.equal(envelope.data?.result?.state, 'passed', JSON.stringify(envelope.errors ?? []));
    assert.doesNotMatch(envelope.data.text, /committed/u, 'qa run output does not say QA materials were committed');
    assert.equal(status(f), '');
  }),

  'qa-seal-binds-material-digest': () => fixture(async f => {
    const {currentQaAttestation} = await load('runtime/src/qa/proof.js');
    const {checkQaDeliveryEvidence} = await load('runtime/src/qa/gate.js');
    const developed = await f.commit(2);
    const passed = await f.orchestrate(f.task.id);
    assert.equal(passed.state, 'passed', passed.blockers.join('; '));
    const attestation = await f.store.get({...passed.attestation, kind: 'attestation'});
    const report = await f.store.get({...attestation.report, kind: 'report'});
    const attempt = await f.store.get({...report.attempt, kind: 'attempt'});
    assert.deepEqual({candidate: attestation.version.candidateCommit, digest: attestation.materialDigest, lineage: attempt.lineage},
      {candidate: developed, digest: attempt.materialDigest, lineage: {authoredCommit: developed, importedCommit: developed, stored: true}},
      'The seal binds the implementation HEAD plus the material digest');
    const gate = async () => await checkQaDeliveryEvidence(await f.record(), {root: f.root, config, sourceFingerprint: await f.fingerprint(), platform: 'darwin'});
    assert.deepEqual(await currentQaAttestation(f.store, await f.version()), passed.attestation);
    assert.equal(await gate(), null, 'The untampered seal is current');
    // Editing a stored material breaks the binding: the seal is no longer current and its re-execution is refused.
    const digest = attempt.materials[0].digest, stored = join(f.root, '.git/agent-ops/qa/materials', digest);
    await writeFile(stored, Buffer.from(CASE_TEST.replace('=== 2', '!== 0')).toString('base64'));
    assert.equal(await currentQaAttestation(f.store, await f.version()), null, 'An edited stored material invalidates the seal');
    assert.equal((await gate())?.code, 'QA_REQUIRED');
    const executed = f.during.length;
    const zero = await f.orchestrate(f.task.id, {spend: false});
    assert.deepEqual({state: zero.state, blockers: zero.blockers, executed: f.during.length}, {state: 'blocked', blockers: ['qa:session-required'], executed},
      'Edited stored materials are never re-executed');
    const {placeQaMaterials} = await load('runtime/src/qa/materials.js');
    await assert.rejects(placeQaMaterials(f.root, f.store, attempt.materials), {code: 'QA_MATERIAL_CHANGED'});
    assert.equal(status(f), '');
    // A legacy seal whose materials were committed (import lineage) stays current.
    await mkdir(join(f.root, 'tests/qa-independent'), {recursive: true});
    await writeFile(join(f.root, material(f.task.id)), CASE_TEST);
    f.git(['add', '.']); f.git(['commit', '-qm', `test(qa): import independent QA materials for ${f.task.id}`]);
    const legacyVersion = await f.version();
    const legacyAttempt = await f.store.put('attempt', {...attempt, version: legacyVersion,
      lineage: {authoredCommit: developed, importedCommit: legacyVersion.candidateCommit}});
    const legacyReport = await f.store.put('report', {...report, version: legacyVersion, attempt: legacyAttempt});
    const legacySeal = await f.store.put('attestation', {...attestation, version: legacyVersion, report: legacyReport});
    const control = await f.store.readControl(f.task.id);
    await f.store.updateControl(f.task.id, control.revision, c => ({...c, revision: c.revision + 1, state: 'passed', attempt: legacyAttempt,
      report: legacyReport, attestation: legacySeal}));
    assert.deepEqual(await currentQaAttestation(f.store, legacyVersion), legacySeal, 'A legacy seal with committed materials stays current');
    assert.equal(await gate(), null);
  })
};
