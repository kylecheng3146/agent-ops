import assert from 'node:assert/strict';
import {mkdir, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {checkedGit, config, load, runner, withRepository} from '../followup/fixture.mjs';

const {TaskService} = await load('runtime/src/task/service.js');
const {FileTaskStore} = await load('runtime/src/task/store.js');
const {calculateConfigHash} = await load('runtime/src/config/hash.js');
const {sha256} = await load('runtime/src/fs/hash.js');
const {taskContractHash, goalHash} = await load('runtime/src/task/contract.js');
const {FileEvidenceStore, buildVerificationEvidence} = await load('runtime/src/verify/evidence.js');
const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js');
const {resolveReviewScope} = await load('runtime/src/review/scope.js');
const {saveReviewAttestation, saveReviewReportArtifact, reviewReportDigest} = await load('runtime/src/review/attestation.js');
const {addWorktree} = await load('runtime/src/parallel/service.js');
const {prepareFinishReceipt} = await load('runtime/src/parallel/receipt.js');
const {finishWorktree} = await load('runtime/src/parallel/finish.js');
const criteria = [{id: 'behavior', description: 'Requested behavior holds', verifierIds: ['node-test']},
  {id: 'regression', description: 'Existing behavior holds', verifierIds: ['node-test']}];

async function narrowChild(f, check) {
  const {record} = await addWorktree(f.deps, {cwd: f.root, name: 'proof-tree', sessionId: 'session-proof-tree'});
  await writeFile(join(record.path, 'source.txt'), 'parent change\n');
  await checkedGit(record.path, ['add', '.']); await checkedGit(record.path, ['commit', '-qm', 'parent']);
  const middle = await checkedGit(record.path, ['rev-parse', 'HEAD']);
  await writeFile(join(record.path, 'child.txt'), 'child change\n');
  await checkedGit(record.path, ['add', '.']); await checkedGit(record.path, ['commit', '-qm', 'child']);
  const head = await checkedGit(record.path, ['rev-parse', 'HEAD']);
  const tasks = f.deps.tasks(record.path);
  const parent = await tasks.create({title: 'Parent', criteria, policyConfigHash: calculateConfigHash(config), sessionId: record.sessionId});
  const child = await tasks.create({title: 'Child', criteria, policyConfigHash: calculateConfigHash(config), parentTaskId: parent.task.id});
  const prove = async (task, base) => {
    const scope = await resolveReviewScope({root: record.path, runner: runner(record.path), base});
    const fingerprint = await calculateSourceFingerprint(record.path, scope, runner(record.path));
    const report = {summary: 'Fixture product review', results: task.criteria.map(c => ({criterionId: c.id, status: 'PASS',
      summary: 'Reviewed fixture source', evidence: ['source.txt:1']})), findings: [], residualRisks: [],
      changedFilesInspected: scope.changedFiles, supportingFilesInspected: []};
    const sessions = ['primary-' + task.id, 'adversarial-' + task.id];
    const result = {status: 'PASS', harness: 'codex', plannedTargets: ['codex', 'codex'], sessionIsolation: 'fresh',
      attempts: sessions.map(sessionId => ({target: 'codex', status: 'PASS', sessionId})), preflight: [], report,
      adversarial: {target: 'codex', refuted: false, report}};
    const binding = {taskContractHash: taskContractHash(task), taskContracts: {[task.id]: taskContractHash(task)},
      goalHash: goalHash(task), candidateCommit: head, coverageDigest: sha256('fixture coverage')};
    const artifact = await saveReviewReportArtifact(record.path, result, fingerprint, task.id, undefined, binding);
    await saveReviewAttestation(record.path, {schemaVersion: 3, ...binding, taskId: task.id, harness: 'codex', status: 'PASS',
      sourceFingerprint: fingerprint, reviewTargets: ['codex', 'codex'], reviewSessionIds: sessions, sessionIsolation: 'fresh',
      primaryReportDigest: reviewReportDigest(report), adversarialReportDigest: reviewReportDigest(report),
      reportArtifact: artifact, createdAt: '2026-11-08T00:00:02Z'});
    const evidence = new FileEvidenceStore(record.path, record.path), references = {};
    for (const c of task.criteria) references[c.id] = [await evidence.save(buildVerificationEvidence({taskId: task.id,
      criterionId: c.id, taskContractHash: taskContractHash(task), command: config.verification.commands[0], scope: 'project',
      startedAt: '2026-11-08T00:00:00Z', finishedAt: '2026-11-08T00:00:01Z', exitCode: 0, testCount: 1,
      status: 'PASS', failureClass: 'none', sourceFingerprint: fingerprint, toolVersions: {}, config}))];
    await tasks.recordEvidence(task.id, references, base);
    return fingerprint;
  };
  const fingerprint = await prove(parent.task, record.base);
  await prove(child.task, middle);
  const options = async () => ({commonDir: f.commonDir, record, candidateHead: head, targetCommit: record.base,
    expectedFingerprint: fingerprint, tasks: await tasks.list(), children: [], config, gitRunner: runner(record.path)});
  await check({record, head, parent, child, tasks, prove, options});
}

const surface = {axes: Object.fromEntries(['dependents', 'duplicates', 'otherPaths', 'sharedState'].map(k => [k, {na: 'Fixture scope'}])),
  included: [{id: 'source', path: 'source.txt', behavior: 'Fixture behavior'}], excluded: [], unknown: [], contracts: [], valueChanges: [],
  scenarios: Object.fromEntries(['initialState', 'redo', 'timeBoundary', 'identitySwitch', 'concurrency'].map(k => [k, {na: 'Fixture scenario'}]))};
async function parentFixture(f, check) {
  const base = await checkedGit(f.root, ['rev-parse', 'HEAD']);
  const debugConfig = {...config, verification: {...config.verification, acceptanceRunners: [
    {id: 'fixture', command: 'node', args: ['check.mjs'], cwd: '.', adapter: 'generic'}]}};
  const tasks = new TaskService(new FileTaskStore(join(f.root, '.agent-ops/tasks/state.json'), f.root),
    {completion: {root: f.root, gitRunner: runner(f.root), loadConfig: async () => debugConfig}});
  const parent = await tasks.create({title: 'Parent', goal: 'Original goal', sessionId: 'session-parent', requireSurface: true, surface,
    policyConfigHash: calculateConfigHash(debugConfig), debug: {facts: ['Known fixture regression']}, criteria: [
      {id: 'behavior', description: 'Regression', verifierIds: [], acceptance: {mode: 'behavioral', baselineCommit: base,
        bindings: [{runnerId: 'fixture', materials: [{path: 'source.txt', role: 'test'}], checkIds: ['regression'], redCheckIds: ['regression']}]}},
      criteria[1]]});
  const child = {title: 'Child', criteria, sessionId: 'session-parent', requireSurface: true, surface: {covers: ['source']},
    policyConfigHash: calculateConfigHash(debugConfig)};
  await check({tasks, parent, child});
}

export const operationalChecks = {
  'operational-receipt-tree': () => withRepository(f => narrowChild(f, async ({record, parent, child, tasks, prove, options}) => {
    await assert.rejects(prepareFinishReceipt(await options()), e => e.code === 'WORKTREE_FINAL_EVIDENCE_MISSING');
    assert.equal(await checkedGit(f.root, ['rev-parse', 'HEAD']), record.base, 'No target movement without final proof');
    await prove(child.task, record.base);
    const full = await prepareFinishReceipt(await options());
    assert.deepEqual(full.receipt.tasks.map(r => r.task.id), [parent.task.id, child.task.id]);
    assert.deepEqual(Object.keys(full.receipt.reviews).sort(), [parent.task.id, child.task.id].sort());
    await writeFile(join(record.path, 'late.txt'), 'later source\n');
    await checkedGit(record.path, ['add', 'late.txt']); await checkedGit(record.path, ['commit', '-qm', 'late source']);
    await assert.rejects(prepareFinishReceipt(await options()), e => e.code === 'WORKTREE_FINAL_SOURCE_CHANGED');
    const changedBase = {...await options(), targetCommit: await checkedGit(record.path, ['rev-parse', 'HEAD~1'])};
    await assert.rejects(prepareFinishReceipt(changedBase));
    assert.equal(await checkedGit(f.root, ['rev-parse', 'HEAD']), record.base);
    assert.ok((await tasks.list()).every(r => r.status === 'active'));
  })),
  'operational-plain-finish-bases': () => withRepository(f => narrowChild(f, async ({head, parent, child}) => {
    const result = await finishWorktree(f.deps, {cwd: f.root, name: 'proof-tree'});
    assert.deepEqual(result.taskIds, [parent.task.id, child.task.id]);
    assert.equal(await checkedGit(f.root, ['rev-parse', 'HEAD']), head);
  })),
  'operational-parent-goal': () => withRepository(f => parentFixture(f, async ({tasks, child}) => {
    await assert.rejects(tasks.create({...child, goal: 'Different goal'}), e => e.code === 'TASK_GOAL_IMMUTABLE');
  })),
  'operational-parent-debug': () => withRepository(f => parentFixture(f, async ({tasks, parent, child}) => {
    const created = await tasks.create(child);
    assert.equal(created.task.goal, parent.task.goal);
    assert.deepEqual(created.task.debug, parent.task.debug);
  })),
  'operational-parent-surface': () => withRepository(f => parentFixture(f, async ({tasks, child}) => {
    await assert.rejects(tasks.create({...child, surface}), e => e.code === 'SURFACE_MISSING');
    assert.deepEqual((await tasks.create(child)).task.surface, child.surface);
  })),
  'operational-escape-common-dir': () => withRepository(async f => {
    const {buildEscapesReport} = await load('packages/cli/src/commands/escapes.js');
    const {localStatePaths} = await load('runtime/src/security/permissions.js');
    const {appendLocalLog} = await load('runtime/src/logging/local-log.js');
    const {record} = await addWorktree(f.deps, {cwd: f.root, name: 'escape-view', sessionId: 'session-escape-view'});
    await mkdir(join(record.path, '.agent-ops/tasks'), {recursive: true});
    await writeFile(join(record.path, '.agent-ops/tasks/state.json'), JSON.stringify({tasks: [{task: {id: 'task-current'}}]}));
    await mkdir(join(f.commonDir, 'agent-ops/receipts'), {recursive: true});
    await writeFile(join(f.commonDir, 'agent-ops/receipts/fixture.json'), JSON.stringify({tasks: [{task: {id: 'task-delivered'}}]}));
    const home = join(f.root, 'log-home'); await mkdir(home);
    const paths = localStatePaths(home);
    for (const taskId of ['task-current', 'task-delivered', 'task-foreign']) await appendLocalLog(join(paths.logDirectory, 'events.ndjson'),
      {type: 'gate-catch', code: 'REVIEW_FAIL', taskId}, {anchorDirectory: paths.anchorDirectory});
    const report = await buildEscapesReport(record.path, home);
    assert.equal(report.catches.n, 2, 'Linked worktree must retain delivered repository catches');
  }),
  'operational-replay-isolation': () => withRepository(async f => {
    const {replayAcceptance} = await load('runtime/src/verify/acceptance-replay.js');
    const base = await checkedGit(f.root, ['rev-parse', 'HEAD']);
    const seen = [], prior = process.env.AGENT_OPS_ACCEPTANCE_CHECKS;
    process.env.AGENT_OPS_ACCEPTANCE_CHECKS = 'injected';
    try {
      await replayAcceptance({root: f.root, scope: 'project', sourceFingerprint: 'a'.repeat(64), trusted: true,
        evidenceStore: new FileEvidenceStore(f.root, f.root), gitRunner: runner(f.root),
        config: {...config, verification: {commands: [], acceptanceRunners: [{id: 'fixture', command: process.execPath,
          args: ['source.txt'], cwd: '.', adapter: 'generic'}]}}, task: {schemaVersion: 2, id: 'task-replay', title: 'Scoped replay',
          criteria: [{id: 'scope', description: 'Fixed checks', verifierIds: [], acceptance: {mode: 'invariant', baselineCommit: base,
            bindings: [{runnerId: 'fixture', materials: [{path: 'source.txt', role: 'test'}], checkIds: ['one', 'two']}]}}]},
        processRunner: {start: request => {seen.push(request); return {pid: 123, stdout: (async function* () {})(), stderr: (async function* () {})(),
          completion: Promise.resolve({exitCode: 1, signal: null}), terminateTree: async () => {}};}}});
    } finally {if (prior === undefined) delete process.env.AGENT_OPS_ACCEPTANCE_CHECKS; else process.env.AGENT_OPS_ACCEPTANCE_CHECKS = prior;}
    assert.equal(seen.length, 2); assert.notEqual(seen[0].cwd, seen[1].cwd);
    assert.deepEqual(seen.map(r => r.env.AGENT_OPS_ACCEPTANCE_CHECKS), ['one,two', 'one,two']);
    assert.deepEqual(seen.map(r => r.env.AGENT_OPS_ACCEPTANCE_PHASE), ['baseline', 'candidate']);
    assert.notEqual(seen[0].env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID, seen[1].env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID);
    for (const r of seen) {assert.equal(r.replaceEnv, true); await assert.rejects(stat(r.cwd), {code: 'ENOENT'});}
  }),
  'operational-authorization-boundary': () => withRepository(async f => {
    const {FileRunRepository, createRunState} = await load('runtime/src/run/service.js');
    const {bindRunPolicy} = await load('runtime/src/run/policy.js');
    const {RunControlService} = await load('runtime/src/run/controls.js');
    const repository = new FileRunRepository(join(f.commonDir, 'agent-ops/runs'), f.commonDir);
    const state = createRunState({root: f.root, commonDir: f.commonDir, targetBranch: 'main', goal: 'Observation boundary', host: 'claude', ownerSessionId: 'owner'});
    await repository.create(state);
    await bindRunPolicy(repository, state.runId, {config, runtimeHash: 'b'.repeat(64), baseTrustBinding: {canonicalPath: f.root,
      remoteIdentity: 'local:fixture', configHash: calculateConfigHash(config), runtimeHash: 'a'.repeat(64)}});
    await repository.mutate(state.runId, s => ({...s, workers: [{workerId: 'writer', taskId: 'task', host: 'claude', ownerSessionId: 'owner',
      nativeSessionId: 'native', nativeJobId: 'thread', worktree: f.root, processId: null, processIdentity: null, generation: 1,
      status: 'running', leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: 'active', lastFailure: null}],
      events: Array.from({length: 2000}, (_, i) => ({id: 'critical-' + i, at: new Date().toISOString(), type: 'diagnostic', code: 'CRITICAL_FIXTURE'}))}));
    const before = await repository.read(state.runId), policy = before.policyBinding;
    const authorization = {authorizationId: 'observation', workerId: 'writer', generation: 1, nativeSessionId: 'native',
      source: 'claude-auto-mode', result: 'unknown', operation: 'Bash', command: 'echo harmless', resource: 'fixture', reason: 'Observed scope only',
      commandDigest: sha256('echo harmless'), resourceDigest: sha256('fixture'), policyConfigHash: policy.configHash,
      runtimeHash: policy.runtimeHash, policyArtifactDigest: policy.artifactDigest, expiresAt: policy.expiresAt};
    const controls = new RunControlService(repository);
    await assert.rejects(controls.recordAuthorization(state.runId, {...authorization, generation: 2}), e => e.code === 'RUN_AUTHORIZATION_STALE');
    await assert.rejects(controls.recordAuthorization(state.runId, {...authorization, runtimeHash: 'c'.repeat(64)}), e => e.code === 'RUN_AUTHORIZATION_STALE');
    await controls.recordAuthorization(state.runId, authorization);
    await controls.recordAuthorization(state.runId, {...authorization, authorizationId: 'repeat'});
    const after = await repository.read(state.runId);
    assert.equal(after.revision, before.revision, 'Unknown observations cannot rewrite an already full critical-event ledger');
    assert.deepEqual(after.events, before.events);
    assert.ok(after.events.length <= 2000);
  })
};
