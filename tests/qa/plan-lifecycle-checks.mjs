import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// QA plan lifecycle: no plan at task create/revise, one plan at the first QA run from the creation baseline,
// and qa plan reuses a current plan unless a stated --replan replaces it.
const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const load = path => import(pathToFileURL(join(build, path)).href);
const at = '2026-11-25T00:00:00.000Z';
const runner = {id: 'qa-runner', command: process.execPath, args: ['{materials}'], cwd: '.', adapter: 'generic'};
const config = {schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: [
  {id: 'tests', command: process.execPath, args: ['test.mjs'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}], acceptanceRunners: [runner]},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [], qa: {enabled: true}};
const criteria = description => [{id: 'behavior', description, verifierIds: ['tests']},
  {id: 'compatibility', description: 'The guide stays accurate', verifierIds: ['tests']}];
const scenarios = {initialState: {applies: true, behavior: 'Fresh enrolled delivery'}, redo: {na: 'No replay'},
  timeBoundary: {na: 'No deadline'}, identitySwitch: {na: 'One host'}, concurrency: {na: 'One controller'}};
/** Test-only planner answer; never a production plan. */
const planFor = (taskId, questions = []) => ({cases: [{id: 'case-answer', criterionIds: ['behavior'], surfaceIds: [], required: true, mode: 'behavioral',
  preconditions: ['An enrolled delivery'], actions: ['Run answer-two'], expected: 'answer is two',
  bindings: [{runnerId: 'qa-runner', checkIds: ['answer-two'], redCheckIds: ['answer-two'], materials: [{path: `tests/qa-independent/${taskId}.test.mjs`, role: 'test'}]}]},
  {id: 'case-guide', criterionIds: ['compatibility'], surfaceIds: [], required: true, mode: 'nonmechanical', preconditions: [], actions: ['Read the guide'],
    expected: 'The guide is accurate', bindings: [], nonmechanicalReason: 'Prose accuracy needs human judgment'}],
  scenarios, environment: [], questions});

async function fixture(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-plan-life-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-plan-life-home-')));
  const git = (args, cwd = root) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const gitRunner = {run: async args => {
    try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']})};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0)};}
  }};
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA plan fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(root, 'feature.mjs'), 'export const answer = () => 1;\n');
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
    const {runQaDelivery} = await load('runtime/src/qa/delivery.js');
    const tasks = new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root);
    let nextId = 0;
    const service = () => new TaskService(tasks, {generateId: () => `task-qa-plan-life-${++nextId}`, now: () => at, platform: 'darwin',
      completion: {root, base: baseline, gitRunner, loadConfig: async () => structuredClone(config)}});
    const store = new FileQaStore(join(root, '.git'));
    // Test-only read-only planner transport: records the commit its clone holds and the DATA it was given.
    const planner = {answer: null, calls: 0, heads: [], prompts: [], start(request) {
      this.calls++;
      this.heads.push(git(['rev-parse', 'HEAD'], resolve(request.cwd)));
      this.prompts.push(request.stdin ?? request.args.join(' '));
      const body = JSON.stringify({structured_output: this.answer, usage: {input_tokens: 5, output_tokens: 3}});
      return {pid: null, stdout: (async function* () {yield Buffer.from(body);})(), stderr: (async function* () {})(),
        completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => {}};
    }};
    const probe = {identity: async p => p === process.pid ? `identity-${p}` : null, groupAlive: () => false, signalGroup: async () => {}};
    const logs = [];
    // Same delivery step verify --task, qa run and qa plan use; the author host is never reached by these checks.
    const orchestrate = async (taskId, patch = {}) => await runQaDelivery({store, root, rootTaskId: taskId, records: (await tasks.read()).tasks, config,
      trusted: true, fingerprint: async () => 'f'.repeat(64), gitRunner, processRunner: new NodeVerificationProcessRunner(), planningRunner: planner,
      evidenceStore: new FileEvidenceStore(root, root), controllerId: 'qa-controller', available: ['claude'], implementationHost: 'codex',
      implementationSessionId: 'developer-session', advisory: null, host: () => {throw new Error('No QA author in plan lifecycle checks');},
      probe, now: () => at, platform: 'darwin', log: line => logs.push(line), ...patch});
    const record = async id => (await tasks.read()).tasks.find(r => r.task.id === id);
    const create = async () => (await service().create({title: 'Deliver with independent QA', goal: 'Users get the answer two',
      criteria: criteria('answer returns two'), sessionId: 'developer-session'})).task;
    await check({root, outside, git, baseline, service, store, planner, orchestrate, record, create, logs});
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
}

/** Runs the production criteria-advisory hook with captured stderr and an isolated local log home. */
async function advisoryOutput(f, run) {
  const home = process.env.AGENT_OPS_HOME, write = process.stderr.write;
  let printed = '';
  process.env.AGENT_OPS_HOME = f.outside;
  process.stderr.write = chunk => {printed += String(chunk); return true;};
  try {await run();} finally {
    process.stderr.write = write;
    if (home === undefined) delete process.env.AGENT_OPS_HOME; else process.env.AGENT_OPS_HOME = home;
  }
  return printed;
}

