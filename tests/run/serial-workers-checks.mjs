import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const load = path => import(pathToFileURL(join(resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist'), path)).href);

async function waitingCoordinator(jobs) {
  const {createRunState, FileRunRepository, RunService} = await load('runtime/src/run/service.js');
  const {RunSupervisor} = await load('runtime/src/run/supervisor.js');
  const {RunScheduler} = await load('runtime/src/run/scheduler.js');
  const {prepareSerialSchedule, waitForChildren, recoverySkips, coordinatorWakeNote} = await load('packages/cli/src/run-entry.js');
  assert.equal(typeof waitForChildren, 'function', 'The production scheduler must let the coordinator wait instead of polling');
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-serial-'));
  try {
    const repository = new FileRunRepository(join(root, 'runs'), root);
    const state = createRunState({root, commonDir: root, goal: 'Keep the coordinator off the slot while children work', host: 'codex',
      targetBranch: 'main', ownerSessionId: 'owner', jobs});
    const task = (taskId, dependencies = []) => ({taskId, dependencies, status: 'planned', workerId: null,
      deliveryDigest: null, sourceCommit: null, blockedReason: null});
    const coordinator = {workerId: state.coordinatorId, taskId: 'root', host: 'codex', ownerSessionId: 'owner', generation: 1,
      status: 'assigned', nativeSessionId: null, nativeJobId: null, processId: null, processIdentity: null, worktree: null,
      leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: 'inactive', lastFailure: null};
    await repository.create({...state, rootTaskId: 'root', tasks: [task('root')], workers: [coordinator]});
    const live = new Set(), events = [];
    let refuseStop = false;
    const host = {host: 'codex',
      start: async input => {
        const id = 'native-' + input.workerId;
        live.add(id); events.push('start:' + input.taskId);
        assert.ok(live.size <= jobs, 'Native agents must never exceed the run slots');
        return {nativeSessionId: id, nativeJobId: 'thread-' + input.workerId, processId: null, processIdentity: null, instance: null};
      },
      inspect: async input => ({nativeGoalState: live.has(input.nativeSessionId) ? 'active' : 'inactive',
        processAlive: live.has(input.nativeSessionId), processIdentity: null, stateDigest: null}),
      stop: async input => {events.push('stop:' + input.nativeSessionId); if (!refuseStop) live.delete(input.nativeSessionId);},
      resume: async () => {}, send: async () => {}};
    const supervisor = new RunSupervisor({repository, host});
    const scheduler = new RunScheduler({repository});
    const read = async () => repository.read(state.runId);
    const saved = async () => (await read()).workers.find(w => w.workerId === coordinator.workerId);
    await supervisor.startWorker(state.runId, coordinator.workerId, 1, state.goal);
    await assert.rejects(waitForChildren(repository, supervisor, state.runId, coordinator.workerId, 1), {code: 'RUN_WAIT_NOTHING_PENDING'});
    await scheduler.addTasks(state.runId, [task('child-a'), task('child-b', ['child-a'])]);

    assert.equal(await prepareSerialSchedule(repository, supervisor, state.runId), null);
    assert.equal(live.size, 1, 'Without a wait request the planning coordinator keeps running');
    assert.equal((await saved()).status, 'running');
    assert.equal(recoverySkips(await read(), await saved()), false, 'Recovery restarts a coordinator that never waited');
    assert.equal((await scheduler.plan(state.runId)).availableSlots, jobs - 1);

    await assert.rejects(waitForChildren(repository, supervisor, state.runId, 'child-worker', 1), {code: 'RUN_COORDINATOR_REQUIRED'});
    if (jobs === 1) {
      refuseStop = true;
      await assert.rejects(waitForChildren(repository, supervisor, state.runId, coordinator.workerId, 1), {code: 'RUN_HANDOFF_PROCESS_ALIVE'});
      assert.equal(await prepareSerialSchedule(repository, supervisor, state.runId), null, 'A still-live waiting coordinator is retried, not fatal');
      assert.equal(live.size, 1, 'An unconfirmed stop must not free the slot');
      assert.equal((await saved()).nativeJobId, 'thread-' + coordinator.workerId, 'A live coordinator keeps its native thread');
      assert.equal((await scheduler.plan(state.runId)).availableSlots, 0);
      refuseStop = false;
      assert.equal(await prepareSerialSchedule(repository, supervisor, state.runId), null, 'The retry completes the wait');
    } else await waitForChildren(repository, supervisor, state.runId, coordinator.workerId, 1);
    assert.equal(live.size, 0);
    const waiting = await saved();
    assert.equal(waiting.status, 'stopped');
    assert.equal(waiting.nativeSessionId, null, 'A waiting coordinator drops its native session');
    assert.equal(waiting.nativeJobId, null, 'A waiting coordinator drops its native thread');
    assert.ok((await read()).events.some(e => e.code === 'RUN_COORDINATOR_YIELDED'));
    assert.equal((await scheduler.plan(state.runId)).availableSlots, jobs, 'A waiting coordinator cannot hold a slot');
    assert.equal(recoverySkips(await read(), waiting), true, 'Recovery leaves a waiting coordinator stopped');

    for (const id of ['child-a', 'child-b']) {
      assert.deepEqual((await scheduler.next(state.runId)).map(t => t.taskId), [id]);
      const child = await supervisor.registerWorker(state.runId, {taskId: id, ownerSessionId: 'child-owner'});
      await supervisor.startWorker(state.runId, child.workerId, 1, state.goal);
      assert.equal(await prepareSerialSchedule(repository, supervisor, state.runId), null, 'Children still pending keep the coordinator stopped');
      await supervisor.stopWorker(state.runId, child.workerId, 1, 'handoff');
      await scheduler.markDelivered(state.runId, id, 'a'.repeat(64), 'b'.repeat(40));
    }
    const recover = await prepareSerialSchedule(repository, supervisor, state.runId);
    assert.equal(recover.workerId, coordinator.workerId);
    assert.equal(recoverySkips(await read(), recover), false);
    const note = coordinatorWakeNote(await read(), recover);
    assert.match(note, /Fresh native session/u);
    assert.match(note, new RegExp(`child-a delivered ${'b'.repeat(40)}`, 'u'));
    assert.match(note, /child-b delivered/u);
    const reassigned = await supervisor.reassignWorker(state.runId, recover.workerId, recover.generation);
    assert.equal(reassigned.generation, 2);
    assert.equal(reassigned.nativeSessionId, null, 'The wake must start a fresh native session, not resume the old thread');
    await supervisor.startWorker(state.runId, reassigned.workerId, 2, note);
    assert.ok(events.indexOf('stop:native-' + coordinator.workerId) < events.indexOf('start:child-a'));
    if (jobs === 1) {
      const current = await saved();
      await repository.mutate(state.runId, s => ({...s, workers: [...s.workers,
        {...current, workerId: 'racing-child', taskId: 'racing-task', status: 'assigned', nativeSessionId: null, nativeJobId: null}]}));
      const starts = events.filter(e => e.startsWith('start:')).length;
      await assert.rejects(supervisor.startWorker(state.runId, 'racing-child', 2, state.goal), {code: 'RUN_WORKER_LIMIT'});
      assert.equal(events.filter(e => e.startsWith('start:')).length, starts, 'Atomic slot guard must run before native start');
    }
    await new RunService(repository).stop(state.runId);
    assert.equal(await prepareSerialSchedule(repository, supervisor, state.runId), null, 'User Stop cannot restart a coordinator');
  } finally {await rm(root, {recursive: true, force: true});}
}

export const serialWorkerChecks = {
  'run-serial-workers': async () => waitingCoordinator(1),
  'run-coordinator-wait-parallel': async () => waitingCoordinator(2)
};
