import assert from 'node:assert/strict';
import {fixture, mod} from './acceptance-helper.mjs';

export const recoveryChecks = {
  'debug-changed-candidate-recovery': async () => {
    const f = await fixture();
    try {
      await f.candidate(2);
      f.config.verification.acceptanceRunners[0].build = [{command: process.execPath, args: ['-e', 'process.exit(2)']}];
      assert.equal((await f.verify()).status, 'UNKNOWN');
      const blocked = structuredClone((await f.tasks.debugService().root(f.record.task.id)).debug.receipts);
      f.config.verification.commands.push({id: 'unrelated', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: '.', required: false, evidence: {kind: 'exit-code'}});
      await assert.rejects(f.tasks.debugService().investigate(f.record.task.id, 'unrelated', true), {code: 'TASK_DEBUG_RECOVERY_COMMAND_REQUIRED'});
      f.config.verification.acceptanceRunners[0].build = [];
      await f.candidate(1);
      let report, error;
      try {report = await f.verify();} catch (e) {error = e;}
      assert.equal(error, undefined, 'Original verification must recover after a candidate repair');
      assert.equal(report.status, 'PASS');
      const state = (await f.tasks.debugService().root(f.record.task.id)).debug;
      assert.deepEqual(state.receipts.slice(0, blocked.length), blocked);
      assert.equal(state.receipts.at(-1).cause, null);
      assert.equal(state.receipts.at(-1).round, true);
    } finally {await f.close();}
  },
  'debug-budget-recovery-checkpoint': async () => {
    const f = await fixture();
    try {
      await f.candidate(2);
      f.config.verification.acceptanceRunners[0].build = [{command: process.execPath, args: ['-e', 'process.exit(2)']}];
      assert.equal((await f.verify()).status, 'UNKNOWN');
      await f.candidate(1);
      await f.store.mutate(state => {state.tasks[0].debug.consumedMs = state.tasks[0].debug.budgetMs;});
      const debug = f.tasks.debugService(), id = f.record.task.id;
      const {debugStopCause} = await mod('runtime/src/task/debug-state.js');
      assert.equal(debugStopCause((await debug.root(id)).debug), 'budget', 'Environment failures must not mask exhausted limits');
      await assert.rejects(f.verify(), {code: 'TASK_DEBUG_STOP_REQUIRED'});
      const checkpoint = (await debug.checkpoint(id, 'native-session')).checkpoint;
      assert.equal(checkpoint.cause, 'budget');
      assert.equal(await debug.validCheckpoint(id, 'native-session', checkpoint.sourceFingerprint), true);
      assert.equal((await f.tasks.status({taskId: id})).status, 'active');
    } finally {await f.close();}
  }
};
