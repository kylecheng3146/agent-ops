import assert from 'node:assert/strict';
import {execFileSync, spawn as nodeSpawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
// A missing capability module is an observable assertion failure on the baseline, not an infrastructure error.
const load = path => import(pathToFileURL(join(build, path)).href).catch(error => {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(join(build, path))) assert.fail(`${path} must be built`);
  throw error;
});
// A capability absent from the build is an observable assertion failure, not a module-load error.
async function qa(path, ...names) {
  const mod = await load(path).catch(() => ({}));
  for (const name of names) assert.equal(typeof mod[name], 'function', `${path} must export ${name}`);
  return mod;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const at = '2026-11-13T00:00:00.000Z';
const goal = 'Users can rely on independent QA before delivery';
const MATERIAL = 'tests/qa-independent/answer.test.mjs';
const runner = {id: 'qa-runner', command: process.execPath, args: ['{materials}'], cwd: '.', adapter: 'generic'};
const config = {schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: [
  {id: 'tests', command: 'node', args: ['test.mjs'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}], acceptanceRunners: [runner]},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};
/** Test-only material speaking the generic acceptance protocol; QA_FIXTURE_MODE injects infrastructure faults. */
const CASE_TEST = `import {answer, legacy, name} from '../../feature.mjs';
const executionId = process.env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID, phase = process.env.AGENT_OPS_ACCEPTANCE_PHASE, mode = process.env.QA_FIXTURE_MODE ?? '';
if (mode === 'crash') throw new Error('fixture setup failed before any check ran');
const requested = (process.env.AGENT_OPS_ACCEPTANCE_CHECKS ?? '').split(',').filter(Boolean);
const checks = {'answer-two': mode === 'always' || answer() === 2, 'legacy-zero': legacy() === 0, 'stable-name': name() === 'qa'};
const results = Object.entries(checks).filter(([id]) => requested.length === 0 || requested.includes(id)).map(([checkId, ok]) => ({executionId, framework: 'qa-fixture', frameworkVersion: '1', checkId, phase,
  status: mode === 'skip' ? 'UNKNOWN' : ok ? 'PASS' : 'FAIL', failureClass: mode === 'skip' ? 'skipped' : ok ? 'none' : 'assertion-failed',
  attempts: mode === 'retry' ? 2 : 1, evidence: [checkId + ' observed ' + JSON.stringify([answer(), legacy(), name()])]}));
console.log(JSON.stringify({protocolVersion: 1, executionId, framework: 'qa-fixture', frameworkVersion: '1', phase, results,
  completed: true, completionEvidence: ['qa fixture finished'], diagnostics: []}));
process.exitCode = mode === 'exit-mismatch' || results.some(r => r.status === 'FAIL') ? 1 : 0;
`;
const feature = (answer, name = 'qa') => `export const answer = () => ${answer};\nexport const legacy = () => 1;\nexport const name = () => '${name}';\n`;
const scenarios = {initialState: {applies: true, behavior: 'Fresh enrolled task'}, redo: {na: 'No replay in this fixture'},
  timeBoundary: {na: 'No deadline'}, identitySwitch: {applies: true, behavior: 'QA differs from developer'}, concurrency: {na: 'Single controller'}};
const bind = (checkIds, red = checkIds) => [{runnerId: 'qa-runner', checkIds, ...(red.length > 0 ? {redCheckIds: red} : {}), materials: [{path: MATERIAL, role: 'test'}]}];
const answerCase = {id: 'case-answer', criterionIds: ['behavior'], surfaceIds: [], required: true, mode: 'behavioral', preconditions: ['An enrolled delivery'],
  actions: ['Ask for the answer'], expected: 'The answer is two', bindings: bind(['answer-two'])};
const docsCase = {id: 'case-docs', criterionIds: ['compatibility'], surfaceIds: [], required: true, mode: 'nonmechanical', preconditions: [],
  actions: ['Read the guide'], expected: 'The guide is accurate', bindings: [], nonmechanicalReason: 'Prose accuracy needs human judgment'};
const legacyCase = {id: 'case-legacy', criterionIds: ['compatibility'], surfaceIds: [], required: false, mode: 'invariant', preconditions: [],
  actions: ['Call the legacy entry'], expected: 'Legacy returns zero', bindings: bind(['legacy-zero'], [])};
const nameCase = {id: 'case-name', criterionIds: ['compatibility'], surfaceIds: [], required: false, mode: 'invariant', preconditions: [],
  actions: ['Read the name'], expected: 'The name stays qa', bindings: bind(['stable-name'], [])};
const session = {host: 'claude', sessionId: 'qa-author', implementationSessionId: 'developer-session', implementationHost: 'codex', writable: true, fallbackReason: null};
const unknownUsage = {inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null};

async function fixture(check) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-qa-proof-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-ops-qa-proof-outside-'));
  const git = (args, cwd = root) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  const gitRunner = {run: async args => {
    try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']})};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0)};}
  }};
  const previousMode = process.env.QA_FIXTURE_MODE;
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(root, 'feature.mjs'), feature(1));
    git(['add', '.']); git(['commit', '-qm', 'baseline']);
    const baseline = git(['rev-parse', 'HEAD']).trim();
    const commit = async (answer, name = 'qa', note = '') => {
      await writeFile(join(root, 'feature.mjs'), feature(answer, name));
      if (note) await writeFile(join(root, 'NOTES.md'), note);
      git(['add', '.']); git(['commit', '-qm', `candidate ${answer} ${name} ${note}`]);
      return git(['rev-parse', 'HEAD']).trim();
    };
    const {TaskService} = await load('runtime/src/task/service.js');
    const {FileTaskStore} = await load('runtime/src/task/store.js');
    const {taskContractHash, treeContractHash, goalHash} = await load('runtime/src/task/contract.js');
    const {calculateConfigHash} = await load('runtime/src/config/hash.js');
    const {FileQaStore} = await load('runtime/src/qa/store.js');
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js');
    const {NodeVerificationProcessRunner} = await load('runtime/src/verify/spawn.js');
    const tasks = new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root);
    let nextId = 0;
    const service = new TaskService(tasks, {generateId: () => `task-qa-proof-${++nextId}`, now: () => at, platform: 'darwin',
      completion: {root, gitRunner, loadConfig: async () => structuredClone(config)}});
    const record = await service.create({title: 'Deliver QA proof', goal, criteria: [
      {id: 'behavior', description: 'Observable behavior', verifierIds: ['tests']},
      {id: 'compatibility', description: 'Compatible readers', verifierIds: ['tests']}]});
    const store = new FileQaStore(join(root, '.git'));
    const spawned = {count: 0};
    const base = new NodeVerificationProcessRunner();
    const processRunner = {start(request) {spawned.count++; return base.start(request);}};
    const version = (task = record.task, candidateCommit = git(['rev-parse', 'HEAD']).trim(), patch = {}) => ({taskId: task.id, goalHash: goalHash(task),
      taskContractHash: taskContractHash(task), treeContractHash: treeContractHash([task]), scopeHash: 'c'.repeat(64), policyHash: 'a'.repeat(64),
      configHash: calculateConfigHash(config), candidateCommit, sourceFingerprint: hash(candidateCommit), ...patch});
    /** The real isolated-checkout import path: QA adds one new material file, imported as a new final candidate. */
    const importMaterial = async () => {
      const {cloneQaCheckout} = await load('runtime/src/qa/session.js');
      const {inspectQaMaterials, importQaMaterials} = await load('runtime/src/qa/materials.js');
      const {parseQaAuthorResponse} = await load('runtime/src/qa/validate.js');
      const authored = git(['rev-parse', 'HEAD']).trim(), checkout = join(outside, `author-${authored.slice(0, 8)}`);
      await cloneQaCheckout(root, checkout, authored);
      await mkdir(join(checkout, 'tests/qa-independent'), {recursive: true});
      await writeFile(join(checkout, MATERIAL), CASE_TEST);
      const inspected = await inspectQaMaterials(checkout, authored, parseQaAuthorResponse({schemaVersion: 1, generation: 1, plan: 'f'.repeat(64),
        candidateCommit: authored, materials: [{path: MATERIAL, role: 'test', caseIds: ['case-answer']}], requestedEdits: [], observations: [], questions: []}));
      return await importQaMaterials({checkout, target: root, inspected, taskId: record.task.id});
    };
    /** Saves a plan and hands control to a confirmed-dead author generation in state testing (or another waiting state). */
    const prepare = async ({task = record.task, cases, questions = [], environment = [], state = 'testing', planVersion} = {}) => {
      const {claimQaControl, releaseQaControl} = await load('runtime/src/qa/session.js');
      const plan = await store.put('plan', {schemaVersion: 1, id: 'plan-1', version: planVersion ?? version(task), originalGoal: goal, taskIds: [task.id],
        dependencyTaskIds: [], scope: 'full', session: {...session, sessionId: 'qa-planner', writable: false}, createdAt: at, timing: 'early',
        advisoryReferences: [], cases, scenarios, environment, questions});
      const held = await claimQaControl(store, {taskId: task.id, controllerId: 'controller', session, state: 'testing', explicit: true, now: at});
      const control = await releaseQaControl(store, held, {state, plan}, at);
      return {plan, generation: control.generation};
    };
    const author = (generation, imported, patch = {}) => ({session, generation, startedAt: at, usage: unknownUsage,
      materials: imported.materials, materialDigest: imported.materialDigest, lineage: imported.lineage, observations: [], questions: [], ...patch});
    const execute = async (generation, imported, patch = {}) => {
      const {executeQaAttempt} = await load('runtime/src/qa/proof.js');
      const head = git(['rev-parse', 'HEAD']).trim();
      const evidenceStore = new FileEvidenceStore(root, root);
      return await executeQaAttempt({store, root, version: version(patch.task ?? record.task, head), baselineCommit: baseline, config, trusted: true, gitRunner,
        processRunner, evidenceStore, author: author(generation, imported.lineage.importedCommit === head ? imported
          : {...imported, materials: [], lineage: {authoredCommit: head, importedCommit: head}}, patch.author), now: () => at, ...patch.options});
    };
    const latest = async id => (await tasks.read()).tasks.find(r => r.task.id === id);
    await check({root, outside, git, gitRunner, baseline, commit, record, latest, service, store, version, importMaterial, prepare, execute, author, spawned,
      setMode: mode => {if (mode === undefined) delete process.env.QA_FIXTURE_MODE; else process.env.QA_FIXTURE_MODE = mode;}});
  } finally {
    if (previousMode === undefined) delete process.env.QA_FIXTURE_MODE; else process.env.QA_FIXTURE_MODE = previousMode;
    await rm(root, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
}
const control = async f => await f.store.readControl(f.record.task.id);
/** Test-only native host: scripted events and a fake process identity. Never production QA output. */
function fakeNative(script) {
  const alive = new Set(), calls = [];
  let pid = 4000;
  const probe = {identity: async p => alive.has(p) ? `identity-${p}` : null, groupAlive: () => false, signalGroup: async p => {alive.delete(p);}};
  const host = kind => ({kind,
    async start(input) {calls.push({kind: 'start', input}); return await open(input);},
    async resume(input, nativeSessionId) {calls.push({kind: 'resume', input, nativeSessionId}); return await open(input);},
    async activate(handle) {calls.push({kind: 'activate', generation: handle.generation}); return script.activation?.(calls) ?? {actionId: 'a', accepted: true, nativeStatus: 'active', payload: null};},
    async *observe(handle) {for (const event of await script.events(handle, calls)) yield {runId: handle.runId, workerId: handle.workerId, generation: handle.generation,
      contractHash: handle.contractHash, host: kind, nativeStatus: 'unknown', payload: {}, proof: false, ...event};},
    async stop(handle) {alive.delete(handle.processId); return {actionId: 's', accepted: true, nativeStatus: 'paused', payload: null};},
    async update() {throw new Error('unused');}, async interrupt() {throw new Error('unused');}});
  async function open(input) {
    const p = ++pid; alive.add(p);
    await input.registerProcess(p);
    return {...input, kind: 'claude', sessionId: input.sessionId, threadId: null, nativeVersion: null, processId: p, startedAt: at, process: null, goalStatus: 'unknown'};
  }
  return {probe, host, calls};
}

export const proofChecks = {
  'qa-current-proof': () => fixture(async f => {
    const {sealQaAttestation, currentQaAttestation, qaCaseVerdict} = await qa('runtime/src/qa/proof.js', 'executeQaAttempt', 'sealQaAttestation', 'currentQaAttestation', 'qaCaseVerdict');
    const developed = await f.commit(2);
    const imported = await f.importMaterial();
    const final = f.git(['rev-parse', 'HEAD']).trim();
    assert.deepEqual(imported.lineage, {authoredCommit: developed, importedCommit: final});
    // Proof observed before the import cannot describe the final candidate.
    let ready = await f.prepare({cases: [answerCase, docsCase]});
    const {executeQaAttempt} = await load('runtime/src/qa/proof.js');
    await assert.rejects(executeQaAttempt({store: f.store, root: f.root, version: f.version(f.record.task, developed), baselineCommit: f.baseline, config,
      trusted: true, gitRunner: f.gitRunner, processRunner: {start() {throw new Error('must not run');}}, evidenceStore: null,
      author: f.author(ready.generation, imported), now: () => at}), {code: 'QA_CANDIDATE_MOVED'});
    // Infrastructure output is UNKNOWN, never red or green: crash, skip, retry and exit-code mismatch all block.
    for (const mode of ['crash', 'skip', 'retry', 'exit-mismatch', 'always']) {
      f.setMode(mode);
      ready = await f.prepare({cases: [answerCase, docsCase]});
      const result = await f.execute(ready.generation, imported);
      const report = await f.store.get(result.report);
      assert.equal(report.results.find(r => r.caseId === 'case-answer').status, 'UNKNOWN', `${mode} must stay UNKNOWN`);
      assert.equal(result.state, 'blocked', `${mode}: a necessary unexecuted check blocks delivery`);
      assert.ok(result.blockers.includes('unexecuted:case-answer'));
      // Live: status and qa show said "blocked" without naming the UNKNOWN case that blocks.
      if (mode === 'crash') assert.ok((await (await load('runtime/src/qa/status.js')).qaStatus(f.store,
        [{...f.record, task: {...f.record.task, qa: {late: false}}}], f.record.task.id, null))
        .blockers.includes('unexecuted:case-answer'), 'Status names the UNKNOWN case that blocks delivery');
      await assert.rejects(sealQaAttestation({store: f.store, version: f.version(), tasks: [f.record.task], gitRunner: f.gitRunner}),
        e => ['QA_NOT_READY', 'QA_CONTINUATION_DISABLED'].includes(e.code));
      if (mode !== 'always') for (const ref of report.results.find(r => r.caseId === 'case-answer').executions) {
        const execution = await f.store.get(ref);
        if (execution.run.phase === 'candidate') assert.equal(execution.run.completed, false, `${mode}: replay UNKNOWN is recorded as incomplete, not a result`);
      }
    }
    f.setMode(undefined);
    // Real red -> green: baseline fails by assertion, final committed candidate passes, through configured trusted replay.
    ready = await f.prepare({cases: [answerCase, docsCase]});
    const result = await f.execute(ready.generation, imported);
    assert.equal(result.state, 'testing'); assert.deepEqual(result.blockers, []);
    const report = await f.store.get(result.report);
    const answerResult = report.results.find(r => r.caseId === 'case-answer');
    assert.equal(answerResult.status, 'PASS');
    const executions = await Promise.all(answerResult.executions.map(ref => f.store.get(ref)));
    assert.deepEqual(executions.map(e => e.run.phase).sort(), ['baseline', 'candidate']);
    assert.ok(executions.every(e => e.version.candidateCommit === final), 'Executions bind the exact final candidate');
    const baselineRun = executions.find(e => e.run.phase === 'baseline').run;
    assert.equal(baselineRun.results.find(r => r.checkId === 'answer-two').failureClass, 'assertion-failed');
    assert.equal(qaCaseVerdict(answerCase, executions).status, 'PASS');
    assert.equal(qaCaseVerdict(answerCase, executions.filter(e => e.run.phase === 'candidate')).status, 'UNKNOWN', 'Candidate green alone is not behavioral proof');
    assert.equal(report.results.find(r => r.caseId === 'case-docs').status, 'UNKNOWN');
    const attempt = await f.store.get(report.attempt);
    assert.deepEqual(attempt.lineage, imported.lineage); assert.equal(attempt.materialDigest, imported.materialDigest);
    // Stale contracts, versions or a moved candidate never seal.
    await assert.rejects(sealQaAttestation({store: f.store, version: f.version(f.record.task, final, {sourceFingerprint: 'f'.repeat(64)}),
      tasks: [f.record.task], gitRunner: f.gitRunner}), {code: 'QA_PROOF_STALE'});
    await assert.rejects(sealQaAttestation({store: f.store, version: f.version(f.record.task, final, {configHash: 'f'.repeat(64)}),
      tasks: [f.record.task], gitRunner: f.gitRunner}), {code: 'QA_PROOF_STALE'});
    await writeFile(join(f.root, 'late.txt'), 'moved\n'); f.git(['add', 'late.txt']); f.git(['commit', '-qm', 'moved']);
    await assert.rejects(sealQaAttestation({store: f.store, version: f.version(f.record.task, final), tasks: [f.record.task], gitRunner: f.gitRunner}), {code: 'QA_CANDIDATE_MOVED'});
    f.git(['reset', '-q', '--hard', final]);
    const sealed = await sealQaAttestation({store: f.store, version: f.version(), tasks: [f.record.task], gitRunner: f.gitRunner, now: () => at});
    assert.equal(sealed.reused, false);
    const attestation = await f.store.get(sealed.attestation);
    assert.equal(attestation.version.candidateCommit, final); assert.equal(attestation.materialDigest, imported.materialDigest);
    assert.deepEqual(attestation.caseIds, ['case-answer', 'case-docs']); assert.deepEqual(attestation.nonmechanicalCaseIds, ['case-docs']);
    assert.deepEqual({session: attestation.session.sessionId, generation: attestation.generation}, {session: 'qa-author', generation: ready.generation});
    assert.deepEqual(new Set(attestation.executions.map(e => e.digest)), new Set(answerResult.executions.map(e => e.digest)));
    assert.equal((await control(f)).state, 'passed');
    assert.deepEqual(await currentQaAttestation(f.store, f.version()), sealed.attestation);
    // A criterion the task made mechanical cannot be satisfied by reasoned inspection alone.
    const mechanical = {...f.record.task, id: 'task-qa-downgrade', criteria: [f.record.task.criteria[0], {...f.record.task.criteria[1],
      acceptance: {mode: 'behavioral', baselineCommit: f.baseline, bindings: bind(['answer-two'])}}]};
    ready = await f.prepare({task: mechanical, cases: [answerCase, docsCase]});
    await f.execute(ready.generation, imported, {task: mechanical});
    await assert.rejects(sealQaAttestation({store: f.store, version: f.version(mechanical), tasks: [mechanical], gitRunner: f.gitRunner}), {code: 'QA_MECHANICAL_DOWNGRADE'});
    // Live: two bindings using the same runner but different materials were mistaken for duplicate executions.
    const secondMaterial = 'tests/qa-independent/second.test.mjs';
    await writeFile(join(f.root, secondMaterial), CASE_TEST.replace("'stable-name':", "'stable-name-second':"));
    f.git(['add', secondMaterial]); f.git(['commit', '-qm', 'second material']);
    const multiple = {...nameCase, id: 'case-multiple-bindings', required: true, bindings: [
      ...bind(['stable-name'], []), {...bind(['stable-name-second'], [])[0], materials: [{path: secondMaterial, role: 'test'}]}]};
    ready = await f.prepare({cases: [multiple]});
    const multi = await f.execute(ready.generation, imported);
    assert.equal(multi.state, 'testing', 'Every exact material set has its own single baseline/candidate pair');
    const multiReport = await f.store.get(multi.report);
    assert.equal(multiReport.results[0].status, 'PASS');
    const multiExecutions = await Promise.all(multiReport.results[0].executions.map(ref => f.store.get(ref)));
    assert.equal(multiExecutions.length, 4); assert.equal(new Set(multiExecutions.map(e => e.materialDigest)).size, 2);
    const {canonicalJson} = await load('runtime/src/config/hash.js');
    const identities = new Map(multiple.bindings.map(b => [canonicalJson(b.materials),
      multiExecutions.find(e => e.run.results.some(r => r.checkId === b.checkIds[0])).materialDigest]));
    assert.equal(qaCaseVerdict(multiple, multiExecutions, identities).status, 'PASS');
    assert.equal(qaCaseVerdict(multiple, multiExecutions.slice(1), identities).status, 'UNKNOWN', 'A missing binding phase cannot borrow another material set');
    assert.equal(qaCaseVerdict(multiple, [...multiExecutions, multiExecutions[0]], identities).status, 'UNKNOWN', 'Duplicate executions for the same material stay ambiguous');
    assert.equal(qaCaseVerdict(multiple, multiExecutions.map(e => ({...e, materialDigest: 'f'.repeat(64)})), identities).status, 'UNKNOWN', 'Check IDs cannot substitute another material identity');
    await sealQaAttestation({store: f.store, version: f.version(), tasks: [f.record.task], gitRunner: f.gitRunner});
    const launched = f.spawned.count;
    ready = await f.prepare({cases: [multiple]});
    const reused = await f.execute(ready.generation, imported);
    assert.deepEqual(reused.reused, [multiple.id]); assert.equal(f.spawned.count, launched, 'Unchanged exact binding pairs reuse trusted proof without another process');
    const mixed = {...answerCase, bindings: [...bind(['answer-two']), multiple.bindings[1]]};
    ready = await f.prepare({cases: [mixed]});
    const mixedResult = await f.execute(ready.generation, imported);
    assert.equal(mixedResult.state, 'testing', 'Behavioral red checks are required per case; an additional invariant binding still needs both observed phases');
    await sealQaAttestation({store: f.store, version: f.version(), tasks: [f.record.task], gitRunner: f.gitRunner});
    await writeFile(join(f.root, 'feature.mjs'), feature(2).replace('legacy = () => 1', 'legacy = () => 0'));
    f.git(['add', 'feature.mjs']); f.git(['commit', '-qm', 'candidate repairs legacy baseline failure']);
    ready = await f.prepare({cases: [{...legacyCase, required: true}]});
    const invalidInvariant = await f.execute(ready.generation, imported);
    assert.equal(invalidInvariant.state, 'blocked', 'An invariant requires baseline PASS as well as candidate PASS');
    assert.equal((await f.store.get(invalidInvariant.report)).results[0].status, 'UNKNOWN');
    await assert.rejects(sealQaAttestation({store: f.store, version: f.version(), tasks: [f.record.task], gitRunner: f.gitRunner}), {code: 'QA_NOT_READY'});
  }),
  'qa-defect-closure': () => fixture(async f => {
    const {sealQaAttestation} = await qa('runtime/src/qa/proof.js', 'executeQaAttempt', 'sealQaAttestation');
    const {loadFindingPin} = await load('runtime/src/task/pin-finding.js');
    const {validateCriterion} = await load('runtime/src/schema/validate.js');
    const {FileFollowupStore} = await load('runtime/src/followup/store.js');
    // A buggy candidate that also regresses the name: required failure, introduced regression and a pre-existing defect.
    const bug = await f.commit(3, 'broken');
    const imported = await f.importMaterial();
    const failed = f.git(['rev-parse', 'HEAD']).trim();
    let ready = await f.prepare({cases: [answerCase, legacyCase, nameCase]});
    const result = await f.execute(ready.generation, imported);
    assert.equal(result.state, 'awaiting-repair', 'In-scope reproducible findings return to the developer automatically');
    const report = await f.store.get(result.report);
    const byCase = Object.fromEntries(report.findings.map((finding, index) => [finding.caseId, {finding, index}]));
    assert.deepEqual({blocking: byCase['case-answer'].finding.blocking, reproducible: byCase['case-answer'].finding.reproducible},
      {blocking: true, reproducible: true});
    assert.deepEqual({blocking: byCase['case-name'].finding.blocking, introduced: byCase['case-name'].finding.introduced}, {blocking: true, introduced: true},
      'A nonrequired check green on the baseline and red now is an introduced regression that blocks');
    assert.deepEqual({blocking: byCase['case-legacy'].finding.blocking, introduced: byCase['case-legacy'].finding.introduced}, {blocking: false, introduced: false});
    assert.ok(byCase['case-answer'].finding.reproduction.some(step => step.includes('qa-runner') && step.includes(failed)), 'The exact reproduction is preserved');
    const failing = await f.store.get(byCase['case-answer'].finding.executions[0]);
    assert.deepEqual({phase: failing.run.phase, commit: failing.version.candidateCommit}, {phase: 'candidate', commit: failed});
    // Nonblocking pre-existing findings reach followup with QA provenance, never receipt or review provenance.
    const ledger = await new FileFollowupStore(join(f.root, '.git')).read();
    assert.equal(ledger.items.length, 1);
    const [item] = ledger.items;
    assert.deepEqual({origin: item.provenance.origin, reportDigest: item.provenance.reportDigest, index: item.provenance.index, caseId: item.provenance.caseId,
      kind: item.kind, receipt: item.provenance.receiptPath, round: item.provenance.round},
      {origin: 'qa', reportDigest: result.report.digest, index: byCase['case-legacy'].index, caseId: 'case-legacy', kind: 'candidate', receipt: undefined, round: undefined});
    assert.equal(item.original.origin, 'pre-existing');
    // Validated QA findings pin as regression criteria bound to the saved report, index, failed candidate and requirements.
    const recordNow = await f.latest(f.record.task.id);
    const criterion = {id: 'qa-answer-regression', description: 'The QA answer finding stays fixed', verifierIds: ['tests'],
      acceptance: {mode: 'behavioral', baselineCommit: failed, bindings: bind(['answer-two'])}};
    const reference = `qa:${result.report.digest}:${byCase['case-answer'].index}`;
    const pinned = await loadFindingPin(f.root, recordNow, reference, criterion);
    assert.deepEqual(pinned.finding, {pinId: hash(reference), reportDigest: result.report.digest, findingIndex: byCase['case-answer'].index,
      candidateCommit: failed, criterionIds: ['behavior'], source: 'qa'});
    assert.equal(pinned.acceptance.baselineCommit, failed, 'The repaired candidate must turn this same red check green');
    assert.equal(validateCriterion(pinned, '$.criterion').ok, true);
    assert.equal(validateCriterion({...pinned, finding: {...pinned.finding, source: 'review'}}, '$.criterion').ok, false);
    // QA output is never accepted as a saved review report.
    await assert.rejects(loadFindingPin(f.root, recordNow, `${result.report.digest}:${byCase['case-answer'].index}`, criterion), {code: 'TASK_FINDING_NOT_FOUND'});
    await assert.rejects(loadFindingPin(f.root, recordNow, reference, {...criterion, acceptance: {...criterion.acceptance, mode: 'invariant', bindings: bind(['answer-two'], [])}}),
      {code: 'TASK_PIN_ACCEPTANCE_REQUIRED'});
    const unreproduced = await f.store.put('report', {...report, findings: [{...byCase['case-answer'].finding, reproducible: false}]});
    await assert.rejects(loadFindingPin(f.root, recordNow, `qa:${unreproduced.digest}:0`, criterion), {code: 'TASK_QA_FINDING_UNREPRODUCED'});
    const {taskContractHash} = await load('runtime/src/task/contract.js');
    const pinnedTask = await f.service.pinFinding(f.record.task.id, taskContractHash(recordNow.task), reference, criterion);
    const task = pinnedTask.record.task;
    assert.equal(task.criteria.find(c => c.id === 'qa-answer-regression').finding.source, 'qa', 'The task service accepts the validated QA source');
    // Replanning cannot drop an open blocking finding: it stays open until the same case passes.
    const planWithout = await f.prepare({task, cases: [legacyCase]});
    const carried = await f.execute(planWithout.generation, imported, {task});
    assert.equal(carried.state, 'awaiting-repair');
    assert.ok((await f.store.get(carried.report)).findings.some(x => x.id === byCase['case-answer'].finding.id && x.blocking));
    // Repair: the developer fixes both; QA re-executes the same case on the new candidate and closes it red -> green.
    const fixed = await f.commit(2, 'qa');
    const pinCase = {...answerCase, criterionIds: ['behavior', 'qa-answer-regression']};
    ready = await f.prepare({task, cases: [pinCase, legacyCase, nameCase]});
    const retest = await f.execute(ready.generation, imported, {task});
    const after = await f.store.get(retest.report);
    assert.deepEqual(after.findings.map(x => x.caseId), ['case-legacy'], 'Only the nonblocking pre-existing finding remains');
    const green = after.results.find(r => r.caseId === 'case-answer');
    assert.equal(green.status, 'PASS');
    assert.ok(green.executions.every(ref => !byCase['case-answer'].finding.executions.some(old => old.digest === ref.digest)), 'Re-test executes again; no pre-fix reuse');
    assert.ok((await Promise.all(green.executions.map(ref => f.store.get(ref)))).every(e => e.version.candidateCommit === fixed));
    assert.equal(retest.state, 'testing'); assert.notEqual(bug, fixed);
    await assert.rejects(sealQaAttestation({store: f.store, version: f.version(), tasks: [f.record.task], gitRunner: f.gitRunner}), {code: 'QA_PROOF_STALE'},
      'Observations under the pre-pin contract cannot seal');
    const sealed = await sealQaAttestation({store: f.store, version: f.version(task), tasks: [task], gitRunner: f.gitRunner});
    assert.equal((await f.store.get(sealed.attestation)).version.candidateCommit, fixed);
  }),
  'qa-recovery-controls': () => fixture(async f => {
    const {classifyQaHostEvent, resumeQaAuthor, runQaAuthor} = await qa('runtime/src/qa/author.js', 'classifyQaHostEvent', 'resumeQaAuthor', 'runQaAuthor');
    const {sealQaAttestation} = await qa('runtime/src/qa/proof.js', 'executeQaAttempt', 'sealQaAttestation');
    const {stopQa, claimQaControl} = await load('runtime/src/qa/session.js');
    const {nativeProcessIdentity} = await load('runtime/src/run/transport.js');
    await f.commit(3);
    const imported = await f.importMaterial();
    // The same semantic failure twice in a row stops; commit churn and wording are not progress.
    let ready = await f.prepare({cases: [answerCase]});
    let round = await f.execute(ready.generation, imported);
    assert.equal(round.state, 'awaiting-repair'); assert.equal((await control(f)).progress.consecutive, 1);
    await f.commit(3, 'qa', 'unrelated churn\n');
    ready = {generation: (await claimQaControl(f.store, {taskId: f.record.task.id, controllerId: 'controller', session, state: 'testing', now: at})).generation};
    await f.store.updateControl(f.record.task.id, (await control(f)).revision, c => ({...c, revision: c.revision + 1, owner: null}));
    round = await f.execute(ready.generation, imported);
    assert.equal(round.state, 'blocked'); assert.ok(round.blockers[0].startsWith('no-progress'));
    let current = await control(f);
    assert.deepEqual({continuation: current.continuation, consecutive: current.progress.consecutive}, {continuation: false, consecutive: 2});
    await assert.rejects(claimQaControl(f.store, {taskId: f.record.task.id, controllerId: 'controller', session, state: 'testing', now: at}),
      {code: 'QA_CONTINUATION_DISABLED'}, 'No automatic continuation after a no-progress stop');
    // Useful progress (a different semantic failure) continues with no total round cap.
    const states = [];
    for (const [answer, name] of [[2, 'broken'], [3, 'qa'], [2, 'broken'], [3, 'qa']]) {
      await f.commit(answer, name);
      ready = await f.prepare({cases: [answerCase, nameCase]});
      const next = await f.execute(ready.generation, imported);
      states.push([next.state, (await control(f)).progress.consecutive]);
    }
    assert.deepEqual(states, Array(4).fill(['awaiting-repair', 1]));
    // Stop fences an in-flight result; a later stale result cannot overwrite it.
    ready = await f.prepare({cases: [answerCase]});
    const flight = f.execute(ready.generation, imported);
    await f.store.readControl(f.record.task.id);
    await stopQa(f.store, f.record.task.id, at);
    await assert.rejects(flight, e => ['QA_STALE_WRITER', 'QA_CONTINUATION_DISABLED'].includes(e.code));
    current = await control(f);
    assert.deepEqual({state: current.state, continuation: current.continuation}, {state: 'stopped', continuation: false});
    // A live writer blocks execution, sealing and takeover; a lost process is taken over only after its death is confirmed.
    const {releaseQaControl} = await load('runtime/src/qa/session.js');
    const sleeper = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'ignore'});
    ready = await f.prepare({cases: [answerCase]});
    current = await control(f);
    const identity = await nativeProcessIdentity(sleeper.pid);
    await f.store.updateControl(f.record.task.id, current.revision, c => ({...c, revision: c.revision + 1, generation: c.generation + 1,
      owner: {controllerId: 'other', session: {...session, sessionId: 'other-qa'}, processId: sleeper.pid, processIdentity: identity}}));
    await assert.rejects(f.execute((await control(f)).generation, imported), {code: 'QA_WRITER_LIVE'});
    await assert.rejects(sealQaAttestation({store: f.store, version: f.version(), tasks: [f.record.task], gitRunner: f.gitRunner}), {code: 'QA_WRITER_LIVE'});
    await assert.rejects(claimQaControl(f.store, {taskId: f.record.task.id, controllerId: 'controller', session, state: 'testing', explicit: true, now: at}), {code: 'QA_WRITER_LIVE'});
    sleeper.kill('SIGKILL');
    for (let i = 0; i < 100 && await nativeProcessIdentity(sleeper.pid) !== null; i++) await new Promise(r => setTimeout(r, 50));
    const lostGeneration = (await control(f)).generation;
    const taken = await claimQaControl(f.store, {taskId: f.record.task.id, controllerId: 'controller', session, state: 'testing', explicit: true, now: at});
    assert.equal(taken.generation, lostGeneration + 1, 'Takeover follows confirmed death of the lost process');
    await releaseQaControl(f.store, taken, {state: 'blocked'}, at);
    // Event classification: strictly pre-resume notifications are ignored; provider limits differ from native denials.
    const event = patch => ({type: 'message', host: 'claude', runId: 'r', workerId: 'w', generation: 1, contractHash: 'h', at, nativeStatus: 'unknown', payload: {}, proof: false, ...patch});
    assert.equal(classifyQaHostEvent(event({type: 'completed', at: '2026-11-13T00:00:00.000Z'}), '2026-11-13T00:00:01.000Z'), 'stale');
    assert.equal(classifyQaHostEvent(event({type: 'completed', at: '2026-11-13T00:00:01.000Z'}), '2026-11-13T00:00:01.000Z'), 'completed');
    assert.equal(classifyQaHostEvent(event({payload: {error: {type: 'rate_limit_error'}}})), 'provider-limit');
    assert.equal(classifyQaHostEvent(event({nativeStatus: 'usageLimited'})), 'provider-limit');
    assert.equal(classifyQaHostEvent(event({type: 'error', payload: {permission_denials: [{tool_name: 'Bash'}]}})), 'denied');
    assert.equal(classifyQaHostEvent(event({host: 'codex', transportMethod: 'item/autoApprovalReview/completed', payload: {review: {status: 'denied'}}})), 'denied');
    assert.equal(classifyQaHostEvent(event({type: 'error', payload: {message: 'quota words in prose are not a provider limit'}})), 'failed');
    // Provider limit: the paused session is saved, continuation kept, and no blind retry before a known reset.
    const {plan} = await f.prepare({cases: [answerCase], state: 'plan-ready'});
    const head = f.git(['rev-parse', 'HEAD']).trim();
    const resetAt = '2099-01-01T00:00:00.000Z', resumedAt = '2026-11-13T01:00:00.000Z';
    const writeResponse = async (handle, generation) => {
      await mkdir(join(handle.cwd, 'tests/qa-resumed'), {recursive: true});
      await writeFile(join(handle.cwd, 'tests/qa-resumed/resumed.test.mjs'), 'export {};\n');
      await mkdir(join(handle.cwd, '.agent-ops'), {recursive: true});
      await writeFile(join(handle.cwd, '.agent-ops/qa-author-response.json'), JSON.stringify({schemaVersion: 1, generation, plan: plan.digest, candidateCommit: head,
        materials: [{path: 'tests/qa-resumed/resumed.test.mjs', role: 'test', caseIds: ['case-answer']}], requestedEdits: [], observations: [], questions: []}));
    };
    let fake = fakeNative({events: async (handle, calls) => calls.some(c => c.kind === 'resume') ? (await writeResponse(handle, handle.generation), [
      {type: 'completed', at: '2026-11-13T00:59:59.000Z'}, {type: 'message', nativeStatus: 'usageLimited', at: '2026-11-13T00:59:59.000Z'},
      {type: 'completed', at: resumedAt, payload: {usage: {input_tokens: 4, output_tokens: 2}}}])
      : [{type: 'message', at, nativeStatus: 'usageLimited', payload: {error: {type: 'rate_limit_error', resetsAt: resetAt}}}]});
    const base = {store: f.store, root: f.root, version: f.version(), plan, available: ['claude'], implementationHost: 'codex',
      implementationSessionId: 'developer-session', controllerId: 'controller', host: fake.host, probe: fake.probe, now: () => at};
    const checkout = join(f.outside, 'resumable');
    await assert.rejects(runQaAuthor({...base, checkout, explicit: true}), e => e.code === 'QA_PROVIDER_LIMIT' && e.recoveryPaths.includes(checkout));
    current = await control(f);
    assert.deepEqual({state: current.state, continuation: current.continuation, owner: current.owner, reason: current.native.reason,
      resetAt: current.native.resetAt, checkout: current.native.checkout}, {state: 'blocked', continuation: true, owner: null, reason: 'provider-limit', resetAt, checkout});
    const starts = fake.calls.length;
    await assert.rejects(resumeQaAuthor({...base}), {code: 'QA_PROVIDER_WAIT'});
    assert.equal(fake.calls.length, starts, 'No native call is made before the provider reset');
    // Explicit resume acknowledges the active goal and ignores strictly pre-resume notifications.
    const resumed = await resumeQaAuthor({...base, explicit: true, now: () => resumedAt});
    const resumeCall = fake.calls.find(c => c.kind === 'resume');
    assert.deepEqual({session: resumeCall.nativeSessionId, manualResumeAt: resumeCall.input.manualResumeAt, cwd: resumeCall.input.cwd},
      {session: current.native.nativeSessionId, manualResumeAt: resumedAt, cwd: checkout});
    assert.ok(fake.calls.findIndex(c => c.kind === 'activate') < fake.calls.length, 'The resumed host must acknowledge its goal');
    assert.deepEqual(resumed.inspected.materials.map(m => m.path), ['tests/qa-resumed/resumed.test.mjs']);
    assert.deepEqual(resumed.usage, {inputTokens: 4, outputTokens: 2, totalTokens: 6, costUsd: null}, 'Unreported cost stays UNKNOWN');
    assert.equal((await control(f)).native, undefined, 'A claimed native pause is consumed');
    // A resumed session that does not acknowledge an active goal is rejected.
    fake = fakeNative({activation: () => ({actionId: 'a', accepted: true, nativeStatus: 'paused', payload: null}),
      events: async () => [{type: 'message', at, nativeStatus: 'usageLimited', payload: {error: {type: 'rate_limit_error'}}}]});
    await assert.rejects(runQaAuthor({...base, host: fake.host, probe: fake.probe, checkout: join(f.outside, 'second'), explicit: true}), {code: 'QA_PROVIDER_LIMIT'});
    await assert.rejects(resumeQaAuthor({...base, host: fake.host, probe: fake.probe, explicit: true}), {code: 'QA_AUTHOR_NOT_ACTIVE'});
    // A native denial is permanent for automation: continuation off, resume only by explicit user command.
    fake = fakeNative({events: async () => [{type: 'error', at, payload: {permission_denials: [{tool_name: 'Bash', tool_use_id: 't1'}]}}]});
    await assert.rejects(runQaAuthor({...base, host: fake.host, probe: fake.probe, checkout: join(f.outside, 'denied'), explicit: true}), {code: 'QA_NATIVE_DENIED'});
    current = await control(f);
    assert.deepEqual({state: current.state, continuation: current.continuation, reason: current.native.reason}, {state: 'blocked', continuation: false, reason: 'denied'});
    await assert.rejects(resumeQaAuthor({...base, host: fake.host, probe: fake.probe, now: () => '2100-01-01T00:00:00.000Z'}), {code: 'QA_CONTINUATION_DISABLED'});
    assert.equal(existsSync(join(f.outside, 'denied')), true, 'The dirty QA checkout is preserved for diagnosis');
  }),
  'qa-human-decisions': () => fixture(async f => {
    const {respondQa} = await qa('runtime/src/qa/decisions.js', 'respondQa', 'showQa');
    const {sealQaAttestation} = await qa('runtime/src/qa/proof.js', 'executeQaAttempt', 'sealQaAttestation');
    await f.commit(2);
    const imported = await f.importMaterial();
    const locale = {id: 'locale-choice', prompt: 'Which locale is required?', required: true, criterionIds: ['behavior']};
    const padding = {id: 'zero-padding', prompt: 'Accept 007?', required: false, criterionIds: ['behavior']};
    let ready = await f.prepare({cases: [answerCase, docsCase], questions: [locale, padding], state: 'awaiting-input'});
    const respond = patch => respondQa({store: f.store, version: f.version(), questionId: 'locale-choice', answer: 'en-US only',
      answeredBy: 'human via relay', now: at, env: {}, ...patch});
    await assert.rejects(respond({env: {AGENT_OPS_QA_TASK_ID: f.record.task.id}}), {code: 'QA_ANSWER_NOT_HUMAN'}, 'QA cannot answer its own question');
    await assert.rejects(respond({questionId: 'waive-case-answer'}), {code: 'QA_QUESTION_UNKNOWN'}, 'Answers cannot introduce a waiver question');
    await assert.rejects(respond({version: f.version(f.record.task, undefined, {scopeHash: 'f'.repeat(64)})}), {code: 'QA_PLAN_STALE'});
    assert.equal(existsSync(join(f.store.directory, 'decision')), false, 'Nothing is recorded for a rejected answer');
    let current = await respond();
    assert.equal(current.state, 'plan-ready', 'A planning answer resumes planned work');
    const [decisionRef] = current.decisions;
    const decision = await f.store.get(decisionRef);
    assert.deepEqual({task: decision.version.taskId, question: decision.questionId, plan: decision.plan.digest, answer: decision.answer},
      {task: f.record.task.id, question: 'locale-choice', plan: (await control(f)).plan.digest, answer: 'en-US only'});
    await assert.rejects(respond(), {code: 'QA_QUESTION_ANSWERED'});
    // Live: answering the required question made the plan ready, and the human's answer to the optional one was refused.
    const optional = respond({questionId: 'zero-padding', answer: 'Reject all'});
    await assert.doesNotReject(optional, 'An optional question stays answerable while the plan waits for its author');
    current = await optional;
    assert.deepEqual({state: current.state, decisions: current.decisions.length}, {state: 'plan-ready', decisions: 2});
    // Questions raised while testing pause the tested candidate; the answer resumes testing, then sealing.
    current = await f.store.updateControl(f.record.task.id, current.revision, c => ({...c, revision: c.revision + 1, state: 'testing'}));
    await assert.rejects(respond({questionId: 'zero-padding'}), {code: 'QA_NOT_AWAITING_INPUT'}, 'Testing is never interrupted by an answer');
    const wording = {id: 'ux-wording', prompt: 'Is the wording acceptable?', required: true, criterionIds: ['compatibility']};
    const tested = await f.execute(current.generation, imported, {author: {questions: [wording]}});
    assert.equal(tested.state, 'awaiting-input');
    await assert.rejects(sealQaAttestation({store: f.store, version: f.version(), tasks: [f.record.task], gitRunner: f.gitRunner}), {code: 'QA_NOT_READY'});
    current = await respond({questionId: 'ux-wording', answer: 'Acceptable for v1'});
    assert.equal(current.state, 'testing');
    const sealed = await sealQaAttestation({store: f.store, version: f.version(), tasks: [f.record.task], gitRunner: f.gitRunner});
    assert.equal((await f.store.get(sealed.attestation)).decisions.length, 3);
    // A human answer cannot waive a required mechanical failure or a missing necessary environment.
    await f.commit(3);
    const browser = {name: 'browser', required: true, status: 'missing', evidence: ['No authorized browser tool']};
    ready = await f.prepare({cases: [answerCase, docsCase], questions: [locale], environment: [browser], state: 'awaiting-input'});
    current = await respond({answer: 'Ship without the browser; I waive it'});
    current = await f.store.updateControl(f.record.task.id, current.revision, c => ({...c, revision: c.revision + 1, state: 'testing'}));
    const failing = await f.execute(current.generation, imported);
    assert.equal(failing.state, 'awaiting-repair');
    // Even with the state forced to testing, sealing re-derives every blocker from saved data.
    current = await control(f);
    await f.store.updateControl(f.record.task.id, current.revision, c => ({...c, revision: c.revision + 1, state: 'testing'}));
    await assert.rejects(sealQaAttestation({store: f.store, version: f.version(), tasks: [f.record.task], gitRunner: f.gitRunner}),
      e => e.code === 'QA_BLOCKING_FINDING' && /QA_REQUIRED_CASE_UNMET case-answer/u.test(e.message) && /QA_ENVIRONMENT_MISSING browser/u.test(e.message));
    assert.ok(ready.plan);
  }),
  'qa-usage-reuse': () => fixture(async f => {
    const {showQa} = await qa('runtime/src/qa/decisions.js', 'showQa');
    const {sealQaAttestation, currentQaAttestation, qaUsageSum} = await qa('runtime/src/qa/proof.js', 'sealQaAttestation', 'currentQaAttestation', 'qaUsageSum');
    await f.commit(2);
    const imported = await f.importMaterial();
    const usage = {inputTokens: 11, outputTokens: 7, totalTokens: 18, costUsd: null};
    let ready = await f.prepare({cases: [answerCase, docsCase]});
    const first = await f.execute(ready.generation, imported, {author: {usage}});
    const spawnedAfterFirst = f.spawned.count;
    assert.ok(spawnedAfterFirst > 0);
    // Unchanged plan, version and materials: the valid observation is reused, never blindly re-run.
    const second = await f.execute(ready.generation, imported, {author: {usage}});
    assert.deepEqual(second.reused, ['case-answer']); assert.equal(f.spawned.count, spawnedAfterFirst, 'No process runs for unchanged conditions');
    const results = async ref => (await f.store.get(ref)).results.find(r => r.caseId === 'case-answer').executions.map(e => e.digest);
    assert.deepEqual(await results(second.report), await results(first.report));
    // A changed plan is a changed condition.
    ready = await f.prepare({cases: [{...answerCase, expected: 'The answer is still two'}, docsCase]});
    const replanned = await f.execute(ready.generation, imported, {author: {usage}});
    assert.deepEqual(replanned.reused, []); assert.ok(f.spawned.count > spawnedAfterFirst);
    // Status reads spend nothing and change nothing; missing usage is UNKNOWN, reported usage is kept.
    const files = async () => (await readdir(f.store.directory, {recursive: true})).sort();
    const before = {files: await files(), revision: (await control(f)).revision, spawned: f.spawned.count};
    const shown = await showQa(f.store, f.record.task.id, f.version());
    assert.deepEqual({files: await files(), revision: (await control(f)).revision, spawned: f.spawned.count}, before);
    assert.deepEqual(shown.usage, {inputTokens: 11, outputTokens: 7, totalTokens: 18, costUsd: 'UNKNOWN'});
    assert.deepEqual({state: shown.state, stale: shown.stale, results: shown.results}, {state: 'testing', stale: false, results: {PASS: 1, FAIL: 0, UNKNOWN: 1}});
    assert.equal((await showQa(f.store, 'task-never-enrolled')).state, 'not-started', 'An unenrolled task is never shown as QA PASS');
    assert.deepEqual(qaUsageSum(usage, {inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.5}),
      {inputTokens: 12, outputTokens: 8, totalTokens: 20, costUsd: null});
    // A sealed attestation is reused only while every version input is unchanged.
    const sealed = await sealQaAttestation({store: f.store, version: f.version(), tasks: [f.record.task], gitRunner: f.gitRunner});
    const again = await sealQaAttestation({store: f.store, version: f.version(), tasks: [f.record.task], gitRunner: f.gitRunner});
    assert.deepEqual(again, {attestation: sealed.attestation, reused: true});
    await f.commit(2, 'qa', 'changed after sealing\n');
    assert.equal(await currentQaAttestation(f.store, f.version()), null, 'A changed candidate makes the attestation stale');
    assert.equal((await showQa(f.store, f.record.task.id, f.version())).stale, true);
    ready = await f.prepare({cases: [answerCase, docsCase]});
    const moved = await f.execute(ready.generation, imported, {author: {usage}});
    assert.deepEqual(moved.reused, [], 'Evidence from another candidate is never reused');
  })
};
