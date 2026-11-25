import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Decisions #2 and #4: a provider-limited QA planner or author fails over to the next eligible configured host
// (planner: any review host; author: claude/codex only), and every session leaves one qa-session event in events.ndjson.
const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const load = path => import(pathToFileURL(join(build, path)).href);
const at = '2026-11-25T00:00:00.000Z';
const resetAt = '2099-01-01T00:00:00.000Z';
const taskId = 'task-qa-host-failover-1';
const material = `tests/qa-independent/${taskId}.test.mjs`;
const runner = {id: 'qa-runner', command: process.execPath, args: ['{materials}'], cwd: '.', adapter: 'generic'};
const config = {schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: [
  {id: 'tests', command: process.execPath, args: ['test.mjs'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}], acceptanceRunners: [runner]},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [], qa: {enabled: true}};
const feature = answer => `export const answer = () => ${answer};\n`;
/** Test-only material speaking the generic acceptance protocol; never a production QA artifact. */
const CASE_TEST = `import {answer} from '../../feature.mjs';
const executionId = process.env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID, phase = process.env.AGENT_OPS_ACCEPTANCE_PHASE;
const ok = answer() === 2;
console.log(JSON.stringify({protocolVersion: 1, executionId, framework: 'qa-fixture', frameworkVersion: '1', phase, results: [{executionId,
  framework: 'qa-fixture', frameworkVersion: '1', checkId: 'answer-two', phase, status: ok ? 'PASS' : 'FAIL', failureClass: ok ? 'none' : 'assertion-failed',
  attempts: 1, evidence: ['answer observed']}], completed: true, completionEvidence: ['qa fixture finished'], diagnostics: []}));
process.exitCode = ok ? 0 : 1;
`;
const scenarios = {initialState: {applies: true, behavior: 'Fresh enrolled delivery'}, redo: {na: 'No replay here'},
  timeBoundary: {applies: true, behavior: 'A provider limit fails over, never waits'}, identitySwitch: {applies: true, behavior: 'QA host differs from the developer'},
  concurrency: {na: 'One controller'}};
/** Test-only planner answer; never a production plan. */
const plan = {cases: [{id: 'case-answer-two', criterionIds: ['behavior'], surfaceIds: [], required: true, mode: 'behavioral',
  preconditions: ['An enrolled delivery'], actions: ['Run answer-two'], expected: 'answer is two',
  bindings: [{runnerId: 'qa-runner', checkIds: ['answer-two'], redCheckIds: ['answer-two'], materials: [{path: material, role: 'test'}]}]},
  {id: 'case-guide', criterionIds: ['compatibility'], surfaceIds: [], required: true, mode: 'nonmechanical', preconditions: [], actions: ['Read the guide'],
    expected: 'The guide is accurate', bindings: [], nonmechanicalReason: 'Prose accuracy needs human judgment'}],
  scenarios, environment: [], questions: []};
const criteria = [{id: 'behavior', description: 'answer returns two', verifierIds: ['tests']},
  {id: 'compatibility', description: 'The guide stays accurate', verifierIds: ['tests']}];

/**
 * Scripted, test-only host outputs. `limit` is a structured provider error with a reset, `limit-unknown` one without,
 * `prose-limit` a failed call whose output only says "rate limit"; `ok` answers.
 */
