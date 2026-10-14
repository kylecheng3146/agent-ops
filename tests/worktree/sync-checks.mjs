import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Config changes after an approved update. Modules load lazily so an older build
// fails each check as an assertion, never as a crashed runner.
const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const load = async path => {
  try {return await import(pathToFileURL(join(build, path)).href);}
  catch (e) {assert.fail(`${path} is unavailable: ${e.code ?? e.message}`);}
};
const fn = (module, name) => {
  assert.equal(typeof module[name], 'function', `${name} is not exported`);
  return module[name];
};

const config = timeoutMs => ({schemaVersion: 3, profiles: ['core'], verification: {commands: [
  {id: 'unit', command: 'node', args: ['--test'], cwd: '.', required: true, evidence: {kind: 'exit-code'}, timeoutMs}]},
  features: {completionGate: {enabled: false}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []});

const raw = {
  'update-syncs-session-worktrees': async () => {
    const manage = await load('runtime/src/parallel/manage.js');
    const {writeWorktreeRecord} = await load('runtime/src/parallel/service.js');
    const {calculateConfigHash} = await load('runtime/src/config/hash.js');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-sync-')));
    try {
      const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
      git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Sync fixture'); git('config', 'user.email', 'fixture@example.invalid');
      await writeFile(join(root, '.gitignore'), '.agent-ops/\n.worktrees/\n'); git('add', '.'); git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD').trim();
      await mkdir(join(root, '.agent-ops'), {recursive: true});
      await writeFile(join(root, '.agent-ops/config.json'), JSON.stringify(config(60_000)));
      for (const [name, runId] of [['session', undefined], ['run-worker', 'run-fixture']]) {
        const path = join(root, '.worktrees', name);
        git('worktree', 'add', '-q', '-b', `agent-ops/${name}`, path, base);
        await mkdir(join(path, '.agent-ops/tasks'), {recursive: true});
        await writeFile(join(path, '.agent-ops/config.json'), JSON.stringify(config(60_000)));
        await writeWorktreeRecord({schemaVersion: 1, name, branch: `agent-ops/${name}`, path: await realpath(path), mainRoot: root,
          targetBranch: 'main', base, sessionId: 'owner', createdAt: '2026-10-14T00:00:00.000Z', ...(runId === undefined ? {} : {runId})});
      }
      // The user approved a config change in the main checkout (update re-trusted it).
      await writeFile(join(root, '.agent-ops/config.json'), JSON.stringify(config(300_000)));
      const granted = [];
      const deps = {
        git: async (cwd, args) => {
          try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd, encoding: 'utf8'}), stderr: ''};}
          catch (e) {return {exitCode: e.status ?? 1, stdout: '', stderr: String(e.stderr ?? '')};}
        },
        loadConfig: async path => JSON.parse(await readFile(join(path, '.agent-ops/config.json'), 'utf8')),
        trust: {status: async path => path === root ? 'TRUSTED' : 'STALE', grant: async (path, value) => {granted.push([path, calculateConfigHash(value)]);},
          revoke: async () => {}}
      };
      assert.deepEqual(await fn(manage, 'sessionWorktreeNames')(deps, root), ['session'], 'run worktrees are never listed');
      assert.deepEqual(await fn(manage, 'syncSessionWorktrees')(deps, root), ['session']);
      const main = await readFile(join(root, '.agent-ops/config.json'), 'utf8');
      assert.equal(await readFile(join(root, '.worktrees/session/.agent-ops/config.json'), 'utf8'), main);
      assert.notEqual(await readFile(join(root, '.worktrees/run-worker/.agent-ops/config.json'), 'utf8'), main, 'run worktree config untouched');
      assert.deepEqual(granted, [[join(root, '.worktrees/session'), calculateConfigHash(config(300_000))]]);
      // Nothing is granted unless the main checkout itself is trusted.
      granted.length = 0;
      assert.deepEqual(await fn(manage, 'syncSessionWorktrees')({...deps, trust: {...deps.trust, status: async () => 'STALE'}}, root), []);
      assert.deepEqual(granted, []);
    } finally {await rm(root, {recursive: true, force: true});}
  },

  'revise-rebinds-policy': async () => {
    const {TaskService} = await load('runtime/src/task/service.js');
    const {FileTaskStore} = await load('runtime/src/task/store.js');
    const {calculateConfigHash} = await load('runtime/src/config/hash.js');
    const {taskContractHash} = await load('runtime/src/task/contract.js');
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-rebind-'));
    try {
      execFileSync('git', ['init', '-q'], {cwd: root});
      let current = config(60_000);
      const gitRunner = {run: async () => ({exitCode: 0, stdout: Buffer.alloc(0)})};
      const tasks = new TaskService(new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root),
        {completion: {root, gitRunner, base: 'HEAD', loadConfig: async () => current}});
      const created = await tasks.create({title: 'Rebind', policyConfigHash: calculateConfigHash(current),
        criteria: [{id: 'one', description: 'One holds.', verifierIds: ['unit']}, {id: 'two', description: 'Two holds.', verifierIds: ['unit']}]});
      current = config(300_000);
      const rebound = await tasks.revise(created.task.id, {expectedContractHash: taskContractHash(created.task), reason: 'Rebind to the current configuration'})
        .catch(e => assert.fail(`a reason-only revise must rebind: ${e.code} ${e.message}`));
      assert.equal(rebound.policyConfigHash, calculateConfigHash(current));
      assert.deepEqual(rebound.task.criteria, created.task.criteria);
      await assert.rejects(tasks.revise(rebound.task.id, {expectedContractHash: taskContractHash(rebound.task), reason: 'Again'}),
        {code: 'TASK_REVISION_INVALID'});
    } finally {await rm(root, {recursive: true, force: true});}
  }
};

/** Missing behavior surfaces as a failed assertion, so the baseline is red, not broken. */
export const syncChecks = Object.fromEntries(Object.entries(raw).map(([id, check]) => [id, async () => {
  try {await check();}
  catch (e) {
    if (e?.code === 'ERR_ASSERTION') throw e;
    throw new assert.AssertionError({message: `${id}: ${e?.code ?? ''} ${e?.stack ?? e}`});
  }
}]));
