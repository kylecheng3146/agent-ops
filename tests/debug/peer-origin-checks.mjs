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
const {parseArgs} = await mod('packages/cli/src/args.js');
const {calculateConfigHash} = await mod('runtime/src/config/hash.js');
const {writeWorktreeRecord} = await mod('runtime/src/parallel/service.js');

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
  },
  // A committed DEBUG repair confirms its cause against the same range verify and review used.
  'debug-base-argument': async () => {
    const parsed = (() => {
      try {return parseArgs(['task', 'debug', '--task', 'task-id', '--base', 'HEAD~1', '--debug-action', 'hypothesis', '--payload-file', 'h.json']);}
      catch (error) {assert.fail(`task debug rejected --base: ${error.message}`);}
    })();
    assert.equal(parsed.base, 'HEAD~1');
    assert.throws(() => parseArgs(['task', 'status', '--task', 'task-id', '--base', 'HEAD~1']), {code: 'CLI_OPTION_NOT_ALLOWED'});
  },
  // Claude records the shell's cwd per row; after cd into the owned worktree a typed 暫停 must still count.
  'worktree-cwd-control': async () => {
    const session = '12345678-1234-1234-1234-123456789abc';
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-cwd-worktree-'));
    const home = await mkdtemp(join(tmpdir(), 'agent-ops-cwd-home-'));
    const main = join(home, 'main');
    const git = (...args) => execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    const config = {schemaVersion: 3, profiles: ['core'], verification: {commands: [], acceptanceRunners: []},
      features: {completionGate: {enabled: false}, stopVerification: {enabled: false}, debug: {enabled: true, budgetMs: 3_600_000, maxRounds: 5}},
      pathMappings: [], securityExceptions: []};
    try {
      git('init', '-q'); git('config', 'user.name', 'Cwd fixture'); git('config', 'user.email', 'fixture@example.invalid');
      await mkdir(join(root, '.agent-ops')); await mkdir(main);
      await writeFile(join(root, '.agent-ops/config.json'), JSON.stringify(config));
      await writeFile(join(root, '.gitignore'), '.agent-ops/tasks/\n');
      git('add', '.'); git('commit', '-qm', 'baseline');
      const baseline = git('rev-parse', 'HEAD').toString().trim();
      const gitRunner = {run: async args => {try {return {exitCode: 0, stdout: git(...args)};} catch {return {exitCode: 1, stdout: Buffer.alloc(0)};}}};
      const tasks = new TaskService(new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root), {completion: {root, gitRunner, loadConfig: async () => config}});
      const review = {mode: 'review-only', baselineCommit: baseline, bindings: [], reviewOnlyReason: 'Fixture'};
      const {task} = await tasks.create({title: 'Cwd fixture', goal: 'Investigate the original issue', sessionId: session, policyConfigHash: calculateConfigHash(config),
        criteria: [{id: 'issue', description: 'Issue', verifierIds: [], acceptance: review}, {id: 'related', description: 'Related', verifierIds: [], acceptance: review}],
        debug: {facts: ['reported'], unknowns: ['root cause']}});
      await writeWorktreeRecord({schemaVersion: 1, name: 'session-cwd', branch: 'agent-ops/session-cwd', path: root, mainRoot: main, targetBranch: 'main',
        base: baseline, sessionId: session, createdAt: new Date().toISOString()});
      const debug = tasks.debugService();
      await debug.foregroundStart(task.id, session);
      // Claude keys the transcript directory by the directory the session was launched from: the main checkout.
      const directory = join(home, '.claude/projects', main.replace(/[^a-zA-Z0-9]/gu, '-'));
      await mkdir(directory, {recursive: true});
      const path = join(directory, session + '.jsonl');
      let at = Date.now();
      const row = cwd => JSON.stringify({type: 'user', sessionId: session, cwd, timestamp: new Date(at++).toISOString(),
        origin: {kind: 'human'}, promptSource: 'typed', message: {role: 'user', content: '暫停'}});
      await writeFile(path, row(join(home, 'elsewhere')) + '\n');
      await debug.syncNativeControl(task.id, session, home);
      assert.notEqual((await debug.root(task.id)).debug.control?.paused, true, 'a 暫停 from an unrelated cwd must not pause');
      await writeFile(path, row(join(home, 'elsewhere')) + '\n' + row(root) + '\n');
      await debug.syncNativeControl(task.id, session, home);
      assert.equal((await debug.root(task.id)).debug.control?.paused, true, 'a 暫停 typed from the owned worktree cwd must pause');
    } finally {await rm(root, {recursive: true, force: true}); await rm(home, {recursive: true, force: true});}
  }
};
