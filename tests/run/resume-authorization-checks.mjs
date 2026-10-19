import assert from 'node:assert/strict';
import {mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
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
    try {result = await f.service.resume(f.state.runId, [f.denied.id]);}
    catch (error) {assert.fail(`Explicit retry of a proven failed approval review must resume the original run: ${error.code}`);}
    assert.equal(result.state.status, 'active');
    assert.equal(result.state.runId, before.runId);
    assert.equal(result.state.goalHash, before.goalHash);
    assert.deepEqual(result.state.budget, before.budget);
    assert.deepEqual(result.state.events, before.events, 'Original denial evidence cannot be rewritten');
    assert.equal(await readFile(f.ref.artifact, 'utf8'), original);
    assert.equal(result.state.controls.at(-1).reason, `retry-approval:${JSON.stringify([f.denied.id])}`);
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
    assert.throws(() => parseArgs(['run', 'resume', before.runId, '--retry-approval', f.denied.id, '--retry-approval', f.denied.id]));
    assert.equal((await f.service.resume(before.runId)).state.status, 'active', 'Prior acknowledgement is revalidated for recovery, without approving commands');
    const {bindRunPolicy} = await mod('runtime/src/run/policy.js');
    const bound = await f.repository.read(before.runId);
    await bindRunPolicy(f.repository, before.runId, {config, runtimeHash: 'c'.repeat(64), resumeRuntime: true,
      expectedDigest: bound.policyBinding.artifactDigest,
      baseTrustBinding: JSON.parse(await readFile(join(before.commonDir, 'agent-ops/runs', before.runId, 'policies', bound.policyBinding.artifactDigest + '.json'), 'utf8')).baseTrustBinding});
    await f.repository.mutate(before.runId, s => ({...s, workers: s.workers.map(w => ({...w, generation: 2, nativeSessionId: 'next-native'}))}));
    assert.equal((await f.service.resume(before.runId)).state.status, 'active', 'Acknowledged history survives a new native generation');
    await f.repository.appendEvent(before.runId, {type: 'diagnostic', code: 'RUN_COMMAND_DENIED', workerId: 'writer', taskId: 'task', detail: 'A new genuine denial'});
    await assert.rejects(f.service.resume(before.runId), {code: 'RUN_NOT_RESUMABLE'}, 'Old acknowledgement cannot erase a new denial');
  }),
  'run-approval-denial-boundary': async () => {
    for (const [reason, source] of [['Organization policy denied this command', 'codex-auto-review'],
      ['Quota mentioned by a policy reviewer, but this operation is denied', 'codex-auto-review'],
      [quota, 'claude-auto-mode'], [quota, 'user']]) await fixture(async f => {
      await assert.rejects(f.service.resume(f.state.runId, [f.denied.id]));
      assert.equal((await f.repository.read(f.state.runId)).disableRestart, true);
    }, reason, source);
    for (const mode of ['missing', 'symlink', 'tamper', 'path', 'digest', 'foreign-run', 'future-generation', 'session', 'runtime', 'expiry', 'authorization-id', 'extra-denial', 'unpaired', 'budget', 'no-progress']) await fixture(async f => {
      if (mode === 'missing') await rm(f.ref.artifact);
      if (mode === 'symlink') {const source = await readFile(f.ref.artifact); const target = join(f.root, 'foreign.json'); await writeFile(target, source); await rm(f.ref.artifact); await symlink(target, f.ref.artifact);}
      if (mode === 'tamper') await writeFile(f.ref.artifact, '{}');
      if (['foreign-run', 'future-generation', 'session', 'runtime', 'expiry', 'authorization-id'].includes(mode)) {
        const a = JSON.parse(await readFile(f.ref.artifact, 'utf8'));
        if (mode === 'foreign-run') a.runId = 'run-foreign';
        if (mode === 'future-generation') a.generation = 2;
        if (mode === 'session') a.nativeSessionId = 'foreign';
        if (mode === 'runtime') a.runtimeHash = 'c'.repeat(64);
        if (mode === 'expiry') a.expiresAt = '2099-01-01T00:00:00.000Z';
        if (mode === 'authorization-id') a.authorizationId = 'foreign';
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
      await assert.rejects(f.service.resume(f.state.runId, [f.denied.id]), `Unsafe ${mode} recovery must fail closed`);
      assert.equal((await f.repository.read(f.state.runId)).disableRestart, true);
    });
    await fixture(async f => {
      const {RunControlService} = await mod('runtime/src/run/controls.js');
      const authorization = JSON.parse(await readFile(f.ref.artifact, 'utf8'));
      await f.repository.mutate(f.state.runId, s => ({...s, status: 'active', disableRestart: false}));
      await assert.rejects(new RunControlService(f.repository).recordAuthorization(f.state.runId, {...authorization, authorizationId: 'second-review'}), {code: 'RUN_COMMAND_DENIED'});
      const second = (await f.repository.read(f.state.runId)).events.at(-1);
      await f.repository.appendEvent(f.state.runId, {type: 'diagnostic', code: 'RUN_COMMAND_DENIED', workerId: 'writer', taskId: null, detail: diagnostic});
      await f.repository.mutate(f.state.runId, s => ({...s, status: 'budget-limited', disableRestart: true}));
      await assert.rejects(f.service.resume(f.state.runId, [f.denied.id]), {code: 'RUN_NOT_RESUMABLE'});
      assert.equal((await f.repository.read(f.state.runId)).controls.length, 0, 'Partial retry must not persist any acknowledgement');
      assert.equal((await f.service.resume(f.state.runId, [f.denied.id, second.id])).state.status, 'active');
      const {parseArgs} = await mod('packages/cli/src/args.js');
      assert.deepEqual(parseArgs(['run', 'resume', f.state.runId, '--retry-approval', f.denied.id, '--retry-approval', second.id]).retryApprovalIds, [f.denied.id, second.id]);
    });
  }
};
