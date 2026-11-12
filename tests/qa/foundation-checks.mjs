import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const load = path => import(pathToFileURL(join(build, path)).href);
const hash = value => createHash('sha256').update(value).digest('hex');
const config = () => ({schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: [
  {id: 'tests', command: 'node', args: ['test.mjs'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}]},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []});
const input = () => ({title: 'Deliver QA foundation', goal: 'Preserve immutable user objective', criteria: [
  {id: 'behavior', description: 'Observable behavior', verifierIds: ['tests']},
  {id: 'compatibility', description: 'Compatible readers', verifierIds: ['tests']} ]});
const at = '2026-11-13T00:00:00.000Z';
const qa = {schemaVersion: 1, required: true, policyHash: 'a'.repeat(64), enrolledAt: at, enrollment: 'new', late: false};

async function fixture(check) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-qa-foundation-'));
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  const gitRunner = {run: async args => {
    try {return {exitCode: 0, stdout: Buffer.from(git(args))};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: Buffer.from(e.stdout ?? '')};}
  }};
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(root, 'source.txt'), 'baseline\n'); git(['add', '.']); git(['commit', '-qm', 'baseline']);
    const baseline = git(['rev-parse', 'HEAD']).trim();
    const {TaskService} = await load('runtime/src/task/service.js');
    const {FileTaskStore} = await load('runtime/src/task/store.js');
    const store = new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root);
    let activeConfig = config(), nextId = 0;
    const service = (platform = 'darwin', deliveryRole) => new TaskService(store, {generateId: () => `task-qa-${++nextId}`, now: () => at, platform, deliveryRole,
      completion: {root, gitRunner, loadConfig: async () => structuredClone(activeConfig)}});
    await check({root, git, gitRunner, baseline, store, service, setConfig: c => {activeConfig = c;}});
  } finally {await rm(root, {recursive: true, force: true});}
}

