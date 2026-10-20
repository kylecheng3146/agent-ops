import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const mod = path => import(pathToFileURL(join(resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist'), path)).href);
const config = {schemaVersion: 3, profiles: ['core'], verification: {commands: []},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};
const clock = Date.parse('2026-01-01T00:00:00Z');

async function fixture(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-unlimited-')));
  try {
    const {FileRunRepository, createRunState, RunService} = await mod('runtime/src/run/service.js');
    const {calculateConfigHash} = await mod('runtime/src/config/hash.js');
    const repository = new FileRunRepository(join(root, 'runs'), root);
    const state = createRunState({root, commonDir: root, targetBranch: 'main', goal: 'Preserve original goal and controls',
      host: 'codex', ownerSessionId: 'owner', now: new Date(clock).toISOString()});
    await repository.create(state);
    const trust = {canonicalPath: root, remoteIdentity: 'local:fixture', configHash: calculateConfigHash(config), runtimeHash: 'a'.repeat(64)};
    await check({root, repository, state, trust, service: new RunService(repository, () => new Date(clock + 10000).toISOString())});
  } finally {await rm(root, {recursive: true, force: true});}
}

export const unlimitedPolicyChecks = {
  'run-unlimited-lifecycle': () => fixture(async ({repository, state, service}) => {
    const {RunScheduler, budgetExpired, noProgressForTwoRounds} = await mod('runtime/src/run/scheduler.js');
    assert.equal(state.budget.limitMs, null, 'New runs must have no total time cap');
    await repository.mutate(state.runId, s => ({...s, budget: {...s.budget, activeIntervals: [{startMs: clock, endMs: null}]}}));
    const observed = await new RunScheduler({repository}).refreshBudget(state.runId, clock + 10 * 86400000);
    assert.equal(observed.status, 'active');
    assert.equal(observed.budget.accumulatedMs, 10 * 86400000);
    assert.equal(budgetExpired(observed, clock + 10 * 86400000), false);
    const legacy = await repository.mutate(state.runId, s => ({...s, status: 'budget-limited', disableRestart: true,
      budget: {...s.budget, limitMs: 1000, accumulatedMs: 5000, activeIntervals: [{startMs: clock, endMs: clock + 5000}]}}));
    assert.equal((await service.status(state.runId)).budget.limitMs, 1000, 'Reading must not upgrade or awaken a legacy run');
    assert.equal(budgetExpired(legacy, clock + 10000), true, 'Old finite policy remains effective until manual resume');
    await assert.rejects(service.resume(state.runId, false), {code: 'RUN_BUDGET_EXHAUSTED'}, 'Answer-driven reconciliation cannot upgrade a finite run');
    const resumed = (await service.resume(state.runId)).state;
    assert.equal(resumed.budget.limitMs, null);
    assert.equal(resumed.budget.legacyLimitMs, 1000);
    assert.deepEqual(resumed.budget.activeIntervals, legacy.budget.activeIntervals);
    assert.equal(resumed.budget.accumulatedMs, 5000);
    assert.deepEqual(resumed.budget.usage, legacy.budget.usage);
    assert.equal(resumed.goalHash, legacy.goalHash);
    assert.ok(resumed.events.some(e => e.code === 'RUN_BUDGET_UPGRADED'));
    await service.stop(state.runId);
    assert.equal((await service.status(state.runId)).disableRestart, true);
    const round = {taskId: 'task', failureId: 'same', failureClass: 'assertion', diagnosticDigest: null, usefulProgress: false};
    assert.equal(noProgressForTwoRounds([round, round]), true, 'Unlimited run does not reset convergence');
    for (const code of ['RUN_COMMAND_DENIED', 'RUN_NO_PROGRESS_REPEAT']) {
      await repository.mutate(state.runId, s => ({...s, status: 'blocked', budget: {...legacy.budget},
        events: [{id: 'blocked', at: new Date(clock).toISOString(), type: 'diagnostic', code, workerId: null, taskId: null, detail: 'blocker'}]}));
      await assert.rejects(service.resume(state.runId), {code: 'RUN_NOT_RESUMABLE'});
      assert.equal((await repository.read(state.runId)).budget.limitMs, 1000, 'Upgrade cannot dismiss independent blockers');
    }
  }),
  'run-policy-renewal': () => fixture(async ({root, repository, state, trust, service}) => {
    const policyApi = await mod('runtime/src/run/policy.js');
    assert.equal(typeof policyApi.renewRunPolicy, 'function', 'Same-authority renewal must be an explicit checked operation');
    const {bindRunPolicy, readRunPolicy, renewRunPolicy, RUN_POLICY_TTL_MS} = policyApi;
    const {writePrivateFile, readPrivateFile} = await mod('runtime/src/security/permissions.js');
    let bound = await bindRunPolicy(repository, state.runId, {config, runtimeHash: 'b'.repeat(64), baseTrustBinding: trust, now: clock});
    const expiry = Date.parse(bound.policyBinding.expiresAt);
    assert.ok(Number.isSafeInteger(RUN_POLICY_TTL_MS) && RUN_POLICY_TTL_MS > 0 && RUN_POLICY_TTL_MS <= 86400000);
    assert.equal(expiry, clock + RUN_POLICY_TTL_MS, 'Grant TTL must be finite and independent of run duration');
    const authority = async () => ({config, baseTrustBinding: trust, trusted: true, runtimeHash: 'b'.repeat(64)});
    const renew = (extra = {}) => renewRunPolicy(repository, state.runId, {authority, now: expiry, ...extra});
    await assert.rejects(readRunPolicy(bound, 'b'.repeat(64), expiry), {code: 'RUN_POLICY_EXPIRED'});
    for (const now of [NaN, -1, clock - 1, Number.MAX_SAFE_INTEGER]) await assert.rejects(renew({now}), {code: 'RUN_CLOCK_INVALID'});
    assert.equal((await renew({now: expiry - 1})).policyBinding.artifactDigest, bound.policyBinding.artifactDigest, 'Unexpired grants do not churn');
    for (const changed of [{trusted: false}, {runtimeHash: 'c'.repeat(64)},
      {config: {...config, profiles: ['core', 'run']}}, {baseTrustBinding: {...trust, remoteIdentity: 'local:changed'}}]) {
      await assert.rejects(renew({authority: async () => ({...await authority(), ...changed})}));
      assert.equal((await repository.read(state.runId)).policyBinding.artifactDigest, bound.policyBinding.artifactDigest);
    }
    await repository.appendEvent(state.runId, {type: 'diagnostic', code: 'RUN_COMMAND_DENIED', workerId: null, taskId: null, detail: 'denied'});
    await assert.rejects(renew(), {code: 'RUN_POLICY_DISABLED'});
    await repository.mutate(state.runId, s => ({...s, events: s.events.filter(e => e.code !== 'RUN_COMMAND_DENIED')}));
    const path = join(root, 'agent-ops/runs', state.runId, 'policies', bound.policyBinding.artifactDigest + '.json');
    const content = await readPrivateFile(path, root);
    await writePrivateFile(path, content + ' ', root);
    await assert.rejects(renew(), {code: 'RUN_POLICY_CHANGED'});
    await writePrivateFile(path, content, root);
    let checks = 0;
    await assert.rejects(renew({authority: async () => ({...await authority(), trusted: ++checks === 1})}), {code: 'RUN_POLICY_AUTHORITY_CHANGED'});
    await repository.mutate(state.runId, s => ({...s, workers: [{workerId: 'writer', taskId: 'task', host: 'codex', ownerSessionId: 'owner',
      nativeSessionId: 'native', nativeJobId: 'thread', worktree: root, processId: null, processIdentity: null, generation: 1,
      status: 'running', leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: 'active', lastFailure: null}]}));
    const previousDigest = bound.policyBinding.artifactDigest;
    bound = await renew();
    assert.equal(Date.parse(bound.policyBinding.expiresAt), expiry + RUN_POLICY_TTL_MS);
    assert.equal((await readRunPolicy(bound, 'b'.repeat(64), expiry)).previousDigest, previousDigest);
    assert.ok(bound.events.some(e => e.code === 'RUN_POLICY_RENEWED'));
    assert.equal(bound.workers[0].nativeSessionId, 'native', 'Equal-authority renewal retains the active writer identity');
    assert.equal(bound.workers[0].generation, 1);
    const after = bound.policyBinding.artifactDigest;
    let calls = 0;
    await assert.rejects(renew({now: expiry + RUN_POLICY_TTL_MS, authority: async () => {
      if (++calls === 2) await service.stop(state.runId);
      return await authority();
    }}), {code: 'RUN_POLICY_STALE'});
    const stopped = await repository.read(state.runId);
    assert.equal(stopped.disableRestart, true);
    assert.equal(stopped.policyBinding.artifactDigest, after, 'Stop wins a concurrent renewal');
    await assert.rejects(renew({now: expiry + RUN_POLICY_TTL_MS}), {code: 'RUN_POLICY_DISABLED'});
  })
};
