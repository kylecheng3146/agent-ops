import assert from 'node:assert/strict';
import {execFile as execute} from 'node:child_process';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const execFile = promisify(execute);
const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
export const moduleUrl = path => pathToFileURL(join(build, path)).href;
export const load = path => import(moduleUrl(path));
export async function followupModules() {
  try {
    return {...await load('runtime/src/followup/intake.js'), ...await load('runtime/src/followup/store.js'),
      ...await load('runtime/src/followup/receipt.js')};
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') assert.fail('The followup intake and lifecycle implementation must exist');
    throw error;
  }
}

export const config = {schemaVersion: 3, profiles: ['core', 'loop'],
  verification: {commands: [{id: 'node-test', command: 'node', args: ['--test'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}]},
  features: {completionGate: {enabled: false}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};

export async function git(cwd, args) {
  try { const result = await execFile('git', args, {cwd, encoding: 'utf8'}); return {exitCode: 0, ...result}; }
  catch (error) {return {exitCode: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? ''};}
}
export const runner = cwd => ({run: async args => {const r = await git(cwd, args); return {...r, stdout: Buffer.from(r.stdout)};}});
export async function checkedGit(cwd, args) {
  const result = await git(cwd, args);
  if (result.exitCode !== 0) throw new Error(`Fixture git failed: ${result.stderr}`);
  return result.stdout.trim();
}
export const finding = {severity: 'minor', blocking: false, title: 'Retained concrete finding',
  details: 'A specifically located risk needs current-source revalidation.', locations: [{path: 'source.txt', line: 1}],
  evidence: ['The reviewed source retains the unsafe branch.'], recommendation: 'Revalidate the branch before repair.', criterionIds: ['behavior']};

export async function withRepository(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-followup-')));
  try {
    await checkedGit(root, ['init', '-q', '-b', 'main']);
    await checkedGit(root, ['config', 'user.name', 'Followup fixture']);
    await checkedGit(root, ['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n.worktrees/\n');
    await writeFile(join(root, 'source.txt'), 'baseline\n');
    await checkedGit(root, ['add', '.']); await checkedGit(root, ['commit', '-qm', 'baseline']);
    await mkdir(join(root, '.agent-ops'));
    await writeFile(join(root, '.agent-ops/config.json'), JSON.stringify(config));
    const commonDir = join(root, '.git');
    const {TaskService} = await load('runtime/src/task/service.js');
    const {FileTaskStore} = await load('runtime/src/task/store.js');
    const {CompletionGateService} = await load('runtime/src/hooks/completion-gate.js');
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js');
    const deps = {git, loadConfig: async () => config, trust: {status: async () => 'TRUSTED', grant: async () => {}, revoke: async () => {}},
      runSetup: async () => ({exitCode: 0, output: ''}),
      tasks: (cwd, base) => new TaskService(new FileTaskStore(join(cwd, '.agent-ops/tasks/state.json'), cwd),
        base === undefined ? {} : {completion: {root: cwd, base, config, loadConfig: async () => config, gitRunner: runner(cwd)}}),
      gate: async cwd => new CompletionGateService({root: cwd, config, gitRunner: runner(cwd),
        taskService: new TaskService(new FileTaskStore(join(cwd, '.agent-ops/tasks/state.json'), cwd)), evidenceStore: new FileEvidenceStore(cwd, cwd)})};
    await check({root, commonDir, deps, git, source: {git, mainRoot: root, commonDir}});
  } finally {await rm(root, {recursive: true, force: true});}
}

/** A real clean worktree, task proof and two fresh sealed review sessions. */
export async function reviewedCandidate(fixture, {name = 'candidate', modern = false, tree = false} = {}) {
  const {root, commonDir, deps} = fixture;
  const {addWorktree} = await load('runtime/src/parallel/service.js');
  const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js');
  const {resolveReviewScope} = await load('runtime/src/review/scope.js');
  const {calculateConfigHash} = await load('runtime/src/config/hash.js');
  const {FileEvidenceStore, buildVerificationEvidence} = await load('runtime/src/verify/evidence.js');
  const {saveReviewAttestation, saveReviewReportArtifact, reviewReportDigest} = await load('runtime/src/review/attestation.js');
  const {taskContractHash, goalHash, treeContractHash} = await load('runtime/src/task/contract.js');
  const {sha256} = await load('runtime/src/fs/hash.js');
  const {prepareFinishReceipt} = await load('runtime/src/parallel/receipt.js');
  const {record} = await addWorktree(deps, {cwd: root, name, sessionId: `session-${name}`});
  await writeFile(join(record.path, 'source.txt'), `${name} candidate\n`);
  await checkedGit(record.path, ['add', 'source.txt']); await checkedGit(record.path, ['commit', '-qm', name]);
  const head = await checkedGit(record.path, ['rev-parse', 'HEAD']);
  const fingerprint = await calculateSourceFingerprint(record.path, await resolveReviewScope({root: record.path, runner: runner(record.path), base: record.base}), runner(record.path));
  const tasks = deps.tasks(record.path);
  const first = await tasks.create({title: 'Review source risk', policyConfigHash: calculateConfigHash(config), sessionId: record.sessionId,
    criteria: [{id: 'behavior', description: 'The requested behavior holds.', verifierIds: ['node-test']}, {id: 'regression', description: 'Existing behavior holds.', verifierIds: ['node-test']}]});
  const records = [first];
  if (tree) records.push(await tasks.create({title: 'Child source risk', parentTaskId: first.task.id, policyConfigHash: calculateConfigHash(config),
    criteria: first.task.criteria}));
  const ids = records.flatMap(r => r.task.criteria.map(c => tree ? `${r.task.id}:${c.id}` : c.id));
  const report = {summary: 'Current reviewed candidate with a concrete nonblocking finding.',
    results: ids.map(criterionId => ({criterionId, status: 'PASS', summary: 'Reviewed current source', evidence: ['source.txt:1']})),
    findings: [{...finding, criterionIds: [ids[0]]}], residualRisks: ['Text-only deployment uncertainty.'],
    changedFilesInspected: ['source.txt'], supportingFilesInspected: []};
  const second = {...report, summary: 'Independent adversarial recheck.', findings: []};
  const result = {status: 'PASS', harness: 'agy', plannedTargets: ['agy', 'agy'], sessionIsolation: 'fresh',
    attempts: [{target: 'agy', status: 'PASS', sessionId: 'first-fresh-session'}, {target: 'agy', status: 'PASS', sessionId: 'second-fresh-session'}],
    preflight: [], report, adversarial: {target: 'agy', refuted: false, report: second}};
  const scope = tree ? {rootTaskId: first.task.id, taskIds: records.map(r => r.task.id), criterionIds: ids} : undefined;
  for (const r of records) {
    const references = {};
    const evidence = new FileEvidenceStore(record.path, record.path);
    for (const c of r.task.criteria) {
      const base = {taskId: r.task.id, criterionId: c.id, command: config.verification.commands[0], scope: 'project',
        startedAt: '2026-10-23T00:00:00Z', finishedAt: '2026-10-23T00:00:01Z', testCount: null, toolVersions: {}, config};
      references[c.id] = [
        await evidence.save(buildVerificationEvidence({...base, exitCode: 1, status: 'FAIL', failureClass: 'nonzero-exit', sourceFingerprint: '0'.repeat(64)})),
        await evidence.save(buildVerificationEvidence({...base, exitCode: 0, status: 'PASS', failureClass: 'none', sourceFingerprint: fingerprint}))
      ];
    }
    const binding = !modern ? undefined : {taskContractHash: taskContractHash(r.task), taskContracts: Object.fromEntries(records.map(r => [r.task.id, taskContractHash(r.task)])),
      goalHash: goalHash(first.task), candidateCommit: head, coverageDigest: sha256('fixture coverage'), ...(tree ? {treeContractHash: treeContractHash(records.map(r => r.task))} : {})};
    const reportArtifact = await saveReviewReportArtifact(record.path, result, fingerprint, r.task.id, scope, binding);
    await saveReviewAttestation(record.path, {schemaVersion: modern ? 3 : 2, ...binding, taskId: r.task.id, ...(tree ? {tree: scope} : {}),
      harness: 'agy', status: 'PASS', sourceFingerprint: fingerprint, reviewTargets: ['agy', 'agy'],
      reviewSessionIds: ['first-fresh-session', 'second-fresh-session'], sessionIsolation: 'fresh',
      primaryReportDigest: reviewReportDigest(report), adversarialReportDigest: reviewReportDigest(second), reportArtifact, createdAt: '2026-10-23T00:00:02Z'});
    await tasks.recordEvidence(r.task.id, references, record.base);
  }
  const receiptOptions = {commonDir, record, candidateHead: head, targetCommit: record.base, expectedFingerprint: fingerprint,
    tasks: await tasks.list(), children: [], config, gitRunner: runner(record.path)};
  return {record, head, fingerprint, records, receiptOptions, prepare: () => prepareFinishReceipt(receiptOptions),
    finalProof: {target: record.base, head, sourceFingerprint: fingerprint, children: []}};
}

export async function rewriteReceipt(path, fixture, change, {rebind = true} = {}) {
  const {sha256} = await load('runtime/src/fs/hash.js');
  const receipt = JSON.parse(await readFile(path, 'utf8'));
  await change(receipt);
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(path, content);
  if (rebind) await checkedGit(fixture.root, ['notes', '--ref=agent-ops', 'add', '-f', '-m',
    `session: ${receipt.sessionId}\nreceipt: ${path}\nreceipt-sha256: ${sha256(content)}`, receipt.candidateHead]);
  return receipt;
}

export async function sealNativeCandidate(fixture, candidate) {
  const {createRunState, FileRunRepository} = await load('runtime/src/run/service.js');
  const {writeWorktreeRecord} = await load('runtime/src/parallel/service.js');
  const {prepareRunIntegration} = await load('runtime/src/run/integration.js');
  const {root, commonDir} = fixture;
  const session = candidate.record.sessionId;
  const state = createRunState({root, commonDir, targetBranch: 'main', goal: 'Deliver the reviewed candidate', host: 'codex', ownerSessionId: session});
  const repository = new FileRunRepository(join(commonDir, 'agent-ops/runs'), commonDir);
  await repository.create(state);
  const record = {...candidate.record, runId: state.runId, coordinatorId: state.coordinatorId, workerId: state.coordinatorId,
    ownerSessionId: session, workerGeneration: 1};
  await writeWorktreeRecord(record);
  await repository.mutate(state.runId, s => ({...s, workers: [{workerId: state.coordinatorId, taskId: candidate.records[0].task.id,
    host: 'codex', ownerSessionId: session, nativeSessionId: null, nativeJobId: null, worktree: record.path,
    processId: null, processIdentity: null, generation: 1, status: 'stopped', leaseExpiresAt: null, heartbeatAt: null,
    stopIntent: null, nativeGoalState: 'inactive', lastFailure: null}]}));
  await prepareRunIntegration(commonDir, record, candidate.finalProof);
  return {record, repository, state};
}