export const planLifecycleChecks = {
  'qa-plan-deferred-to-verify': () => fixture(async f => {
    const {reviewCreatedCriteria} = await load('packages/cli/src/criteria-review.js');
    const {taskContractHash} = await load('runtime/src/task/contract.js');
    const task = await f.create();
    assert.ok(task.qa?.required, 'The delivery root is QA-enrolled');
    const created = await advisoryOutput(f, () => reviewCreatedCriteria(f.root, task));
    const revised = await f.service().revise(task.id, {expectedContractHash: taskContractHash(task), criteria: criteria('answer returns exactly two'),
      reason: 'Advisory: state the exact value'});
    const afterRevise = await advisoryOutput(f, () => reviewCreatedCriteria(f.root, revised.task, true, 'revise'));
    assert.doesNotMatch(created + afterRevise, /QA plan/u, 'task create and revise start no QA planner after the advisory');
    assert.equal(await f.store.readControl(task.id), null, 'No QA plan or control is written at create/revise');
    assert.equal(f.planner.calls, 0);
    // First QA run after implementation: exactly one planner session, cloned at the creation baseline, not the candidate.
    await writeFile(join(f.root, 'feature.mjs'), 'export const answer = () => 2;\n');
    f.git(['commit', '-qam', 'implementation']);
    const candidate = f.git(['rev-parse', 'HEAD']);
    const createdSource = (await f.record(task.id)).createdSourceCommit;
    assert.equal(createdSource, f.baseline);
    // A required question pauses QA right after planning, so no author session is involved.
    f.planner.answer = planFor(task.id, [{id: 'q-audience', prompt: 'Which audience?', required: true, criterionIds: ['behavior']}]);
    const first = await f.orchestrate(task.id);
    assert.deepEqual({state: first.state, sessions: first.sessions, calls: f.planner.calls}, {state: 'awaiting-input', sessions: 1, calls: 1});
    assert.equal(f.planner.heads[0], createdSource, 'The planner clone is at createdSourceCommit');
    assert.notEqual(f.planner.heads[0], candidate, 'The planner never sees the implementation candidate');
    assert.ok(f.planner.prompts[0].includes(`"baselineCommit":"${createdSource}"`), 'The planner still receives baselineCommit');
    const again = await f.orchestrate(task.id);
    assert.deepEqual({sessions: again.sessions, calls: f.planner.calls}, {sessions: 0, calls: 1}, 'A current plan is planned exactly once');
    // A contract-changing revise makes the plan stale: the next QA run plans once more, still from the baseline.
    const current = (await f.record(task.id)).task;
    await f.service().revise(task.id, {expectedContractHash: taskContractHash(current), criteria: criteria('answer returns the number two'),
      reason: 'Clarify the value'});
    const stale = await f.orchestrate(task.id);
    assert.deepEqual({sessions: stale.sessions, calls: f.planner.calls}, {sessions: 1, calls: 2}, 'A stale plan is replanned once at the next QA run');
    assert.equal(f.planner.heads[1], createdSource);
  }),

  'qa-plan-reuse-current': () => fixture(async f => {
    const {parseArgs} = await load('packages/cli/src/args.js');
    const {runQaCommand} = await load('packages/cli/src/commands/qa.js');
    const task = await f.create();
    const usage = (() => {try {parseArgs(['qa', 'plan', '--task', task.id, '--yes', '--replan']); return null;} catch (error) {return error;}})();
    assert.equal(usage?.code, 'CLI_MISSING_VALUE', 'qa plan --replan without --reason is a usage error');
    assert.match(String(usage?.message), /--reason/u);
    const parsed = parseArgs(['qa', 'plan', '--task', task.id, '--yes', '--replan', '--reason', 'Case binds the wrong check']);
    assert.deepEqual([parsed.replan, parsed.reason], [true, 'Case binds the wrong check']);
    // The production command with only the delivery adapter replaced by the same runQaDelivery step.
    const plan = extra => runQaCommand({args: {command: 'qa', action: 'plan', taskId: task.id, profiles: [], dryRun: false, json: true, yes: true, rerun: false, ...extra},
      root: f.root, deliver: async input => await f.orchestrate(input.taskId, input), adopt: async () => {throw new Error('Already enrolled');},
      loadConfig: async () => structuredClone(config), fingerprint: async () => 'f'.repeat(64), inRun: false, now: () => at});
    f.planner.answer = planFor(task.id);
    const first = await plan();
    assert.deepEqual({code: first.code, sessions: first.data?.result?.sessions, calls: f.planner.calls}, {code: 'QA_PLANNED', sessions: 1, calls: 1});
    const reused = await plan();
    assert.deepEqual({code: reused.code, sessions: reused.data?.result?.sessions, calls: f.planner.calls}, {code: 'QA_PLANNED', sessions: 0, calls: 1},
      'qa plan on a current plan returns it without a planner session');
    assert.equal(reused.data.result.plan.digest, first.data.result.plan.digest);
    const replanned = await plan({replan: true, reason: 'Case binds the wrong check'});
    assert.deepEqual({code: replanned.code, sessions: replanned.data?.result?.sessions, calls: f.planner.calls}, {code: 'QA_PLANNED', sessions: 1, calls: 2},
      'qa plan --replan --reason replaces the current plan once');
    assert.match(replanned.data.text, /Case binds the wrong check/u, 'The replan reason is in the command output');
    assert.ok(f.logs.some(line => line.includes('Case binds the wrong check')), 'The replan reason is logged');
  }),

  'qa-plan-wording': async () => {
    const {workerInstructionLines} = await load('packages/cli/src/run-entry.js');
    const {qaPlanningPrompt} = await load('runtime/src/qa/planning.js');
    const prompt = qaPlanningPrompt({baselineCommit: 'a'.repeat(40)});
    assert.doesNotMatch(prompt, /clone of the exact candidate commit|clone holds the candidate/u, 'The planner prompt no longer claims it sees the candidate');
    assert.match(prompt, /clone at DATA\.baselineCommit/u);
    const entry = workerInstructionLines().join('\n');
    assert.doesNotMatch(entry, /gets an independent QA plan after its advisory/u, 'Run instructions no longer plan QA after the advisory');
    assert.match(entry, /first QA run of finalization/u);
  }
};
