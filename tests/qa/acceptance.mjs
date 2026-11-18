// Independent QA adds tests/qa/independent/**/*.check.mjs exporting {checks: {id: function}}.
// The trusted runner collects new material without changing commands or existing assertions.
import {readdir} from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = resolve('.'), diagnostics = [], checks = new Map();
async function collect(directory) {
  let entries;
  try {entries = await readdir(directory, {withFileTypes: true});}
  catch (error) {if (error.code === 'ENOENT') return; throw error;}
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('QA material must not be a symlink');
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && entry.name.endsWith('.check.mjs')) {
      const exported = (await import(pathToFileURL(path).href)).checks;
      if (exported === null || typeof exported !== 'object' || Array.isArray(exported)) throw new Error('Missing checks export');
      for (const [id, fn] of Object.entries(exported)) {
        if (id.trim() !== id || !id || id.length > 128 || /[\r\n]/u.test(id) || typeof fn !== 'function') throw new Error('Invalid check export');
        if (checks.has(id)) throw new Error(`Duplicate check in ${relative(root, path)}`);
        checks.set(id, fn);
      }
    }
  }
}
try {await collect(join(root, 'tests/qa/independent'));}
catch {diagnostics.push('QA collection failed: check imports, duplicate IDs, exports and symlinks.');}
const executionId = process.env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID ?? 'local';
const phase = process.env.AGENT_OPS_ACCEPTANCE_PHASE ?? 'candidate';
const requested = [...new Set((process.env.AGENT_OPS_ACCEPTANCE_CHECKS ?? '').split(',').map(s => s.trim()).filter(Boolean))];
const results = [];
for (const checkId of requested.length > 0 ? requested : checks.keys()) {
  let status = 'PASS', failureClass = 'none', detail = 'Assertions completed once.';
  if (!checks.has(checkId)) {status = 'FAIL'; failureClass = 'missing-check'; detail = 'Requested check was not collected.';}
  else try {await checks.get(checkId)();}
  catch (error) {
    status = 'FAIL'; failureClass = error?.code === 'ERR_ASSERTION' ? 'assertion-failed' : 'infrastructure-error';
    detail = failureClass === 'assertion-failed' ? 'An acceptance assertion failed.' : 'The acceptance check could not execute.';
  }
  results.push({executionId, phase, framework: 'node-assert', frameworkVersion: '1', checkId, status, failureClass, attempts: 1, evidence: [detail]});
}
if (results.length === 0) diagnostics.push('No independent QA checks were collected.');
console.log(JSON.stringify({protocolVersion: 1, executionId, phase, framework: 'node-assert', frameworkVersion: '1', results,
  completed: true, completionEvidence: ['Collection finished; each selected collected check was attempted once.'], diagnostics}));
if (diagnostics.length > 0 || results.some(r => r.status !== 'PASS')) process.exitCode = 1;
