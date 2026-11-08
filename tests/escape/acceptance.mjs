import {ruleChecks} from './rule-checks.mjs';
import {lessonChecks} from './lesson-checks.mjs';
import {budgetDeterminismChecks} from './budget-determinism-check.mjs';

// Escape-only acceptance runner: same generic protocol as tests/run/startup.acceptance.mjs, fewer checks.
const checks = {...ruleChecks, ...lessonChecks, ...budgetDeterminismChecks};
const executionId = process.env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID ?? 'local-escape';
const phase = process.env.AGENT_OPS_ACCEPTANCE_PHASE ?? 'candidate';
const requestedChecks = (process.env.AGENT_OPS_ACCEPTANCE_CHECKS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const selectedChecks = requestedChecks.length > 0
  ? Object.entries(checks).filter(([id]) => requestedChecks.includes(id))
  : Object.entries(checks);
const results = [];
for (const [checkId, check] of selectedChecks) {
  process.stderr.write(`escape: ${checkId}\n`);
  let status = 'PASS', failureClass = 'none', detail = 'Real Git/process assertions completed';
  try {await check();} catch (e) {status = 'FAIL'; failureClass = e.code === 'ERR_ASSERTION' ? 'assertion-failed' : 'infrastructure-error'; detail = String(e.stack ?? e).replace(/[\r\n]/gu, ' ').slice(0, 4000);}
  results.push({executionId, phase, framework: 'node-assert', frameworkVersion: '1', checkId, status, failureClass, attempts: 1, evidence: [detail]});
}
console.log(JSON.stringify({protocolVersion: 1, executionId, phase, framework: 'node-assert', frameworkVersion: '1', results,
  completed: true, completionEvidence: ['All named checks ran once'], diagnostics: []}));
if (results.some(r => r.status !== 'PASS')) process.exitCode = 1;
