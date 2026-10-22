import assert from 'node:assert/strict';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const mod = path => import(pathToFileURL(join(build, path)).href);
const {buildOfficeSnapshot} = await mod('runtime/src/office/snapshot.js');
const {createRunState} = await mod('runtime/src/run/service.js');

const HOUR = 60 * 60 * 1000;

export const officeRetentionChecks = {
  // A run nothing drives any more must leave the Office like a finished one.
  'office-idle-run-retired': async () => {
    const now = Date.parse('2026-10-22T12:00:00.000Z');
    const run = (status, ageMs) => ({...createRunState({root: '/repo', commonDir: '/repo/.git', goal: status, targetBranch: 'main',
      host: 'claude', ownerSessionId: 'owner-' + status + ageMs, now: new Date(now - ageMs).toISOString()}),
      runId: `run-${status}-${ageMs}`, status, updatedAt: new Date(now - ageMs).toISOString()});
    const runs = ['active', 'awaiting-input', 'paused', 'stopping', 'blocked', 'budget-limited', 'complete', 'failed']
      .flatMap(status => [run(status, 3 * HOUR), run(status, HOUR / 2)]);
    const shown = buildOfficeSnapshot({runs, worktrees: [], reviews: [], now}).runs.map(r => r.runId).sort();
    assert.deepEqual(shown, [
      ...['active', 'awaiting-input'].map(status => `run-${status}-${3 * HOUR}`),
      ...['active', 'awaiting-input', 'paused', 'stopping', 'blocked', 'budget-limited', 'complete', 'failed'].map(status => `run-${status}-${HOUR / 2}`)
    ].sort(), 'Only running or waiting runs outlive the retention window');
  }
};
