import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const load = path => import(pathToFileURL(join(resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist'), path)).href);

export const serialWorkerChecks = {
  'run-serial-workers': async () => {
    const {createRunState, FileRunRepository, RunService} = await load('runtime/src/run/service.js');
    const {RunSupervisor} = await load('runtime/src/run/supervisor.js');
    const {RunScheduler} = await load('runtime/src/run/scheduler.js');
    const {prepareSerialSchedule} = await load('packages/cli/src/run-entry.js');
    assert.equal(typeof prepareSerialSchedule, 'function', 'The production scheduler must yield and recover the coordinator');
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-serial-'));
    try {
      const repository = new FileRunRepository(join(root, 'runs'), root);
      const state = createRunState({root, commonDir: root, goal: 'Keep one executing native agent', host: 'codex',
        targetBranch: 'main', ownerSessionId: 'owner', jobs: 1});
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
          assert.equal(live.size, 1, 'Coordinator and child must never execute together');
          return {nativeSessionId: id, nativeJobId: 'thread', processId: null, processIdentity: null, instance: null};
        },
        inspect: async input => ({nativeGoalState: live.has(input.nativeSessionId) ? 'active' : 'inactive',
          processAlive: live.has(input.nativeSessionId), processIdentity: null, stateDigest: null}),
        stop: async input => {events.push('stop:' + input.nativeSessionId); if (!refuseStop) live.delete(input.nativeSessionId);},
        resume: async () => {}, send: async () => {}};
      const supervisor = new RunSupervisor({repository, host});
      const scheduler = new RunScheduler({repository});
      await supervisor.startWorker(state.runId, coordinator.workerId, 1, state.goal);
      await scheduler.addTasks(state.runId, [task('child-a'), task('child-b', ['child-a'])]);
      assert.equal((await scheduler.plan(state.runId)).availableSlots, 0);
      refuseStop = true;
      await assert.rejects(prepareSerialSchedule(repository, supervisor, state.runId), {code: 'RUN_HANDOFF_PROCESS_ALIVE'});
      await assert.rejects(supervisor.registerWorker(state.runId, {taskId: 'child-a', ownerSessionId: 'child-owner'}), {code: 'RUN_WORKER_LIMIT'});
      assert.equal(live.size, 1, 'An unconfirmed stop must not free the slot');
      refuseStop = false;
      await prepareSerialSchedule(repository, supervisor, state.runId);
      assert.equal(live.size, 0);
      assert.equal((await scheduler.plan(state.runId)).availableSlots, 1, 'A stopped coordinator task cannot starve children');
      for (const id of ['child-a', 'child-b']) {
        assert.deepEqual((await scheduler.next(state.runId)).map(t => t.taskId), [id]);
        const child = await supervisor.registerWorker(state.runId, {taskId: id, ownerSessionId: 'child-owner'});
        await supervisor.startWorker(state.runId, child.workerId, 1, state.goal);
        assert.equal(await prepareSerialSchedule(repository, supervisor, state.runId), null);
        await supervisor.stopWorker(state.runId, child.workerId, 1, 'handoff');
        await scheduler.markDelivered(state.runId, id, 'a'.repeat(64), 'b'.repeat(40));
      }
      const recover = await prepareSerialSchedule(repository, supervisor, state.runId);
      assert.equal(recover.workerId, coordinator.workerId);
      assert.equal(recover.taskId, 'root');
      const reassigned = await supervisor.reassignWorker(state.runId, recover.workerId, recover.generation);
      assert.equal(reassigned.generation, 2);
      await supervisor.startWorker(state.runId, reassigned.workerId, 2, state.goal);
      assert.ok(events.indexOf('stop:native-' + coordinator.workerId) < events.indexOf('start:child-a'));
      const saved = (await repository.read(state.runId)).workers.find(w => w.workerId === coordinator.workerId);
      await repository.mutate(state.runId, s => ({...s, workers: [...s.workers,
        {...saved, workerId: 'racing-child', taskId: 'racing-task', status: 'assigned', nativeSessionId: null, nativeJobId: null}]}));
      const starts = events.filter(e => e.startsWith('start:')).length;
      await assert.rejects(supervisor.startWorker(state.runId, 'racing-child', 2, state.goal), {code: 'RUN_WORKER_LIMIT'});
      assert.equal(events.filter(e => e.startsWith('start:')).length, starts, 'Atomic slot guard must run before native start');
      await new RunService(repository).stop(state.runId);
      assert.equal(await prepareSerialSchedule(repository, supervisor, state.runId), null, 'User Stop cannot restart a coordinator');
    } finally {await rm(root, {recursive: true, force: true});}
  }
};
