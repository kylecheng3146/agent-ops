import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {mock} from 'node:test';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const mod = path => import(pathToFileURL(join(build, path)).href);
const {ensureBackgroundOffice, serveOffice} = await mod('packages/cli/src/office-entry.js');
const {claimOffice, createOfficeServer, readLiveOffice, userOfficeHome, OFFICE_IDLE_MS} = await mod('runtime/src/office/server.js');
const {LaunchdController} = await mod('runtime/src/run/macOS.js');
const {DEFAULT_CONFIG} = await mod('packages/cli/src/context.js');
const empty = {generatedAt: new Date().toISOString(), runs: [], lobby: [], reviews: []};

export const officeReviveChecks = {
  'office-revive-same-url': async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'office-revive-')));
    const previousHome = process.env.AGENT_OPS_HOME;
    process.env.AGENT_OPS_HOME = root;
    const config = join(root, '.agent-ops/config.json');
    const enabled = {...DEFAULT_CONFIG, features: {...DEFAULT_CONFIG.features, office: {enabled: true}}};
    let running;
    const pages = [];
    let starts = 0;
    mock.timers.enable({apis: ['Date', 'setInterval'], now: Date.now()});
    try {
      execFileSync('git', ['init', '-q', '-b', 'main', root]);
      await mkdir(join(root, '.agent-ops'));
      await writeFile(config, JSON.stringify(enabled));
      const launchd = new LaunchdController({platform: 'darwin', uid: 501, execFile: async (_file, args) => {
        if (args[0] === 'bootstrap') {
          starts++;
          let announce;
          const ready = new Promise(resolve => {announce = resolve;});
          running = serveOffice(root, announce);
          await Promise.race([ready, running.then(() => {throw new Error('Office exited before announcing');})]);
        }
        return {stdout: '', stderr: ''};
      }});
      const open = async url => {pages.push(url);};
      const first = await ensureBackgroundOffice(root, launchd, open);
      mock.timers.tick(OFFICE_IDLE_MS);
      await running;
      const second = await ensureBackgroundOffice(root, launchd, open);
      assert.equal(starts, 2, 'A hook revives the server after a real idle shutdown');
      assert.equal(second, first, 'An already-open tab must reconnect at the same port and token');
      assert.equal((await fetch(first)).status, 200, 'The previous URL serves the revived Office');
      assert.deepEqual(pages, [first], 'Revival must not open another browser tab');
    } finally {
      await writeFile(config, JSON.stringify(DEFAULT_CONFIG));
      mock.timers.tick(15_000);
      await running;
      mock.timers.reset();
      if (previousHome === undefined) delete process.env.AGENT_OPS_HOME; else process.env.AGENT_OPS_HOME = previousHome;
      await rm(root, {recursive: true, force: true});
    }
  },
  'office-slow-snapshot-live': async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'office-slow-')));
    let unblock;
    const snapshot = new Promise(resolve => {unblock = resolve;});
    const office = createOfficeServer({snapshot: async () => await snapshot, onIdle: () => {}});
    const home = userOfficeHome(root);
    try {
      const record = await claimOffice(home, office);
      assert.ok(record);
      assert.deepEqual(await readLiveOffice(home), record, 'Snapshot collection must not block the liveness probe');
    } finally {
      unblock(empty);
      await office.close();
      await rm(root, {recursive: true, force: true});
    }
  }
};
