import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import timers from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

async function isolated(mode) {
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), mode],
    {env: process.env, timeout: 30000}).catch(error => {
      if (!error.stdout?.trim()) throw error;
      return {stdout: error.stdout};
    });
  const report = JSON.parse(result.stdout.trim());
  if (report.code === 'ERR_ASSERTION') assert.fail(report.detail);
  if (report.code !== 'PASS') throw new Error(report.detail);
}

export const privateWriteChecks = {
  'private-write-transient-sharing': () => isolated('transient'),
  'private-write-boundaries': () => isolated('boundaries')
};

async function probe(mode) {
  const root = await fs.mkdtemp(join(tmpdir(), 'agent-ops-private-write-'));
  const path = join(root, 'state.json'), outside = join(root, 'outside');
  const realRename = fs.rename, realDelay = timers.setTimeout;
  let calls = [], waits = [], fault;
  fs.rename = async (source, destination) => {
    calls.push(source);
    if (fault) await fault(source, destination);
    return realRename(source, destination);
  };
  timers.setTimeout = async (ms, ...args) => {waits.push(ms); return realDelay(ms, ...args);};
  syncBuiltinESMExports();
  const {writePrivateFile} = await import(pathToFileURL(join(resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist'),
    'runtime/src/security/permissions.js')).href);
  const reset = async (platform, code, failures) => {
    Object.defineProperty(process, 'platform', {value: platform});
    calls = []; waits = [];
    await fs.writeFile(path, 'old');
    fault = async () => {
      assert.equal(await fs.readFile(path, 'utf8'), 'old', 'Keep the old target until atomic replacement');
      if (calls.length <= failures) throw Object.assign(new Error('Injected sharing denial'), {code});
    };
  };
  const clean = async () => assert.equal((await fs.readdir(root)).filter(name => name.includes('.agent-ops-private-')).length, 0);
  try {
    if (mode === 'transient') {
      for (const code of ['EPERM', 'EACCES', 'EBUSY']) for (const failures of [1, 4]) {
        await reset('win32', code, failures);
        await assert.doesNotReject(writePrivateFile(path, 'new', root));
        assert.equal(await fs.readFile(path, 'utf8'), 'new');
        assert.equal(calls.length, failures + 1);
        assert.equal(new Set(calls).size, 1, 'Retry the same complete temporary file');
        assert.deepEqual(waits, [50, 100, 150, 200].slice(0, failures));
        await clean();
      }
    } else {
      for (const [platform, code, attempts] of [['win32', 'EPERM', 5], ['win32', 'EACCES', 5],
        ['win32', 'EBUSY', 5], ['win32', 'EIO', 1], ['linux', 'EPERM', 1], ['darwin', 'EACCES', 1]]) {
        await reset(platform, code, Infinity);
        await assert.rejects(writePrivateFile(path, 'new', root), {code});
        assert.equal(calls.length, attempts);
        assert.equal(await fs.readFile(path, 'utf8'), 'old');
        assert.deepEqual(waits, attempts === 5 ? [50, 100, 150, 200] : []);
        await clean();
      }
      Object.defineProperty(process, 'platform', {value: 'win32'});
      await fs.mkdir(outside); await fs.writeFile(join(outside, 'state.json'), 'protected');
      for (const duringRetry of [false, true]) {
        calls = []; waits = [];
        await fs.rm(path, {force: true});
        const redirect = () => fs.symlink(outside, path, 'junction');
        if (duringRetry) {
          await fs.writeFile(path, 'old');
          fault = async () => {await fs.rm(path); await redirect(); throw Object.assign(new Error('Sharing denial'), {code: 'EPERM'});};
        } else await redirect();
        await assert.rejects(writePrivateFile(path, 'new', root), {code: 'PRIVATE_STATE_PATH_INVALID'});
        assert.equal(calls.length, duringRetry ? 1 : 0);
        assert.equal(await fs.readFile(join(outside, 'state.json'), 'utf8'), 'protected');
        await clean();
      }
    }
  } finally {
    fs.rename = realRename; timers.setTimeout = realDelay; syncBuiltinESMExports();
    await fs.rm(root, {recursive: true, force: true});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {await probe(process.argv[2]); console.log(JSON.stringify({code: 'PASS'}));}
  catch (error) {console.log(JSON.stringify({code: error.code, detail: String(error.stack ?? error)})); process.exitCode = 1;}
}
