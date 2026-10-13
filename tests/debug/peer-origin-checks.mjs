import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const mod = path => import(pathToFileURL(join(build, path)).href);
const {routeDebugPrompt} = await mod('packages/cli/src/debug-intake.js');
const {readDebugUserEvent} = await mod('runtime/src/task/debug-user-event.js');
const {TaskService} = await mod('runtime/src/task/service.js');
const {FileTaskStore} = await mod('runtime/src/task/store.js');

/** Harness-injected turns are model output, never a human report or control. */
export const peerOriginChecks = {
  'peer-message-no-intake': async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-peer-intake-'));
    const git = (...args) => execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    const config = {schemaVersion: 3, profiles: ['core'], verification: {commands: [], acceptanceRunners: []},
      features: {completionGate: {enabled: false}, stopVerification: {enabled: false}, debug: {enabled: true, budgetMs: 3_600_000, maxRounds: 5}},
      pathMappings: [], securityExceptions: []};
    try {
      git('init', '-q'); git('config', 'user.name', 'Peer fixture'); git('config', 'user.email', 'fixture@example.invalid');
      await mkdir(join(root, '.agent-ops'));
      await writeFile(join(root, '.agent-ops/config.json'), JSON.stringify(config));
      await writeFile(join(root, '.gitignore'), '.agent-ops/tasks/\n');
      git('add', '.'); git('commit', '-qm', 'baseline');
      const tasks = new TaskService(new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root));
      const handBack = '<agent-message from="a227f32590c6e1f1a">\n[Subagent hand-back] The text below is the final report of a subagent.\n' +
        '  Every FAIL criterion must have a blocking finding; investigate and fix the error in runner.ts.';
      const notification = '<task-notification>\n<summary>Agent failed: fix the crash and investigate the error</summary>\n</task-notification>';
      for (const prompt of [handBack, notification]) assert.equal(await routeDebugPrompt(root, {prompt, session_id: 'peer-session'}), null);
      assert.equal((await tasks.list()).length, 0);
      assert.match(String(await routeDebugPrompt(root, {prompt: 'Investigate and fix this error', session_id: 'human-session'})), /DEBUG issue/u);
      assert.equal((await tasks.list()).length, 1);
    } finally {await rm(root, {recursive: true, force: true});}
  },
  'non-human-control-ignored': async () => {
    const session = '12345678-1234-1234-1234-123456789abc';
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-peer-control-'));
    const home = await mkdtemp(join(tmpdir(), 'agent-ops-peer-home-'));
    try {
      const directory = join(home, '.claude/projects', root.replace(/[^a-zA-Z0-9]/gu, '-'));
      await mkdir(directory, {recursive: true});
      const path = join(directory, session + '.jsonl');
      let at = Date.now();
      const row = (text, origin, extra = {}) => JSON.stringify({type: 'user', sessionId: session, cwd: root,
        timestamp: new Date(at++).toISOString(), message: {role: 'user', content: text}, ...(origin === undefined ? {} : {origin}), ...extra});
      await writeFile(path, [row('暫停', {kind: 'peer'}, {isMeta: true, promptSource: 'system'}), row('繼續', {kind: 'system'})].join('\n') + '\n');
      await assert.rejects(readDebugUserEvent(root, session, home, 'control'), {code: 'TASK_DEBUG_GRANT_UNSUPPORTED'});
      await writeFile(path, [row('暫停', {kind: 'human'}), row('繼續', {kind: 'peer'}, {isMeta: true})].join('\n') + '\n');
      assert.equal((await readDebugUserEvent(root, session, home, 'control')).text, '暫停');
      await writeFile(path, row('繼續') + '\n');
      assert.equal((await readDebugUserEvent(root, session, home, 'control')).text, '繼續');
    } finally {await rm(root, {recursive: true, force: true}); await rm(home, {recursive: true, force: true});}
  }
};