export const foundationChecks = {
  'qa-enrollment-contract': () => fixture(async f => {
    const {taskContractHash, executionContractHash} = await load('runtime/src/task/contract.js');
    const {calculateConfigHash} = await load('runtime/src/config/hash.js');
    const {validateConfig, validateTask} = await load('runtime/src/schema/validate.js');
    const {mergeConfigLayers} = await load('runtime/src/config/merge.js');
    const enabled = {...config(), qa: {enabled: true}};
    const legacy = await f.service().create(input());
    f.setConfig(enabled);
    const enrolled = await f.service().create(input());
    // This is an observable assertion on the real legacy service, not an absent-module error at replay.
    assert.equal(enrolled.task.qa?.required, true, 'Opted-in integrated deliveries must acquire the QA requirement at creation');
    assert.equal(enrolled.task.qa.enrollment, 'new');
    assert.equal(enrolled.task.qa.late, false);
    assert.equal(validateTask(enrolled.task).ok, true);
    assert.equal(validateConfig(enabled).ok, true);
    assert.equal(validateConfig({...enabled, qa: {enabled: true, command: 'untrusted'}}).ok, false);
    assert.equal(validateConfig({...enabled, qa: {enabled: 'true'}}).ok, false);
    const {Ajv2020} = await import('ajv/dist/2020.js');
    const {default: addFormats} = await import('ajv-formats');
    const ajv = new Ajv2020({strict: true}); addFormats(ajv);
    const schema = ajv.compile(JSON.parse(await readFile('schemas/task.schema.json', 'utf8')));
    for (const value of [enrolled.task, {...enrolled.task, qa: {...enrolled.task.qa, late: true}},
      {...enrolled.task, parentTaskId: 'task-parent'}, {...enrolled.task, schemaVersion: 1},
      {...enrolled.task, qa: {...enrolled.task.qa, required: false}}, {...enrolled.task, qa: {...enrolled.task.qa, enrolledAt: '2026-02-31T00:00:00Z'}},
      {...enrolled.task, qa: {...enrolled.task.qa, override: true}}])
      assert.equal(validateTask(value).ok, schema(value), JSON.stringify(schema.errors));
    const child = await f.service().create({...input(), parentTaskId: enrolled.task.id});
    assert.equal(child.task.qa, undefined, 'Children retain local proof instead of a second full QA enrollment');
    const attached = await f.service().create({...input(), sessionId: 'writer'});
    const implicitChild = await f.service().create({...input(), sessionId: 'writer'});
    assert.equal(implicitChild.task.parentTaskId, attached.task.id);
    assert.equal(implicitChild.task.qa, undefined);
    assert.equal((await f.service('darwin', 'child').create(input())).task.qa, undefined, 'Native children have no local parent record');
    for (const platform of ['linux', 'win32']) {
      await assert.rejects(f.service(platform).create(input()), {code: 'QA_UNSUPPORTED_PLATFORM'});
      assert.equal((await f.service(platform).create({...input(), parentTaskId: enrolled.task.id})).task.qa, undefined);
    }
    assert.equal((await f.service().status({taskId: legacy.task.id})).task.qa, undefined, 'Opt-in cannot silently adopt an in-flight task');
    f.setConfig(config());
    const early = await f.service().create(input());
    f.setConfig(enabled);
    const earlyAdoption = await f.service().adoptQa(early.task.id, {expectedContractHash: taskContractHash(early.task), reason: 'Explicit early adoption'});
    assert.equal(earlyAdoption.task.qa.late, false);
    assert.deepEqual(await f.service().adoptQa(early.task.id, {expectedContractHash: taskContractHash(earlyAdoption.task), reason: 'Already adopted'}), earlyAdoption);
    await writeFile(join(f.root, 'source.txt'), 'implementation\n');
    const adopted = await f.service().adoptQa(legacy.task.id, {expectedContractHash: taskContractHash(legacy.task), reason: 'Explicit user adoption'});
    assert.equal(adopted.task.qa.required, true);
    assert.equal(adopted.task.qa.enrollment, 'adopted');
    assert.equal(adopted.task.qa.late, true);
    assert.equal(adopted.task.goal, legacy.task.goal);
    assert.equal(adopted.revisions[0].previousTask.qa, undefined);
    assert.equal(adopted.revisions[0].previousHash, taskContractHash(legacy.task));
    assert.notEqual(taskContractHash(adopted.task), taskContractHash(legacy.task));
    assert.equal(executionContractHash(adopted.task), executionContractHash(legacy.task));
    await assert.rejects(f.service().adoptQa(child.task.id, {expectedContractHash: taskContractHash(child.task), reason: 'Child'}), {code: 'QA_DELIVERY_ROOT_REQUIRED'});
    f.setConfig({...config(), qa: {enabled: false}});
    const off = await f.service('linux').create(input());
    assert.equal(off.task.qa, undefined);
    assert.equal(calculateConfigHash({...config(), qa: {enabled: false}}), calculateConfigHash(config()));
    const revised = await f.service().revise(enrolled.task.id, {expectedContractHash: taskContractHash(enrolled.task),
      criteria: enrolled.task.criteria, reason: 'Keep enrolled QA while the project default changes'});
    assert.deepEqual(revised.task.qa, enrolled.task.qa);
    await assert.rejects(f.service().adoptQa(off.task.id, {expectedContractHash: taskContractHash(off.task), reason: 'Must opt in'}), {code: 'QA_NOT_ENABLED'});
    assert.equal(mergeConfigLayers([{source: 'user', sourcePath: 'user.json', config: enabled}]).config.qa, undefined, 'User defaults never enroll a project');
    const merged = mergeConfigLayers([{source: 'user', sourcePath: 'user.json', config: enabled},
      {source: 'project', sourcePath: 'project.json', config: config()}]);
    assert.equal(merged.config.qa, undefined);
    assert.equal(mergeConfigLayers([{source: 'project', sourcePath: 'project.json', config: enabled}]).config.qa.enabled, true);
    // Lifecycle fixtures are local test setup, not completion evidence or a production gate bypass.
    await f.store.mutate(state => {
      const index = state.tasks.findIndex(r => r.task.id === off.task.id);
      state.tasks[index] = {...state.tasks[index], status: 'complete', completedAt: at,
        evidence: Object.fromEntries(off.task.criteria.map(c => [c.id, ['fixture-proof']]))};
    });
    f.setConfig(enabled);
    await assert.rejects(f.service().adoptQa(off.task.id, {expectedContractHash: taskContractHash(off.task), reason: 'Historical task'}), {code: 'TASK_NOT_ACTIVE'});
  }),
  'qa-disabled-compatibility': () => fixture(async f => {
    const {validateConfig, validateTask, validateEvidence} = await load('runtime/src/schema/validate.js');
    const {taskContractHash, executionContractHash} = await load('runtime/src/task/contract.js');
    const {canonicalJson, calculateConfigHash} = await load('runtime/src/config/hash.js');
    const {mergeConfigLayers} = await load('runtime/src/config/merge.js');
    const c = config();
    assert.equal(validateConfig(c).ok, true);
    assert.equal(calculateConfigHash(c), hash(canonicalJson(c)));
    assert.equal(Object.hasOwn(mergeConfigLayers([{source: 'project', sourcePath: 'config.json', config: c}]).config, 'qa'), false);
    const record = await f.service('linux').create(input());
    assert.equal(Object.hasOwn(record.task, 'qa'), false);
    const old = record.task;
    const expected = {goalHash: hash(old.goal), title: old.title, intent: null, revision: 0,
      criteria: old.criteria.map(criterion => hash(canonicalJson(criterion)))};
    assert.equal(taskContractHash(old), hash(canonicalJson(expected)), 'Legacy task hash bytes must be unchanged');
    assert.equal(executionContractHash(old), hash(canonicalJson({domain: 'agent-ops-execution-v1', criteria: expected.criteria})));
    const schema1 = {schemaVersion: 1, id: 'task-old', title: 'Old task', criteria: input().criteria};
    assert.equal(validateTask(schema1).ok, true);
    assert.deepEqual((await f.service().status({taskId: old.id})).task, old, 'Reading does not materialize QA defaults');
    const evidence = {schemaVersion: 3, taskId: old.id, criterionId: 'behavior', commandId: 'tests', argv: ['node'], cwd: '.', scope: 'project',
      startedAt: at, finishedAt: at, exitCode: 0, testCount: null, status: 'PASS', failureClass: 'none', sourceFingerprint: 'a'.repeat(64),
      toolVersions: {}, configHash: calculateConfigHash(c)};
    assert.equal(validateEvidence(evidence).ok, true, 'Legacy evidence remains readable');
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js');
    const evidenceStore = new FileEvidenceStore(f.root, f.root);
    const reference = await evidenceStore.save(evidence);
    assert.deepEqual(await evidenceStore.load(reference), evidence);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, '.agent-ops/tasks/state.json'), 'utf8')).tasks[0].task, old);
    assert.equal(await lstat(join(f.root, '.git/agent-ops/qa')).then(() => true, () => false), false, 'Disabled task creation never starts QA state or a host');
  }),
  'qa-private-state': () => fixture(async f => {
    const {validateTask} = await load('runtime/src/schema/validate.js');
    const task = {schemaVersion: 2, id: 'task-private', ...input(), qa};
    assert.equal(validateTask(task).ok, true, 'Enrolled task contracts must stay readable alongside their private QA state');
    const {FileQaStore} = await load('runtime/src/qa/store.js');
    const {parseQaArtifact} = await load('runtime/src/qa/validate.js');
    const {qaVersionMatches} = await load('runtime/src/qa/policy.js');
    const {taskContractHash} = await load('runtime/src/task/contract.js');
    const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js');
    const {collectChangeSurface} = await load('runtime/src/verify/change-surface.js');
    const {SCENARIO_DIMENSIONS} = await load('runtime/src/surface/schema.js');
    const store = new FileQaStore(join(f.root, '.git'));
    const version = {taskId: task.id, goalHash: hash(task.goal), taskContractHash: taskContractHash(task), treeContractHash: 'b'.repeat(64),
      scopeHash: 'c'.repeat(64), policyHash: qa.policyHash, configHash: 'd'.repeat(64), candidateCommit: f.baseline, sourceFingerprint: 'e'.repeat(64)};
    const session = {host: 'claude', implementationHost: 'codex', sessionId: 'fresh-qa', implementationSessionId: 'developer', writable: false, fallbackReason: null};
    const plan = {schemaVersion: 1, id: 'plan-private', version, originalGoal: task.goal, taskIds: [task.id], dependencyTaskIds: [], scope: 'full',
      session, createdAt: at, timing: 'early', advisoryReferences: [], cases: [{id: 'case-prose', criterionIds: ['behavior'], surfaceIds: ['foundation'], required: true,
        mode: 'nonmechanical', preconditions: [], actions: ['Inspect written output'], expected: 'Accurate prose', bindings: [], nonmechanicalReason: 'Meaning of prose requires judgment'}],
      scenarios: Object.fromEntries(SCENARIO_DIMENSIONS.map(k => [k, {na: 'This prose inspection has no mutable execution state'}])),
      environment: [{name: 'macOS', required: true, status: 'available', evidence: ['fixture only']}], questions: []};
    const fingerprint = async () => await calculateSourceFingerprint(f.root, {mode: 'worktree', changedFiles: (await collectChangeSurface(f.gitRunner)).paths}, f.gitRunner);
    const before = await fingerprint();
    const ref = await store.put('plan', plan);
    assert.deepEqual(await store.get(ref), plan);
    assert.equal(store.directory, join(f.root, '.git/agent-ops/qa'));
    assert.equal((await lstat(store.artifactPath(ref))).mode & 0o777, 0o600);
    assert.deepEqual(await store.put('plan', plan), ref, 'Identical immutable artifacts are reused without model calls');
    const decision = {schemaVersion: 1, version, plan: ref, questionId: 'human-choice', answer: 'Authorization: Bearer fixture-secret', answeredBy: 'human', answeredAt: at};
    const decisionRef = await store.put('decision', decision);
    assert.match((await store.get(decisionRef)).answer, /REDACTED/u);
    assert.doesNotMatch(await readFile(store.artifactPath(decisionRef), 'utf8'), /fixture-secret/u);
    const control = {schemaVersion: 1, taskId: task.id, revision: 1, generation: 1, state: 'planning', continuation: true, owner: null,
      plan: ref, attempt: null, report: null, attestation: null, progress: null, updatedAt: at};
    await store.updateControl(task.id, 0, () => control);
    const secondStore = new FileQaStore(join(f.root, '.git'));
    const contenders = await Promise.allSettled([store, secondStore].map(s => s.updateControl(task.id, 1, current => ({...current, revision: 2, state: 'plan-ready'}))));
    assert.equal(contenders.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(contenders.find(r => r.status === 'rejected').reason.code, 'QA_CONTROL_CHANGED');
    assert.equal((await store.readControl(task.id)).revision, 2);
    assert.deepEqual(await store.readControlHistory(task.id, 1), control, 'Control updates retain exact earlier ownership and progress');
    const execution = {schemaVersion: 1, version, caseId: 'case-prose', runnerId: 'tests', materialDigest: 'f'.repeat(64),
      run: {protocolVersion: 1, executionId: 'fixture-run', framework: 'node-assert', frameworkVersion: '1', phase: 'candidate',
        results: [{executionId: 'fixture-run', framework: 'node-assert', frameworkVersion: '1', phase: 'candidate', checkId: 'assertion',
          status: 'PASS', failureClass: 'none', attempts: 1, evidence: ['fixture observation only']}], completed: true,
        completionEvidence: ['Test-only execution completed'], diagnostics: []}, evidenceReferences: [{path: '.agent-ops/tasks/acceptance/fixture.json', digest: 'f'.repeat(64)}]};
    const executionRef = await store.put('execution', execution);
    assert.deepEqual(await store.get(executionRef), execution);
    const writable = {...session, writable: true};
    const attempt = {schemaVersion: 1, id: 'attempt-one', version, generation: 1, plan: ref, session: writable,
      startedAt: at, finishedAt: at, materials: [{path: 'tests/qa/independent.mjs', role: 'test', digest: 'f'.repeat(64)}],
      materialDigest: 'f'.repeat(64), executions: [executionRef], usage: {inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null}};
    const attemptRef = await store.put('attempt', attempt);
    assert.deepEqual((await store.get(attemptRef)).usage, attempt.usage, 'Unreported usage stays UNKNOWN, never zero');
    const report = {schemaVersion: 1, id: 'report-one', version, attempt: attemptRef, createdAt: at,
      results: [{caseId: 'case-prose', status: 'PASS', executions: [], observations: ['Reasoned nonmechanical inspection']}], findings: [], questions: []};
    const reportRef = await store.put('report', report);
    assert.deepEqual(await store.get(reportRef), report);
    assert.equal((await store.readControl(task.id)).state, 'plan-ready', 'A model-authored PASS report never updates the controller verdict');
    const attestation = {schemaVersion: 1, version, plan: ref, report: reportRef, executions: [executionRef], decisions: [decisionRef],
      materialDigest: 'f'.repeat(64), caseIds: ['case-prose'], session: writable, generation: 1, sealedAt: at};
    const attestationRef = await store.put('attestation', attestation);
    assert.deepEqual(await store.get(attestationRef), attestation, 'Schema storage alone does not grant controller authority');
    for (const [kind, bad] of [
      ['attempt', {...attempt, materials: [{...attempt.materials[0], path: '../product.js'}]}],
      ['attempt', {...attempt, usage: {...attempt.usage, costUsd: -1}}],
      ['attempt', {...attempt, generation: 0}],
      ['attempt', {...attempt, session}],
      ['execution', {...execution, run: {...execution.run, completed: 'yes'}}],
      ['execution', {...execution, run: {...execution.run, results: [{...execution.run.results[0], status: 'PASS', failureClass: 'timeout'}]}}],
      ['execution', {...execution, evidenceReferences: [{path: '.agent-ops/../secret', digest: 'f'.repeat(64)}]}],
      ['report', {...report, results: [...report.results, ...report.results]}],
      ['report', {...report, attempt: {...attemptRef, kind: 'plan'}}],
      ['attestation', {...attestation, commands: ['make-pass']}]
    ]) assert.throws(() => parseQaArtifact(kind, bad), {code: 'QA_ARTIFACT_INVALID'});
    await store.updateControl(task.id, 2, c => ({...c, revision: 3, owner: {controllerId: 'controller', session: writable, processId: 123, processIdentity: 'fixture-process'}}));
    await assert.rejects(store.updateControl(task.id, 3, c => ({...c, revision: 4, generation: 2})), {code: 'QA_STATE_INVALID'});
    await assert.rejects(store.updateControl(task.id, 3, c => ({...c, revision: 4, owner: {...c.owner, processIdentity: 'other-process'}})), {code: 'QA_STATE_INVALID'});
    await store.updateControl(task.id, 3, c => ({...c, revision: 4, owner: null, continuation: false, state: 'stopped'}));
    assert.equal(taskContractHash(task), version.taskContractHash);
    assert.equal(await fingerprint(), before, 'Private QA progress cannot perturb source fingerprints');
    for (const key of Object.keys(version)) assert.equal(qaVersionMatches(version, {...version, [key]: key === 'taskId' ? 'task-other' : 'f'.repeat(key === 'candidateCommit' ? 40 : 64)}), false, key);
    assert.equal(qaVersionMatches(version, structuredClone(version)), true);
    for (const bad of [
      {...plan, argv: ['untrusted']}, {...plan, version: {...version, scopeHash: 'invalid'}}, {...plan, cases: [...plan.cases, ...plan.cases]},
      {...plan, session: {...session, sessionId: 'developer'}}, {...plan, session: {...session, writable: true}}, {...plan, session: {...session, host: 'agy', writable: true}},
      {...plan, session: {...session, host: 'codex'}}, {...plan, questions: [{id: 'q', prompt: 'Choose', required: true, criterionIds: []}]},
      {...plan, cases: [{...plan.cases[0], mode: 'behavioral', nonmechanicalReason: undefined, bindings: [{runnerId: 'tests', checkIds: ['check'], redCheckIds: ['check'], materials: [{path: '../escape', role: 'test'}]}]}]}
    ]) assert.throws(() => parseQaArtifact('plan', bad), {code: 'QA_ARTIFACT_INVALID'});
    await assert.rejects(store.get({...ref, digest: '../escape'}), {code: 'QA_STATE_INVALID'});
    await assert.rejects(store.readControl('../escape'), {code: 'QA_STATE_INVALID'});
    await assert.rejects(store.updateControl(task.id, 4, c => ({...c, revision: 5, generation: 0})), {code: 'QA_CONTROL_INVALID'});
    await assert.rejects(store.updateControl(task.id, 4, c => ({...c, revision: 5, state: 'passed'})), {code: 'QA_CONTROL_INVALID'});
    await writeFile(store.artifactPath(ref), JSON.stringify({...plan, originalGoal: 'tampered'}));
    await assert.rejects(store.get(ref), {code: 'QA_STATE_INVALID'});
    await writeFile(store.controlPath(task.id), '{malformed');
    await assert.rejects(store.readControl(task.id), {code: 'QA_STATE_INVALID'});
    await rm(store.controlPath(task.id));
    const outside = join(f.root, 'outside.json'); await writeFile(outside, JSON.stringify(control));
    await symlink(outside, store.controlPath(task.id));
    await assert.rejects(store.readControl(task.id));
    assert.equal(await readFile(outside, 'utf8'), JSON.stringify(control), 'Private-state validation must never alter a symlink target');
  })
};
