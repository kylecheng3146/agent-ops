// Independent QA: one learning experiment call may run up to 900 s (LEARNING_CALL_TIMEOUT_MS), not 300 s.
// Run by tests/qa/acceptance.mjs from a built checkout (dist/, or AGENT_OPS_DEBUG_TEST_BUILD).
// experiment.js is imported dynamically so a baseline without the export fails by assertion, not at collection.
import assert from 'node:assert/strict';
import {join, resolve} from 'node:path';
import {mock} from 'node:test';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const experiment = () => import(pathToFileURL(join(build, 'runtime/src/learning/experiment.js')).href);
const settings = {target: 'codex', model: 'gpt-6.2-sol', effort: 'medium'};
const flush = () => new Promise(done => setImmediate(done));
async function* empty() {}

/** Mocked setTimeout for the duration of fn only. */
async function withMockedTimers(fn) {
  mock.timers.enable({apis: ['setTimeout']});
  try {return await fn();} finally {mock.timers.reset();}
}

export const checks = {
  'learning-call-deadline-timeout-boundary': async () => {
    const m = await experiment();
    assert.equal(m.LEARNING_CALL_TIMEOUT_MS, 900_000, 'LEARNING_CALL_TIMEOUT_MS is 900 s');
    let started, finish, terminated = 0;
    const ready = new Promise(done => {started = done;});
    const runner = {start: () => {
      started();
      return {pid: 123, stdout: empty(), stderr: empty(), completion: new Promise(done => {finish = done;}),
        terminateTree: async () => {terminated++; finish({exitCode: null, signal: 'SIGTERM'});}};
    }};
    await withMockedTimers(async () => {
      const pending = m.targetLearningCall(settings, runner)('prompt', {});
      await ready; await flush();
      mock.timers.tick(300_001); await flush(); await flush();
      assert.equal(terminated, 0, 'A target still working after 300 001 ms keeps running');
      mock.timers.tick(599_999);
      const result = await pending;
      assert.equal(terminated, 1, 'The 900 000 ms deadline stops the target exactly once');
      assert.equal(result.failure, 'TARGET_FAILED');
    });
  },
  'learning-call-completes-between-300s-and-900s': async () => {
    const m = await experiment();
    let started, terminated = 0;
    const ready = new Promise(done => {started = done;});
    async function* answer() {yield Buffer.from('{}');}
    const runner = {start: () => {
      started();
      return {pid: 123, stdout: answer(), stderr: empty(),
        completion: new Promise(done => setTimeout(() => done({exitCode: 0, signal: null}), 450_000)),
        terminateTree: async () => {terminated++;}};
    }};
    await withMockedTimers(async () => {
      const pending = m.targetLearningCall(settings, runner)('prompt', {});
      await ready; await flush();
      mock.timers.tick(450_000);
      const result = await pending;
      assert.equal(terminated, 0, 'A target answering at 450 s is never stopped');
      assert.equal(Object.hasOwn(result, 'failure'), false, 'A 450 s answer is not a failure');
      assert.deepEqual(result.value, {});
    });
  }
};
