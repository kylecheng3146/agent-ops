import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const mod = path => import(pathToFileURL(join(resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist'), path)).href);
const config = {schemaVersion: 3, profiles: ['core'], verification: {commands: []},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};
const quota = 'Automatic approval review failed: You’ve hit your usage limit. Try again later.';
const diagnostic = 'Native authorization could not be accepted; no alternate permission path is allowed.';

async function fixture(check, reason = quota, source = 'codex-auto-review') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-approval-retry-')));
  try {
    const {createRunState, FileRunRepository, RunService} = await mod('runtime/src/run/service.js');
    const {RunControlService} = await mod('runtime/src/run/controls.js');
    const {bindRunPolicy} = await mod('runtime/src/run/policy.js');
    const {calculateConfigHash} = await mod('runtime/src/config/hash.js');
    const {sha256} = await mod('runtime/src/fs/hash.js');
    const common = join(root, '.git'), repository = new FileRunRepository(join(common, 'agent-ops/runs'), common);
    const state = createRunState({root, commonDir: common, targetBranch: 'main', host: 'codex', goal: 'Resume the original work', ownerSessionId: 'owner'});
    await repository.create(state);
    await bindRunPolicy(repository, state.runId, {config, runtimeHash: 'b'.repeat(64),
      baseTrustBinding: {canonicalPath: root, remoteIdentity: 'local:fixture', configHash: calculateConfigHash(config), runtimeHash: 'a'.repeat(64)}});
    await repository.mutate(state.runId, s => ({...s, workers: [{workerId: 'writer', taskId: 'task', host: 'codex', ownerSessionId: 'owner',
      nativeSessionId: 'native', nativeJobId: 'thread', worktree: root, processId: null, processIdentity: null, generation: 1,
      status: 'stopped', leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: 'inactive', lastFailure: null}]}));
    const bound = await repository.read(state.runId), controls = new RunControlService(repository);
    await assert.rejects(controls.recordAuthorization(state.runId, {authorizationId: 'review-failure', workerId: 'writer', generation: 1,
      nativeSessionId: 'native', operation: 'command', command: 'npm test', resource: '{}', commandDigest: sha256('npm test'),
      resourceDigest: sha256('{}'), reason, result: 'denied', source, expiresAt: bound.policyBinding.expiresAt,
      policyConfigHash: bound.policyBinding.configHash, runtimeHash: bound.policyBinding.runtimeHash, policyArtifactDigest: bound.policyBinding.artifactDigest}),
    {code: 'RUN_COMMAND_DENIED'});
    const denied = (await repository.read(state.runId)).events.at(-1), ref = JSON.parse(denied.detail);
    await repository.appendEvent(state.runId, {type: 'diagnostic', code: 'RUN_COMMAND_DENIED', workerId: 'writer', taskId: null, detail: diagnostic});
    await repository.mutate(state.runId, s => ({...s, status: 'budget-limited', disableRestart: true,
      budget: {...s.budget, accumulatedMs: 100, activeIntervals: [{startMs: 0, endMs: 100}]}}));
    await check({root, state, repository, service: new RunService(repository), denied, ref, sha256});
  } finally {await rm(root, {recursive: true, force: true});}
}

export const resumeAuthorizationChecks = {
  'run-approval-quota-resume': () => fixture(async f => {
    const before = await f.repository.read(f.state.runId), original = await readFile(f.ref.artifact, 'utf8');
    await assert.rejects(f.service.resume(f.state.runId), {code: 'RUN_NOT_RESUMABLE'}, 'An ordinary resume cannot acknowledge a denied review');
    let result;
    try {result = await f.service.resume(f.state.runId, f.denied.id);}
    catch (error) {assert.fail(`Explicit retry of a proven failed approval review must resume the original run: ${error.code}`);}
    assert.equal(result.state.status, 'active');
    assert.equal(result.state.runId, before.runId);
    assert.equal(result.state.goalHash, before.goalHash);
    assert.deepEqual(result.state.budget, before.budget);
    assert.deepEqual(result.state.events, before.events, 'Original denial evidence cannot be rewritten');
    assert.equal(await readFile(f.ref.artifact, 'utf8'), original);
    assert.equal(result.state.controls.at(-1).reason, `retry-approval:${f.denied.id}`);
    assert.equal(result.state.workers[0].status, 'stopped', 'Resume is not permission to execute a denied command');
    assert.ok(result.state.events.every(e => e.code !== 'RUN_COMMAND_AUTO_APPROVED'));
    const {parseArgs} = await mod('packages/cli/src/args.js');
    const {runRunCommand} = await mod('packages/cli/src/commands/run.js');
    const args = parseArgs(['run', 'resume', before.runId, '--retry-approval', f.denied.id, '--json']);
    const command = await runRunCommand({args, service: f.service, root: f.root, commonDir: before.commonDir,
      targetBranch: 'main', ownerSessionId: 'owner'});
    assert.equal(command.code, 'RUN_RESUMED', 'CLI must forward the targeted retry to the real service');
    assert.throws(() => parseArgs(['run', 'status', before.runId, '--retry-approval', f.denied.id]));
    assert.throws(() => parseArgs(['run', 'resume', before.runId, '--retry-approval', '../foreign']));
    await assert.rejects(f.service.resume(before.runId), {code: 'RUN_NOT_RESUMABLE'}, 'Acknowledgement never becomes a permanent permission grant');
  }),
  'run-approval-denial-boundary': async () => {
    for (const [reason, source] of [['Organization policy denied this command', 'codex-auto-review'],
      ['Quota mentioned by a policy reviewer, but this operation is denied', 'codex-auto-review'],
      [quota, 'claude-auto-mode'], [quota, 'user']]) await fixture(async f => {
      await assert.rejects(f.service.resume(f.state.runId, f.denied.id));
      assert.equal((await f.repository.read(f.state.runId)).disableRestart, true);
    }, reason, source);
    for (const mode of ['missing', 'tamper', 'path', 'digest', 'foreign-run', 'future-generation', 'session', 'extra-denial', 'unpaired', 'budget', 'no-progress']) await fixture(async f => {
      if (mode === 'missing') await rm(f.ref.artifact);
      if (mode === 'tamper') await writeFile(f.ref.artifact, '{}');
      if (['foreign-run', 'future-generation', 'session'].includes(mode)) {
        const a = JSON.parse(await readFile(f.ref.artifact, 'utf8'));
        if (mode === 'foreign-run') a.runId = 'run-foreign';
        if (mode === 'future-generation') a.generation = 2;
        if (mode === 'session') a.nativeSessionId = 'foreign';
        const content = JSON.stringify(a); await writeFile(f.ref.artifact, content);
        await f.repository.mutate(f.state.runId, s => ({...s, events: s.events.map(e => e.id === f.denied.id
          ? {...e, detail: JSON.stringify({...f.ref, digest: f.sha256(content)})} : e)}));
      }
      if (mode === 'path' || mode === 'digest') await f.repository.mutate(f.state.runId, s => ({...s,
        events: s.events.map(e => e.id === f.denied.id ? {...e, detail: JSON.stringify({...f.ref,
          ...(mode === 'path' ? {artifact: join(f.root, 'foreign.json')} : {digest: 'f'.repeat(64)})})} : e)}));
      if (mode === 'extra-denial' || mode === 'unpaired') await f.repository.appendEvent(f.state.runId, {type: mode === 'extra-denial' ? 'control' : 'diagnostic',
        code: 'RUN_COMMAND_DENIED', workerId: 'writer', taskId: 'task', detail: 'Another explicit denial must remain blocking'});
      if (mode === 'budget') await f.repository.mutate(f.state.runId, s => ({...s, budget: {...s.budget, activeIntervals: [{startMs: 0, endMs: s.budget.limitMs}]}}));
      if (mode === 'no-progress') await f.repository.mutate(f.state.runId, s => ({...s, coordinatorId: s.coordinatorId,
        workers: [...s.workers, {...s.workers[0], workerId: s.coordinatorId, status: 'blocked', lastFailure: {id: 'failure', checkId: null,
          pinId: null, failureClass: 'assertion', fingerprint: null, diagnosticDigest: null, round: 2, observedAt: s.updatedAt, usefulProgress: false}}]}));
      await assert.rejects(f.service.resume(f.state.runId, f.denied.id), `Unsafe ${mode} recovery must fail closed`);
      assert.equal((await f.repository.read(f.state.runId)).disableRestart, true);
    });
  }
};
