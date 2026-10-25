import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const load = path => import(pathToFileURL(join(resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist'), path)).href);

async function fixture(jobs, check) {
  const {createRunState, FileRunRepository, RunService} = await load('runtime/src/run/service.js');
  const {RunSupervisor} = await load('runtime/src/run/supervisor.js');
  const {RunScheduler} = await load('runtime/src/run/scheduler.js');
  const {waitForChildren, recoverySkips} = await load('packages/cli/src/run-entry.js');
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-response-'));
  try {
    const repository = new FileRunRepository(join(root, 'runs'), root);
    const state = createRunState({root, commonDir: root, goal: 'Preserve original recovery goal', host: 'codex',
      targetBranch: 'main', ownerSessionId: 'owner', jobs});
    const coordinator = {workerId: state.coordinatorId, taskId: 'root', host: 'codex', ownerSessionId: 'owner', generation: 1,
      status: 'assigned', nativeSessionId: null, nativeJobId: null, processId: null, processIdentity: null, worktree: null,
      leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: 'inactive', lastFailure: null};
    const task = taskId => ({taskId, dependencies: [], status: 'planned', workerId: null,
      deliveryDigest: null, sourceCommit: null, blockedReason: null});
    await repository.create({...state, rootTaskId: 'root', tasks: [task('root')], workers: [coordinator]});
    const live = new Set();
    let starts = 0;
    const host = {host: 'codex', start: async input => {
      const id = 'native-' + (++starts);
      live.add(id);
      assert.ok(live.size <= jobs, 'Response cannot bypass native job slots');
      return {nativeSessionId: id, nativeJobId: id, processId: 10000 + starts, processIdentity: 'registered fixture process', instance: null};
    }, inspect: async input => ({nativeGoalState: live.has(input.nativeSessionId) ? 'active' : 'inactive',
      processAlive: live.has(input.nativeSessionId), processIdentity: null, stateDigest: null}),
    stop: async input => {live.delete(input.nativeSessionId);}, resume: async () => {}, send: async () => {}};
    const supervisor = new RunSupervisor({repository, host});
    const service = new RunService(repository);
    const scheduler = new RunScheduler({repository});
    const read = () => repository.read(state.runId);
    const saved = async () => (await read()).workers.find(w => w.workerId === state.coordinatorId);
    await supervisor.startWorker(state.runId, state.coordinatorId, 1, state.goal);
    await scheduler.addTasks(state.runId, [task('child')]);
    await waitForChildren(repository, supervisor, state.runId, state.coordinatorId, 1);
    const child = await supervisor.registerWorker(state.runId, {taskId: 'child', ownerSessionId: 'child-owner'});
    await supervisor.startWorker(state.runId, child.workerId, 1, state.goal);
    await supervisor.stopWorker(state.runId, child.workerId, 1, 'stop');
    await repository.appendEvent(state.runId, {type: 'diagnostic', code: 'RUN_CONTROLLED_STEP_FAILED', workerId: child.workerId,
      taskId: 'child', detail: 'Known shared proof-group timeout remains unresolved'});
    await repository.mutate(state.runId, s => ({...s, status: 'awaiting-input',
      questions: [{questionId: 'recovery', prompt: 'Choose supported recovery', askedAt: new Date().toISOString(), answeredAt: null, answerDigest: null}],
      currentContractHash: 'b'.repeat(64), policyBinding: {configHash: 'c'.repeat(64), runtimeHash: 'd'.repeat(64),
        artifactDigest: 'e'.repeat(64), expiresAt: '2999-01-01T00:00:00.000Z'},
      tasks: s.tasks.map(t => t.taskId === 'child' ? {...t, status: 'awaiting-delivery', sourceCommit: 'a'.repeat(40)} : t),
      workers: s.workers.map(w => w.workerId === child.workerId ? {...w, lastFailure: {id: 'failure', checkId: null, pinId: null,
        failureClass: 'infrastructure', fingerprint: null, diagnosticDigest: null, round: 1, observedAt: new Date().toISOString(), usefulProgress: false}} : w)}));
    await check({repository, state, service, supervisor, read, saved, recoverySkips, waitForChildren, live, child,
      respond: () => service.respond(state.runId, 'recovery', 'Coordinator may assess scoped recovery')});
  } finally {await rm(root, {recursive: true, force: true});}
}

async function recovery(jobs) {
  await fixture(jobs, async ({repository, state, service, supervisor, read, saved, recoverySkips, waitForChildren, live, respond}) => {
    const before = await read();
    assert.ok((await saved()).processId !== null, 'A confirmed wait retains the old process identity for history');
    assert.equal(recoverySkips(before, await saved()), true);
    await respond();
    const answered = await read();
    assert.equal(recoverySkips(answered, await saved()), false, 'Explicit answer must release the coordinator before pending children finish');
    assert.deepEqual(answered.tasks, before.tasks, 'No task, frozen source or baseline identity is replaced');
    assert.equal(answered.goal, before.goal);
    assert.deepEqual(answered.workers.filter(w => w.workerId !== state.coordinatorId), before.workers.filter(w => w.workerId !== state.coordinatorId));
    assert.deepEqual(answered.policyBinding, before.policyBinding, 'Answer grants no command policy');
    assert.deepEqual(answered.events.slice(0, before.events.length), before.events, 'Known timeout and wait history survive');
    assert.equal(answered.events.filter(e => e.code === 'RUN_COORDINATOR_RESPONSE_WAKE').length, 1);
    assert.equal(live.size, 0, 'Answer itself starts no process');
    await supervisor.stopWorker(state.runId, state.coordinatorId, 1, 'stop');
    await service.resume(state.runId);
    assert.equal(recoverySkips(await read(), await saved()), false, 'Production resume death reconciliation preserves the release');
    const next = await supervisor.reassignWorker(state.runId, state.coordinatorId, 1);
    assert.equal(next.generation, 2);
    assert.equal(next.nativeSessionId, null);
    await supervisor.startWorker(state.runId, next.workerId, 2, state.goal);
    assert.equal((await saved()).status, 'running');
    assert.equal(live.size, 1);
    if (jobs === 1) {
      const child = (await read()).workers.find(w => w.workerId !== state.coordinatorId);
      await assert.rejects(supervisor.reassignWorker(state.runId, child.workerId, 1), {code: 'RUN_WORKER_LIMIT'});
    }
    await waitForChildren(repository, supervisor, state.runId, next.workerId, 2);
    await service.resume(state.runId);
    assert.equal(recoverySkips(await read(), await saved()), true, 'A new wait is not consumed by an old response or ordinary resume');
  });
}

export const coordinatorResponseChecks = {
  'coordinator-response-recovery': async () => {await recovery(1); await recovery(2);},
  'coordinator-response-identity': async () => {
    const variants = [
      w => ({...w, status: 'running'}), w => ({...w, status: 'delivered'}), w => ({...w, status: 'blocked'}), w => ({...w, taskId: 'child'}),
      w => ({...w, nativeSessionId: 'still-registered'}), w => ({...w, nativeJobId: 'still-registered'}),
      w => ({...w, nativeGoalState: 'active'}), w => ({...w, proofProcess: {processId: 123, processIdentity: 'proof'}}),
      w => ({...w, stopIntent: null}), w => ({...w, stopIntent: {...w.stopIntent, reason: 'stop'}}),
      ...['runId', 'workerId'].map(key => w => ({...w, stopIntent: {...w.stopIntent, [key]: 'foreign'}})),
      w => ({...w, stopIntent: {...w.stopIntent, generation: w.generation - 1}}),
      ...[null, 'invalid', '2999-01-01T00:00:00.000Z'].map(confirmedDeadAt => w => ({...w, stopIntent: {...w.stopIntent, confirmedDeadAt}}))
    ];
    for (const change of variants) await fixture(1, async ({repository, state, read, respond}) => {
      await repository.mutate(state.runId, s => ({...s, workers: s.workers.map(w => w.workerId === s.coordinatorId ? change(w) : w)}));
      const before = await read();
      await respond();
      const after = await read();
      assert.deepEqual(after.workers, before.workers, 'A response must not consume a foreign, live, stale or non-wait identity');
      assert.deepEqual(after.events, before.events);
    });
  },
  'coordinator-response-guards': async () => fixture(1, async ({repository, state, service, read, respond}) => {
    const original = await read();
    await assert.rejects(service.respond(state.runId, 'unknown', 'answer'), {code: 'RUN_QUESTION_NOT_FOUND'});
    assert.deepEqual(await read(), original);
    for (const status of ['paused', 'blocked']) {
      await repository.mutate(state.runId, s => ({...s, status}));
      await assert.rejects(respond(), {code: 'RUN_NOT_AWAITING_INPUT'});
    }
    await repository.mutate(state.runId, s => ({...s, status: 'awaiting-input', disableRestart: true}));
    await assert.rejects(respond(), {code: 'RUN_NOT_AWAITING_INPUT'});
    await repository.mutate(state.runId, s => ({...s, disableRestart: false}));
    await respond();
    await assert.rejects(respond(), {code: 'RUN_NOT_AWAITING_INPUT'});
    await repository.mutate(state.runId, s => ({...s, status: 'awaiting-input'}));
    const answered = await read();
    await assert.rejects(respond(), {code: 'RUN_QUESTION_ANSWERED'});
    assert.deepEqual(await read(), answered, 'Replay cannot issue another wake or control');
    await repository.mutate(state.runId, s => ({...s, status: 'complete'}));
    await assert.rejects(respond(), {code: 'RUN_NOT_AWAITING_INPUT'});
  })
};