async function fixture({planners, authors: authorScript, available, implementationHost = 'codex'}, check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-failover-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-failover-outside-')));
  const git = (args, cwd = root) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const gitRunner = {run: async args => {
    try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']})};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0)};}
  }};
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA failover fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(root, 'feature.mjs'), feature(1));
    await writeFile(join(root, 'test.mjs'), 'process.exitCode = 0;\n');
    git(['add', '.']); git(['commit', '-qm', 'baseline']);
    const baseline = git(['rev-parse', 'HEAD']);
    await mkdir(join(root, '.agent-ops'), {recursive: true});
    await writeFile(join(root, '.agent-ops/config.json'), JSON.stringify(config));
    const {TaskService} = await load('runtime/src/task/service.js');
    const {FileTaskStore} = await load('runtime/src/task/store.js');
    const {FileQaStore} = await load('runtime/src/qa/store.js');
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js');
    const {NodeVerificationProcessRunner} = await load('runtime/src/verify/spawn.js');
    const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js');
    const {resolveReviewScope} = await load('runtime/src/review/scope.js');
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js');
    const tasks = new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root);
    const service = new TaskService(tasks, {generateId: () => taskId, now: () => at, platform: 'darwin',
      completion: {root, base: baseline, gitRunner, loadConfig: async () => structuredClone(config)}});
    const store = new FileQaStore(join(root, '.git'));
    const fingerprint = async () => await calculateSourceFingerprint(root, await resolveReviewScope({root, runner: gitRunner, base: baseline}), gitRunner);
    // Test-only read-only planner transport: the invoked host is the command; each host answers per the script.
    const planner = {hosts: [], start(request) {
      const host = request.command;
      this.hosts.push(host);
      const mode = planners[host] ?? 'ok';
      const out = mode === 'ok' ? JSON.stringify({structured_output: plan, usage: {input_tokens: 5, output_tokens: 3}})
        : mode === 'prose-limit' ? '' : JSON.stringify({type: 'result', is_error: true,
          error: {type: 'rate_limit_error', ...(mode === 'limit' ? {resetsAt: resetAt} : {})}});
      const err = mode === 'prose-limit' ? 'API Error: 429 Too Many Requests: rate limit exceeded\n' : '';
      return {pid: null, stdout: (async function* () {yield Buffer.from(out);})(), stderr: (async function* () {yield Buffer.from(err);})(),
        completion: Promise.resolve({exitCode: mode === 'ok' ? 0 : 1, signal: null}), terminateTree: async () => {}};
    }};
    // Test-only writable hosts with fake process identities; each kind follows the script.
    const alive = new Set(), authors = [];
    let pid = 7000;
    const probe = {identity: async p => p === process.pid || alive.has(p) ? `identity-${p}` : null, groupAlive: () => false, signalGroup: async p => {alive.delete(p);}};
    const host = kind => ({kind,
      async start(input) {authors.push(kind); const p = ++pid; alive.add(p); await input.registerProcess(p);
        return {...input, kind, sessionId: input.sessionId, threadId: null, nativeVersion: null, processId: p, startedAt: at, process: null, goalStatus: 'unknown'};},
      async resume() {authors.push(`${kind}:resume`); throw new Error('A provider-limited QA session must not be resumed before its reset');},
      async activate() {return {actionId: 'a', accepted: true, nativeStatus: 'active', payload: null};},
      async *observe(handle) {
        const base = {runId: handle.runId, workerId: handle.workerId, generation: handle.generation, contractHash: handle.contractHash, host: kind, proof: false, at};
        const mode = authorScript[kind] ?? 'ok';
        if (mode !== 'ok') {
          yield {...base, type: 'message', nativeStatus: 'usageLimited', payload: {error: {type: 'rate_limit_error', ...(mode === 'limit' ? {resetsAt: resetAt} : {})}}};
          return;
        }
        const control = await store.readControl(taskId);
        await mkdir(join(handle.cwd, 'tests/qa-independent'), {recursive: true});
        await writeFile(join(handle.cwd, material), CASE_TEST);
        await mkdir(join(handle.cwd, '.agent-ops'), {recursive: true});
        await writeFile(join(handle.cwd, '.agent-ops/qa-author-response.json'), JSON.stringify({schemaVersion: 1, generation: handle.generation,
          plan: control.plan.digest, candidateCommit: git(['rev-parse', 'HEAD'], handle.cwd),
          materials: [{path: material, role: 'test', caseIds: ['case-answer-two']}], requestedEdits: [], observations: [], questions: []}));
        yield {...base, nativeStatus: 'unknown', payload: {}, type: 'completed'};
      },
      async stop(handle) {alive.delete(handle.processId); return {actionId: 's', accepted: true, nativeStatus: 'paused', payload: null};},
      async update() {throw new Error('unused');}, async interrupt() {throw new Error('unused');}});
    const orchestrate = async (patch = {}) => await runQaDelivery({store, root, rootTaskId: taskId, records: (await tasks.read()).tasks, config,
      trusted: true, fingerprint, gitRunner, processRunner: new NodeVerificationProcessRunner(), planningRunner: planner,
      evidenceStore: new FileEvidenceStore(root, root), controllerId: 'qa-controller', available, implementationHost,
      implementationSessionId: 'developer-session', advisory: null, host, probe, checkouts: outside, now: () => at, platform: 'darwin', ...patch});
    const task = (await service.create({title: 'Deliver with independent QA', goal: 'Users get the answer two', criteria,
      sessionId: 'developer-session'})).task;
    assert.ok(task.qa?.required, 'The delivery root is QA-enrolled');
    await writeFile(join(root, 'feature.mjs'), feature(2));
    git(['commit', '-qam', 'implementation']);
    await check({root, outside, store, planner, authors, orchestrate});
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
}
const settle = promise => promise.then(value => ({value}), error => ({error}));
async function attemptOf(f, result) {
  const report = await f.store.get({...result.report, kind: 'report'});
  return await f.store.get({...report.attempt, kind: 'attempt'});
}
// Planner order agy → claude → codex with the developer on codex; agy is a review host, never a writable author.
const failover = {available: ['agy', 'claude', 'codex'], planners: {agy: 'limit'}, authors: {claude: 'limit'}};

