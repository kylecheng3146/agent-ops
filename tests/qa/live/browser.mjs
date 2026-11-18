// Developer environment probe, never an independent QA attestation. Profiles stay private for diagnosis.
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, realpath} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {extname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

export function contained(root, path) {
  const part = relative(resolve(root), resolve(path));
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}

/** Navigate and really reload each path in one Chrome tab, using standard CDP pipes, no driver or dependency. */
export async function probeBrowser(root, paths) {
  root = await realpath(root);
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = await realpath(resolve(root, `.${pathname}`));
      if (!contained(root, file)) {response.writeHead(403).end(); return;}
      const body = await readFile(file);
      response.writeHead(200, {'content-type': {'.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript'}[extname(file)] ?? 'application/octet-stream'}).end(body);
    } catch {response.writeHead(404).end('Not found');}
  });
  await new Promise((done, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', done);});
  const profile = await mkdtemp(join(tmpdir(), 'agent-ops-browser-probe-'));
  const chrome = spawn(process.env.FIXTURE_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ['--headless', '--no-first-run', `--user-data-dir=${profile}`, '--remote-debugging-pipe', 'about:blank'],
    {stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']});
  const pending = new Map(); let nextId = 0, buffer = '', warnings = '';
  const closed = new Promise(done => chrome.once('close', done));
  const fail = error => {for (const p of pending.values()) {clearTimeout(p.timer); p.reject(error);} pending.clear();};
  chrome.once('error', fail); chrome.once('exit', () => fail(new Error('Chrome exited')));
  chrome.stderr.on('data', data => {warnings = (warnings + data.toString()).slice(-8192);});
  chrome.stdio[4].on('data', data => {
    buffer += data.toString();
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message; try {message = JSON.parse(frame);} catch {fail(new Error('Invalid CDP response')); continue;}
      const p = pending.get(message.id); if (!p) continue;
      pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(new Error(message.error.message)); else p.resolve(message.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((done, reject) => {
    const id = ++nextId, timer = setTimeout(() => {pending.delete(id); reject(new Error(`CDP timeout: ${method}`));}, 15000);
    pending.set(id, {resolve: done, reject, timer});
    chrome.stdio[3].write(`${JSON.stringify({id, method, params, ...(sessionId === undefined ? {} : {sessionId})})}\0`, error => {
      if (error) {clearTimeout(timer); pending.delete(id); reject(error);}
    });
  });
  try {
    const version = await send('Browser.getVersion');
    const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
    await send('Page.enable', {}, sessionId);
    const results = [];
    for (const path of paths) {
      const url = new URL(path, `http://127.0.0.1:${server.address().port}/`).href;
      if (!url.startsWith(`http://127.0.0.1:${server.address().port}/`)) throw new Error('Probe URL must remain on its loopback server');
      const read = async () => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const {result} = await send('Runtime.evaluate', {expression: `JSON.stringify({url:location.href,ready:document.readyState,seconds:document.getElementById('seconds')?.textContent??null,error:document.getElementById('error')?.textContent??null})`, returnByValue: true}, sessionId);
          const state = JSON.parse(result.value);
          if (state.url === url && state.ready === 'complete') return {seconds: state.seconds, error: state.error};
          await new Promise(done => setTimeout(done, 25));
        }
        throw new Error('Page did not finish loading');
      };
      await send('Page.navigate', {url}, sessionId); const initial = await read();
      const {result: marker} = await send('Runtime.evaluate', {expression: 'globalThis.__probeDocument = Math.random(); globalThis.__probeDocument', returnByValue: true}, sessionId);
      await send('Page.reload', {ignoreCache: true}, sessionId);
      // A changed document proves reload; merely reading the preceding completed document would not.
      const deadline = Date.now() + 15000;
      let reloaded = false;
      while (Date.now() < deadline) {
        const {result} = await send('Runtime.evaluate', {expression: 'globalThis.__probeDocument', returnByValue: true}, sessionId);
        if (result.value !== marker.value) {reloaded = true; break;}
        await new Promise(done => setTimeout(done, 25));
      }
      if (!reloaded) throw new Error('The same page document was not reloaded');
      results.push({path, initial, afterReload: await read(), reloadMethod: 'Page.reload', sameTarget: true});
    }
    return {browser: version.product, transport: 'remote-debugging-pipe', results, profile, warnings};
  } finally {
    await send('Browser.close').catch(() => undefined);
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGTERM');
    await closed; await new Promise(done => server.close(done));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node browser.mjs <repository> [relative page paths]');
  console.log(JSON.stringify(await probeBrowser(process.argv[2], process.argv.slice(3)), null, 2));
}
