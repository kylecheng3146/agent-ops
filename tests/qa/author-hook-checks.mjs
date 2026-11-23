import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const load = path => import(pathToFileURL(join(build, path)).href);
const SESSION = 'qa-author-session';
const config = {schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: []}, worktree: {mode: 'auto'},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};

/** A delivery repository and the QA author's disposable clone of it, made exactly as the controller makes it. */
async function fixture(check) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-hook-')));
  const repo = join(parent, 'repo'), clone = join(parent, 'qa', 'checkout');
  const git = (cwd, args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  const saved = process.env.AGENT_OPS_QA_TASK_ID;
  try {
    await mkdir(repo);
    git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.name', 'QA fixture']); git(repo, ['config', 'user.email', 'qa@example.invalid']);
    await writeFile(join(repo, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(repo, 'source.txt'), 'baseline\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'baseline']);
    const {cloneQaCheckout} = await load('runtime/src/qa/session.js');
    await cloneQaCheckout(repo, clone, git(repo, ['rev-parse', 'HEAD']).trim());
    const {runHookProcess} = await load('packages/cli/src/hook-process.js');
    const gitRunner = {run: async args => {
      try {return {exitCode: 0, stdout: Buffer.from(git(clone, args))};}
      catch (e) {return {exitCode: e.status ?? 1, stdout: Buffer.from(e.stdout ?? '')};}
    }};
    const hook = async (event, input) => {
      const out = [];
      // Installed Claude Stop hooks carry --completion-gate, which fails closed on hook errors.
      await runHookProcess(['claude', event, ...(event === 'Stop' ? ['--completion-gate'] : [])], {stdin: Readable.from([JSON.stringify({hook_event_name: event, session_id: SESSION, cwd: clone, ...input})]),
        writeStdout: value => { out.push(value); }, writeStderr: () => undefined}, '0.0.0',
      {root: clone, loadConfig: async () => config, trust: async () => 'UNTRUSTED', gitRunner});
      return out.join('');
    };
    const edit = () => hook('PreToolUse', {tool_name: 'Write', tool_input: {file_path: join(clone, 'tests', 'qa.check.mjs')}});
    const marker = () => mkdir(join(clone, '.agent-ops'), {recursive: true})
      .then(() => writeFile(join(clone, '.agent-ops', 'qa-author-input.json'), '{}\n'));
    await check({clone, hook, edit, marker});
  } finally {
    if (saved === undefined) delete process.env.AGENT_OPS_QA_TASK_ID; else process.env.AGENT_OPS_QA_TASK_ID = saved;
    await rm(parent, {recursive: true, force: true});
  }
}

export const qaAuthorHookChecks = {
  'qa-author-clone-write-allowed': () => fixture(async ({edit, marker}) => {
    await marker();
    process.env.AGENT_OPS_QA_TASK_ID = 'task-qa';
    const output = await edit();
    assert.doesNotMatch(output, /WORKTREE_/u, 'The QA author must write test materials in its detached clone');
  }),
  'qa-author-clone-stop-allowed': () => fixture(async ({clone, hook, marker}) => {
    await marker();
    process.env.AGENT_OPS_QA_TASK_ID = 'task-qa';
    await hook('SessionStart', {source: 'startup'});
    await mkdir(join(clone, 'tests'), {recursive: true});
    await writeFile(join(clone, 'tests', 'qa.check.mjs'), 'export const checks = {};\n');
    const output = await hook('Stop', {stop_hook_active: false});
    assert.doesNotMatch(output, /COMPLETION_GATE_/u, 'The QA author must stop after writing materials the controller imports');
  }),
  'qa-author-identity-write-guarded': () => fixture(async ({edit, marker}) => {
    process.env.AGENT_OPS_QA_TASK_ID = 'task-qa';
    assert.match(await edit(), /WORKTREE_REQUIRED/u, 'The environment alone must not lift the guard');
    delete process.env.AGENT_OPS_QA_TASK_ID;
    await marker();
    assert.match(await edit(), /WORKTREE_REQUIRED/u, 'A planted input file alone must not lift the guard');
  }),
  'qa-author-identity-stop-gated': async () => {
    for (const [env, file] of [[true, false], [false, true]]) await fixture(async ({clone, hook, marker}) => {
      if (file) await marker();
      if (env) process.env.AGENT_OPS_QA_TASK_ID = 'task-qa';
      await hook('SessionStart', {source: 'startup'});
      await mkdir(join(clone, 'tests'), {recursive: true});
      await writeFile(join(clone, 'tests', 'qa.check.mjs'), 'export const checks = {};\n');
      assert.match(await hook('Stop', {stop_hook_active: false}), /COMPLETION_GATE_TASK_REQUIRED/u,
        `${env ? 'The environment' : 'A planted input file'} alone must not lift the completion gate`);
    });
  }
};