export const hostFailoverChecks = {
  'qa-provider-limit-failover': () => fixture(failover, async f => {
    const outcome = await settle(f.orchestrate());
    assert.equal(outcome.error, undefined, `QA fails over instead of stopping: ${outcome.error?.code} ${outcome.error?.message}`);
    const result = outcome.value;
    assert.equal(result.state, 'passed', result.blockers.join('; '));
    // Planner: the limited agy session is followed by the next configured review host that is not the developer's.
    assert.deepEqual(f.planner.hosts, ['agy', 'claude'], 'The planner fails over once, in configured order, avoiding the implementation host');
    const control = await f.store.readControl(taskId);
    const savedPlan = await f.store.get({...control.plan, kind: 'plan'});
    assert.equal(savedPlan.session.host, 'claude', 'The plan was made on the failover host');
    assert.match(String(savedPlan.session.fallbackReason), /provider limit/iu, 'The planner fallbackReason names the limit');
    assert.match(String(savedPlan.session.fallbackReason), /\bagy\b/u, 'The planner fallbackReason names the limited host');
    // Author: agy is skipped (not writable), the limited claude session fails over to codex, the only writable host left.
    assert.deepEqual(f.authors, ['claude', 'codex'], 'The author fails over to the next eligible Claude/Codex host and never to agy');
    const attempt = await attemptOf(f, result);
    assert.equal(attempt.session.host, 'codex', 'QA completed on the failover author host');
    assert.match(String(attempt.session.fallbackReason), /provider limit/iu, 'The author fallbackReason names the limit');
    assert.match(String(attempt.session.fallbackReason), /\bclaude\b/u, 'The author fallbackReason names the limited host');
    assert.equal(result.sessions, 2, 'One planning step and one authoring step were delivered');
  }),

  'qa-provider-limit-exhausted': async () => {
    // Planner: every review host limited, one with a known reset and one with only prose and no reset.
    await fixture({available: ['claude', 'codex'], planners: {claude: 'limit', codex: 'prose-limit'}, authors: {}}, async f => {
      const started = Date.now();
      const outcome = await settle(f.orchestrate());
      assert.ok(Date.now() - started < 60_000, 'QA never waits for a provider reset');
      assert.equal(outcome.error?.code, 'QA_PROVIDER_LIMIT', `Planner exhaustion ends as a provider limit: ${outcome.error?.code ?? outcome.value?.state}`);
      assert.match(outcome.error.message, new RegExp(`claude until ${resetAt.replace(/[.]/gu, '\\.')}`, 'u'), 'The known reset is reported');
      assert.match(outcome.error.message, /codex with an unknown reset/u, 'An unknown reset is reported as unknown');
      assert.deepEqual(f.planner.hosts, ['claude', 'codex'], 'At most one session per eligible planner host');
      const control = await f.store.readControl(taskId);
      assert.deepEqual({state: control.state, attestation: control.attestation, plan: control.plan}, {state: 'blocked', attestation: null, plan: null},
        'QA is blocked, never PASS');
    });
    // Author: both writable hosts limited (agy is not an author); the last paused session waits for its reset, no further session.
    await fixture({available: ['agy', 'claude', 'codex'], planners: {}, authors: {claude: 'limit-unknown', codex: 'limit'}}, async f => {
      const outcome = await settle(f.orchestrate());
      assert.equal(outcome.error?.code, 'QA_PROVIDER_LIMIT', `Author exhaustion ends as a provider limit: ${outcome.error?.code ?? outcome.value?.state}`);
      assert.match(outcome.error.message, /claude with an unknown reset/u, 'An unknown reset is reported as unknown');
      assert.match(outcome.error.message, new RegExp(`codex until ${resetAt.replace(/[.]/gu, '\\.')}`, 'u'), 'The known reset is reported');
      assert.deepEqual(f.authors, ['claude', 'codex'], 'At most one session per eligible author host');
      const control = await f.store.readControl(taskId);
      assert.deepEqual({state: control.state, attestation: control.attestation, reason: control.native?.reason, reset: control.native?.resetAt},
        {state: 'blocked', attestation: null, reason: 'provider-limit', reset: resetAt}, 'QA is blocked with the paused session and its reset saved');
      const again = await settle(f.orchestrate());
      assert.equal(again.error?.code, 'QA_PROVIDER_WAIT', 'Automatic QA makes no further session before the reset');
      assert.deepEqual(f.authors, ['claude', 'codex'], 'No further author session');
    });
  },

  'qa-session-events': () => fixture(failover, async f => {
    const {readLocalLog} = await load('runtime/src/logging/local-log.js');
    const cli = await load('packages/cli/src/qa-delivery.js');
    assert.equal(typeof cli.qaSessionLog, 'function', 'The CLI QA wiring exports its events.ndjson qa-session sink');
    const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-failover-home-')));
    try {
      const result = await f.orchestrate({onSession: report => cli.qaSessionLog(report, home)});
      assert.equal(result.state, 'passed', result.blockers.join('; '));
      const events = (await readLocalLog(home)).map(e => e.event).filter(e => e.type === 'qa-session');
      assert.deepEqual(events.map(e => [e.role, e.host, e.outcome]), [
        ['planner', 'agy', 'provider-limit'], ['planner', 'claude', 'succeeded'],
        ['author', 'claude', 'provider-limit'], ['author', 'codex', 'succeeded']], 'Exactly one event per attempted session');
      for (const e of events) {
        assert.deepEqual(Object.keys(e).sort(), ['durationMs', 'host', 'outcome', 'role', 'taskId', 'trigger', 'type', 'usage'].sort());
        assert.equal(e.taskId, taskId);
        assert.ok(Number.isSafeInteger(e.durationMs) && e.durationMs >= 0, 'durationMs is a non-negative integer');
        assert.ok(Array.isArray(e.trigger) && e.trigger.length > 0, 'trigger names what caused the session');
      }
      assert.deepEqual(events[1].usage, {inputTokens: 5, outputTokens: 3, totalTokens: 8}, 'Reported planner usage is logged; unknown cost is omitted');
      assert.equal(events[0].usage, 'unknown', 'A session that reported no usage logs unknown');
      assert.equal(events[3].usage, 'unknown');
      assert.deepEqual(events.map(e => e.trigger), [['plan:missing'], ['plan:missing', 'failover:provider-limit'],
        ['attempt:missing'], ['attempt:missing', 'failover:provider-limit']], 'trigger names the cause and the failover');
    } finally {
      await rm(home, {recursive: true, force: true});
    }
  })
};
