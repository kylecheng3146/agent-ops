import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
// A missing capability module is an observable assertion failure on the baseline, not an infrastructure error.
const load = path => import(pathToFileURL(join(build, path)).href).catch(error => {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(join(build, path))) assert.fail(`${path} must be built`);
  throw error;
});
async function need(path, ...names) {
  const mod = await load(path).catch(() => ({}));
  for (const name of names) assert.equal(typeof mod[name], 'function', `${path} must export ${name}`);
  return mod;
}
/** Source guides are read from the checkout under test; an absent guide is an empty one, so its assertions fail. */
const source = async path => await readFile(resolve(path), 'utf8').catch(error => {if (error.code === 'ENOENT') return ''; throw error;});
const at = '2026-11-17T00:00:00.000Z';
const config = {schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: [
  {id: 'tests', command: process.execPath, args: ['test.mjs'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}]},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [], qa: {enabled: true}};
const {qa: _qa, ...off} = config;
const criteria = id => [{id, description: 'Observable behavior', verifierIds: ['tests']},
  {id: 'compatibility', description: 'Legacy behavior stays', verifierIds: ['tests']}];
const scenarios = {initialState: {applies: true, behavior: 'Fresh enrolled delivery'}, redo: {na: 'No replay here'},
  timeBoundary: {na: 'No deadline'}, identitySwitch: {applies: true, behavior: 'QA host differs from the developer'}, concurrency: {na: 'One controller'}};
const planner = {host: 'claude', sessionId: 'qa-planner', implementationSessionId: 'developer', implementationHost: 'codex', writable: false, fallbackReason: null};
const author = {...planner, sessionId: 'qa-author', writable: true};
const usage = {inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null};
const result = (taskId, state, extra = {}) => ({taskId, state, blockers: [], pins: [], plan: null, report: null, attestation: null,
  candidateCommit: 'f'.repeat(40), imported: false, requestedEdits: [], sessions: 1, usage, ...extra});

async function fixture(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-qa-interface-')));
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const gitRunner = {run: async args => {
    try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']})};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0)};}
  }};
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA interface fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(root, 'feature.mjs'), 'export const answer = () => 1;\n');
    git(['add', '.']); git(['commit', '-qm', 'baseline']);
    await mkdir(join(root, '.agent-ops'), {recursive: true});
    await writeFile(join(root, '.agent-ops/config.json'), JSON.stringify(config));
    const {TaskService} = await load('runtime/src/task/service.js');
    const {FileTaskStore} = await load('runtime/src/task/store.js');
    const {FileQaStore} = await load('runtime/src/qa/store.js');
    const {qaPolicyBinding} = await load('runtime/src/qa/policy.js');
    const tasks = new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root);
    let nextId = 0;
    const service = (cfg = config) => new TaskService(tasks, {generateId: () => `task-qa-interface-${++nextId}`, now: () => at, platform: 'darwin',
      completion: {root, gitRunner, loadConfig: async () => structuredClone(cfg)}});
    const binding = qaPolicyBinding(config, at, 'new', false, 'darwin');
    await check({root, git, gitRunner, service, tasks, binding, store: new FileQaStore(join(root, '.git')),
      records: async () => (await tasks.read()).tasks});
  } finally {await rm(root, {recursive: true, force: true});}
}

/** Commit a candidate after the task's creation and seal a PASS for its complete delivery version, as verify would. */
async function sealCandidate(f, task) {
  const {qaDeliveryVersion} = await need('runtime/src/qa/gate.js', 'qaDeliveryVersion');
  const {resolveReviewScope} = await load('runtime/src/review/scope.js');
  const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js');
  await writeFile(join(f.root, 'feature.mjs'), 'export const answer = () => 2;\n');
  f.git(['commit', '-qam', 'candidate']);
  const base = (await f.records()).find(r => r.task.id === task.id).createdSourceCommit;
  const sourceFingerprint = await calculateSourceFingerprint(f.root, await resolveReviewScope({root: f.root, runner: f.gitRunner, base}), f.gitRunner);
  const version = qaDeliveryVersion({tasks: [task], config, candidateCommit: f.git(['rev-parse', 'HEAD']), sourceFingerprint});
  const attestation = await f.store.put('attestation', {schemaVersion: 1, version, plan: {kind: 'plan', digest: 'd'.repeat(64)}, report: {kind: 'report', digest: 'e'.repeat(64)},
    executions: [], decisions: [], materialDigest: 'c'.repeat(64), caseIds: ['case-one'], session: author, generation: 1, sealedAt: at});
  await f.store.updateControl(task.id, 0, () => ({schemaVersion: 1, taskId: task.id, revision: 1, generation: 1, state: 'passed',
    continuation: true, owner: null, plan: null, attempt: null, report: null, attestation, progress: null, updatedAt: at}));
}

export const interfaceChecks = {
  'qa-release-readiness': async () => {
    for (const name of ['a', 'b', 'c']) {
      const text = await source(`tests/qa/live/${name}-evidence.json`);
      assert.ok(text, `Sanitized completed fixture ${name.toUpperCase()} evidence is committed`);
      assert.doesNotMatch(text, /\/(?:Users|private|var|tmp)\/|aoqa-live-|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{20,}/u);
      const evidence = JSON.parse(text);
      assert.equal(evidence.status, 'complete'); assert.equal(evidence.qa.state, 'passed');
      assert.equal(evidence.head, evidence.version.candidateCommit);
      assert.equal(evidence.review.status, 'PASS'); assert.equal(evidence.review.blockingFindings, 0);
      assert.equal(evidence.review.rounds.length, 2);
      assert.ok(evidence.review.rounds.every(r => r.status === 'PASS' && r.sessionId));
      assert.notEqual(evidence.review.rounds[0].sessionId, evidence.review.rounds[1].sessionId);
      assert.ok(evidence.verify.length > 0 && evidence.verify.every(v => v.status === 'PASS' && v.testCount > 0));
      for (const c of evidence.qa.cases.filter(c => c.required && c.mode !== 'nonmechanical'))
        assert.equal(evidence.qa.results.find(r => r.caseId === c.id)?.status, 'PASS', `${name} required mechanical ${c.id}`);
      assert.ok(evidence.qa.executions.every(e => e.completed && e.diagnostics === 0));
    }
    const pkg = JSON.parse(await source('package.json')), lock = JSON.parse(await source('package-lock.json'));
    assert.equal(pkg.version, lock.version); assert.equal(pkg.version, lock.packages[''].version);
    assert.ok((await source('README.md')).includes(`source release is version ${pkg.version}`));
    assert.ok((await source('CHANGELOG.md')).includes(`## [${pkg.version}]`));
    const {contained} = await import(pathToFileURL(resolve('tests/qa/live/browser.mjs')).href);
    const root = join(tmpdir(), 'qa-root');
    assert.equal(contained(root, join(root, 'nested', 'page.html')), true);
    assert.equal(contained(root, join(`${root}-sibling`, 'page.html')), false, 'A string-prefix sibling is outside the root');
    assert.equal(contained(root, join(root, '..', 'outside')), false);
  },
  'qa-independent-runner': async () => {
    const runner = await source('tests/qa/acceptance.mjs');
    assert.ok(runner.includes('tests/qa/independent'), 'A generic committed collector accepts new independent material');
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-qa-collector-'));
    const material = join(root, 'tests/qa/independent');
    const execute = ids => {
      const env = {...process.env, AGENT_OPS_ACCEPTANCE_CHECKS: ids, AGENT_OPS_ACCEPTANCE_EXECUTION_ID: 'collector-test', AGENT_OPS_ACCEPTANCE_PHASE: 'baseline'};
      try {return {code: 0, report: JSON.parse(execFileSync(process.execPath, ['runner.mjs'], {cwd: root, env, encoding: 'utf8'}))};}
      catch (error) {return {code: error.status, report: JSON.parse(error.stdout)};}
    };
    try {
      await mkdir(material, {recursive: true}); await writeFile(join(root, 'runner.mjs'), runner);
      await writeFile(join(material, 'new.check.mjs'), `import assert from 'node:assert/strict'; export const checks = {'new-check': () => assert.equal(1, 1), 'red-check': () => assert.equal(1, 2)};`);
      const pass = execute('new-check'); assert.equal(pass.code, 0); assert.equal(pass.report.results[0].status, 'PASS');
      assert.equal(pass.report.results[0].phase, 'baseline'); assert.equal(pass.report.results[0].executionId, 'collector-test');
      assert.equal(execute('red-check').report.results[0].failureClass, 'assertion-failed');
      const absent = execute('missing'); assert.equal(absent.code, 1); assert.equal(absent.report.results[0].failureClass, 'missing-check');
      await writeFile(join(material, 'duplicate.check.mjs'), `export const checks = {'new-check': () => {}};`);
      assert.equal(execute('new-check').code, 1, 'Duplicate ids cannot hide behind one passing function');
      await writeFile(join(material, 'duplicate.check.mjs'), `throw new Error('broken import');`);
      assert.equal(execute('new-check').code, 1, 'Collection errors cannot pass');
    } finally {await rm(root, {recursive: true, force: true});}
  },
  'qa-default-on': async () => {
    const {createInstallPlan} = await need('runtime/src/install/plan.js', 'createInstallPlan');
    const {commonHarnessAdapters} = await load('runtime/src/install/harness.js');
    const {applyInstallPlan} = await load('runtime/src/install/apply.js');
    const {createUpdatePlan} = await load('runtime/src/install/update.js');
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-qa-default-'));
    const install = extra => createInstallPlan({root, scope: 'project', platform: 'darwin', harness: ['claude'], profiles: ['core'],
      adapters: commonHarnessAdapters(), toolkitVersion: '1.3.1', ...extra});
    try {
      const fresh = await install({});
      assert.deepEqual(fresh.config.qa, {enabled: true}, 'Supported project init defaults QA ON');
      assert.equal((await install({platform: 'linux'})).config.qa, undefined, 'Unsupported platforms keep opt-in compatibility');
      assert.equal((await install({scope: 'user'})).config.qa, undefined, 'User defaults cannot enroll projects');
      const disabled = await install({qaEnabled: false});
      assert.deepEqual(disabled.config.qa, {enabled: false}, 'An explicit OFF must survive later default-ON updates');
      await applyInstallPlan(root, disabled);
      const kept = await createUpdatePlan({root, adapters: commonHarnessAdapters(), targetVersion: '1.3.1', toolkitVersion: '1.3.1'});
      assert.deepEqual(kept.installation.config.qa, {enabled: false});
      const enabled = await createUpdatePlan({root, adapters: commonHarnessAdapters(), targetVersion: '1.3.1', toolkitVersion: '1.3.1', qaEnabled: true});
      assert.deepEqual(enabled.installation.config.qa, {enabled: true});
    } finally {await rm(root, {recursive: true, force: true});}
  },
  'qa-cli-commands': () => fixture(async f => {
    const {runQaCommand} = await need('packages/cli/src/commands/qa.js', 'runQaCommand');
    const {parseArgs} = await need('packages/cli/src/args.js', 'parseArgs');
    const {HELP_TEXT, COMMAND_HELP_TEXT} = await load('packages/cli/src/cli.js');
    const {qaDeliveryTree, qaDeliveryVersion} = await need('runtime/src/qa/gate.js', 'qaDeliveryTree', 'qaDeliveryVersion');
    const {createRunState, FileRunRepository} = await load('runtime/src/run/service.js');
    // Routing and validation consistent with the rest of the CLI.
    assert.deepEqual(parseArgs(['qa', 'show', '--task', 't-1', '--json']), {command: 'qa', action: 'show', taskId: 't-1', profiles: [], dryRun: false, json: true, yes: false, rerun: false});
    assert.equal(parseArgs(['qa', 'plan', '--task', 't-1', '--yes']).action, 'plan');
    assert.equal(parseArgs(['qa', 'run', '--task', 't-1', '--yes', '--base', 'main']).base, 'main');
    assert.deepEqual((({questionId, answer}) => ({questionId, answer}))(parseArgs(['qa', 'respond', '--task', 't-1', '--question', 'q-1', '--answer', 'de-DE'])),
      {questionId: 'q-1', answer: 'de-DE'});
    assert.equal(parseArgs(['qa', 'stop', '--task', 't-1']).action, 'stop');
    for (const [argv, code] of [[['qa'], 'CLI_ACTION_REQUIRED'], [['qa', 'show'], 'CLI_MISSING_VALUE'], [['qa', 'plan', '--task', 't-1'], 'CLI_OPTION_NOT_ALLOWED'],
      [['qa', 'run', '--task', 't-1'], 'CLI_OPTION_NOT_ALLOWED'], [['qa', 'show', '--task', 't-1', '--yes'], 'CLI_OPTION_NOT_ALLOWED'],
      [['qa', 'respond', '--task', 't-1', '--question', 'q-1'], 'CLI_MISSING_VALUE'], [['qa', 'stop', '--task', 't-1', '--answer', 'x'], 'CLI_MISSING_VALUE'],
      [['qa', 'stop', '--task', 't-1', '--base', 'main'], 'CLI_OPTION_NOT_ALLOWED'], [['qa', 'show', '--task', 't-1', '--wat'], 'CLI_UNKNOWN_OPTION']])
      assert.throws(() => parseArgs(argv), {code}, argv.join(' '));
    assert.deepEqual((({command, helpTopic}) => ({command, helpTopic}))(parseArgs(['qa', 'run', '--help'])), {command: 'help', helpTopic: 'qa'});
    assert.match(HELP_TEXT, /qa <plan\|run\|show\|respond\|stop>/u);
    for (const part of ['qa plan --task <id> --yes', 'qa run --task <id> --yes', 'qa show --task <id>', 'qa respond --task <id> --question <id> --answer <text>',
      'qa stop --task <id>', 'QA_NATIVE_OWNED', 'macOS', 'UNKNOWN', 'late']) assert.ok(COMMAND_HELP_TEXT.qa?.includes(part), `qa help names ${part}`);

    const legacy = await f.service().create({title: 'Legacy', criteria: criteria('legacy'), qaBinding: null});
    const enrolled = await f.service().create({title: 'Enrolled', criteria: criteria('observable'), qaBinding: f.binding});
    const child = await f.service().create({title: 'Child', criteria: criteria('child'), parentTaskId: enrolled.task.id});
    const delivered = [], adopted = [];
    let next = null;
    const options = (args, extra = {}) => ({args: {profiles: [], dryRun: false, json: true, yes: false, rerun: false, command: 'qa', ...args}, root: f.root,
      deliver: async input => {delivered.push(input); return next;}, adopt: async (id, hash, reason) => {adopted.push(id);
        return await f.service().adoptQa(id, {expectedContractHash: hash, reason});},
      loadConfig: async () => structuredClone(config), fingerprint: async () => 'a'.repeat(64), inRun: false, now: () => at, ...extra});
    // show never starts a model, host or runner; a legacy task reads not enrolled, never PASS.
    const shown = await runQaCommand(options({action: 'show', taskId: legacy.task.id}));
    assert.equal(shown.status, 'ok'); assert.equal(shown.data.status.state, 'not-enrolled'); assert.equal(shown.data.status.outcome, 'NOT_REQUIRED');
    assert.match(shown.data.text, /not enrolled/u); assert.doesNotMatch(shown.data.text, /· PASS/u);
    const pending = await runQaCommand(options({action: 'show', taskId: child.task.id}));
    assert.deepEqual([pending.data.status.rootTaskId, pending.data.status.state, pending.data.status.outcome], [enrolled.task.id, 'not-started', 'PENDING']);
    assert.deepEqual([delivered.length, adopted.length], [0, 0], 'show spends no model call');
    // respond binds a genuine answer to a question QA asked; a run agent may only relay it.
    const records = await f.records();
    const version = qaDeliveryVersion({tasks: qaDeliveryTree(records, enrolled.task.id).map(r => r.task), config, candidateCommit: f.git(['rev-parse', 'HEAD']),
      sourceFingerprint: 'a'.repeat(64)});
    const plan = await f.store.put('plan', {schemaVersion: 1, id: 'plan-1', version, originalGoal: 'Enrolled', taskIds: [enrolled.task.id, child.task.id],
      dependencyTaskIds: [], scope: 'full', session: planner, createdAt: at, timing: 'early', advisoryReferences: [],
      cases: [{id: 'case-guide', criterionIds: ['observable'], surfaceIds: [], required: true, mode: 'nonmechanical', preconditions: [], actions: ['Read the guide'],
        expected: 'Accurate', bindings: [], nonmechanicalReason: 'Prose accuracy needs judgment'}], scenarios,
      environment: [{name: 'browser', required: true, status: 'missing', evidence: ['No authorized browser tool']}],
      questions: [{id: 'q-locale', prompt: 'Which locale is required?', required: true, criterionIds: ['observable']}]});
    await f.store.updateControl(enrolled.task.id, 0, () => ({schemaVersion: 1, taskId: enrolled.task.id, revision: 1, generation: 1, state: 'awaiting-input',
      continuation: true, owner: null, plan, attempt: null, report: null, attestation: null, progress: null, updatedAt: at}));
    const waiting = await runQaCommand(options({action: 'show', taskId: enrolled.task.id}));
    assert.deepEqual(waiting.data.status.blockers, ['environment:browser', 'question:q-locale']);
    assert.match(waiting.data.text, /Which locale is required\?/u);
    const relayed = await runQaCommand(options({action: 'respond', taskId: enrolled.task.id, questionId: 'q-locale', answer: 'de-DE'}, {inRun: true}));
    assert.equal(relayed.code, 'QA_ANSWER_NOT_HUMAN');
    const answered = await runQaCommand(options({action: 'respond', taskId: enrolled.task.id, questionId: 'q-locale', answer: 'de-DE'}));
    assert.equal(answered.code, 'QA_ANSWER_RECORDED');
    assert.equal((await f.store.readControl(enrolled.task.id)).state, 'plan-ready');
    assert.equal((await runQaCommand(options({action: 'respond', taskId: enrolled.task.id, questionId: 'q-invented', answer: 'yes'}))).code, 'QA_QUESTION_UNKNOWN');
    // run on an enrolled delivery reports the real QA state; a failure is never a PASS.
    next = result(enrolled.task.id, 'awaiting-repair', {blockers: ['finding:f-1'], pins: [`qa:${'b'.repeat(64)}:0`]});
    const repair = await runQaCommand(options({action: 'run', taskId: enrolled.task.id, yes: true, base: 'main'}));
    assert.equal(repair.status, 'error'); assert.equal(repair.code, 'QA_REPAIR_REQUIRED');
    assert.match(repair.errors[0].message, /task pin-finding/u);
    assert.deepEqual((({taskId, explicit, base}) => ({taskId, explicit, base}))(delivered.at(-1)), {taskId: enrolled.task.id, explicit: true, base: 'main'});
    // Ordinary stop fences the owner and keeps continuation off.
    const stopped = await runQaCommand(options({action: 'stop', taskId: enrolled.task.id}));
    assert.equal(stopped.code, 'QA_STOPPED');
    assert.deepEqual([(await f.store.readControl(enrolled.task.id)).state, (await f.store.readControl(enrolled.task.id)).continuation], ['stopped', false]);
    assert.ok((await runQaCommand(options({action: 'show', taskId: enrolled.task.id}))).data.status.blockers.includes('stopped'));
    // run on a legacy task is refused; plan adopts it explicitly and marks the late plan.
    assert.equal((await runQaCommand(options({action: 'run', taskId: legacy.task.id, yes: true}))).code, 'QA_NOT_ENROLLED');
    const legacyChild = await f.service().create({title: 'Legacy child', criteria: criteria('legacy-child'), parentTaskId: legacy.task.id});
    assert.equal((await runQaCommand(options({action: 'plan', taskId: legacyChild.task.id, yes: true}))).code, 'QA_DELIVERY_ROOT_REQUIRED');
    const calls = delivered.length;
    await writeFile(join(f.root, 'feature.mjs'), 'export const answer = () => 2;\n'); f.git(['commit', '-qam', 'implementation started']);
    next = result(legacy.task.id, 'plan-ready');
    const planned = await runQaCommand(options({action: 'plan', taskId: legacy.task.id, yes: true}));
    assert.equal(planned.code, 'QA_PLANNED');
    assert.deepEqual(adopted, [legacy.task.id]);
    const adoptedRecord = (await f.records()).find(r => r.task.id === legacy.task.id);
    assert.deepEqual([adoptedRecord.task.qa.enrollment, adoptedRecord.task.qa.late], ['adopted', true], 'Adoption after implementation is marked late');
    assert.deepEqual((({planOnly, timing, explicit}) => ({planOnly, timing, explicit}))(delivered[calls]), {planOnly: true, timing: 'late', explicit: true});
    // A native run owns its delivery's QA: no competing controller, only run controls.
    const native = await f.service().create({title: 'Native', criteria: criteria('native'), qaBinding: f.binding});
    const commonDir = join(f.root, '.git');
    const run = createRunState({root: f.root, commonDir, targetBranch: 'main', goal: 'Native goal', host: 'claude', ownerSessionId: 'owner', rootTaskId: native.task.id});
    await new FileRunRepository(join(commonDir, 'agent-ops/runs'), commonDir).create(run);
    const before = delivered.length;
    for (const action of ['plan', 'run', 'stop']) {
      const refused = await runQaCommand(options({action, taskId: native.task.id, yes: action !== 'stop'}));
      assert.equal(refused.code, 'QA_NATIVE_OWNED', action);
      assert.match(refused.errors[0].message, new RegExp(`agent-ops run stop ${run.runId}`, 'u'));
    }
    assert.equal(delivered.length, before, 'Native-owned QA starts no second controller');
    assert.equal((await runQaCommand(options({action: 'show', taskId: native.task.id}))).status, 'ok');
  }),
  'qa-setup-optin': async () => {
    const {createInstallPlan} = await need('runtime/src/install/plan.js', 'createInstallPlan');
    const {parseArgs} = await need('packages/cli/src/args.js', 'parseArgs');
    assert.doesNotThrow(() => parseArgs(['init', '--qa', 'on']), 'init accepts --qa on');
    assert.equal(parseArgs(['init', '--qa', 'on']).qa, 'on');
    assert.equal(parseArgs(['update', '--qa', 'off']).qa, 'off');
    for (const argv of [['init', '--qa', 'maybe'], ['init', '--qa', 'on', '--scope', 'user'], ['verify', '--qa', 'on'], ['update', '--qa', 'on', '--qa', 'off']])
      assert.throws(() => parseArgs(argv), error => error.name === 'CliArgumentError', argv.join(' '));
    const {applyInstallPlan} = await load('runtime/src/install/apply.js');
    const {commonHarnessAdapters} = await load('runtime/src/install/harness.js');
    const {createUpdatePlan} = await load('runtime/src/install/update.js');
    const {formatInstallPlan} = await load('packages/cli/src/commands/init.js');
    const {formatUpdatePlan} = await load('packages/cli/src/commands/update.js');
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-qa-setup-'));
    const rules = plan => plan.operations.find(op => op.path === '.agent-ops/CLAUDE.md')?.content ?? '';
    const install = extra => createInstallPlan({root, scope: 'project', harness: ['claude'], profiles: ['core'], adapters: commonHarnessAdapters(),
      toolkitVersion: '1.3.0', ...extra});
    const update = extra => createUpdatePlan({root, adapters: commonHarnessAdapters(), targetVersion: '1.3.0', toolkitVersion: '1.3.0', ...extra});
    try {
      const fresh = await install({});
      assert.deepEqual(fresh.config.qa, process.platform === 'darwin' ? {enabled: true} : undefined);
      assert.match(formatInstallPlan(fresh), process.platform === 'darwin' ? /Independent QA: enabled/u : /Independent QA: disabled/u);
      const enabled = await install({qaEnabled: true});
      assert.deepEqual(enabled.config.qa, {enabled: true});
      assert.match(formatInstallPlan(enabled), /Independent QA: enabled for new delivery tasks \(macOS only/u);
      assert.match(rules(enabled), /independent-qa/u);
      assert.match(rules(enabled), /agent-ops qa respond --task <id> --question <id> --answer <text>/u);
      await applyInstallPlan(root, enabled);
      // Update preserves the explicit choice; off changes only enrollment of future delivery roots.
      const kept = await update({});
      assert.deepEqual(kept.installation.config.qa, {enabled: true});
      assert.match(formatUpdatePlan(kept), /Independent QA: enabled/u);
      const disabled = await update({qaEnabled: false});
      assert.deepEqual(disabled.installation.config.qa, {enabled: false});
      assert.match(formatUpdatePlan(disabled), /Independent QA: disabled/u);
      assert.doesNotMatch(rules(disabled.installation), /Independent QA/u);
    } finally {await rm(root, {recursive: true, force: true});}
    // Turning QA off never removes an enrolled task's gate; new tasks default to no enrollment.
    await fixture(async f => {
      const {checkQaDeliveryEvidence} = await load('runtime/src/qa/gate.js');
      const enrolled = await f.service().create({title: 'Enrolled', criteria: criteria('observable')});
      assert.ok(enrolled.task.qa !== undefined, 'An opted-in project enrolls new delivery roots');
      await writeFile(join(f.root, '.agent-ops/config.json'), JSON.stringify(off));
      const later = await f.service(off).create({title: 'After off', criteria: criteria('later')});
      assert.equal(later.task.qa, undefined, 'Off: new tasks are not enrolled');
      for (const platform of ['darwin', 'linux']) {
        const problem = await checkQaDeliveryEvidence(enrolled, {root: f.root, config: off, sourceFingerprint: 'a'.repeat(64), platform});
        assert.equal(problem?.status, 'FAIL', `The enrolled gate stays required on ${platform}`);
      }
      assert.equal(await checkQaDeliveryEvidence(later, {root: f.root, config: off, sourceFingerprint: 'a'.repeat(64)}), null);
    });
  },
  'qa-status-office': () => fixture(async f => {
    const {qaStatus, renderQaStatus} = await need('runtime/src/qa/status.js', 'qaStatus', 'renderQaStatus');
    const {buildOfficeSnapshot, shownQa} = await need('runtime/src/office/snapshot.js', 'buildOfficeSnapshot', 'shownQa');
    const {runTaskCommand} = await load('packages/cli/src/commands/task.js');
    const {officePage} = await load('runtime/src/office/page.js');
    const legacy = await f.service().create({title: 'Legacy', criteria: criteria('legacy'), qaBinding: null});
    const enrolled = await f.service().create({title: 'Enrolled', criteria: criteria('observable'), qaBinding: f.binding});
    const current = {root: f.root, gitRunner: f.gitRunner, loadConfig: async () => structuredClone(config)};
    const notEnrolled = await qaStatus(f.store, await f.records(), legacy.task.id, current);
    assert.deepEqual([notEnrolled.state, notEnrolled.outcome, notEnrolled.rootTaskId], ['not-enrolled', 'NOT_REQUIRED', null]);
    assert.match(renderQaStatus(notEnrolled, legacy.task.id), /not enrolled \(not required; this is not a QA PASS\)/u);
    // task status/JSON carry the QA summary next to (never instead of) verify coverage.
    const status = await runTaskCommand({args: {command: 'task', action: 'status', taskId: legacy.task.id, profiles: [], dryRun: false, json: true, yes: false, rerun: false},
      service: f.service(), qaStatus: async (record, records) => await qaStatus(f.store, records, record.task.id, current)});
    assert.equal(status.data.qa.state, 'not-enrolled');
    assert.match(status.data.text, /Independent QA: not enrolled/u); assert.match(status.data.text, /Acceptance: /u);
    // A sealed PASS is PASS only for the version it names; another HEAD makes it STALE; a finished delivery keeps it as history.
    await sealCandidate(f, enrolled.task);
    assert.equal((await qaStatus(f.store, await f.records(), enrolled.task.id, current)).outcome, 'PASS');
    f.git(['commit', '-q', '--allow-empty', '-m', 'another candidate']);
    assert.equal((await qaStatus(f.store, await f.records(), enrolled.task.id, current)).outcome, 'STALE');
    assert.equal((await qaStatus(f.store, await f.records(), enrolled.task.id, null)).outcome, 'STALE', 'An uncomputable version is never PASS');
    const finished = (await f.records()).map(r => r.task.id === enrolled.task.id ? {...r, status: 'complete'} : r);
    const history = await qaStatus(f.store, finished, enrolled.task.id, current);
    assert.deepEqual([history.outcome, history.historical], ['PASS', true]);
    // Live: a killed QA session left its owner record; status said "writer live" for a process that no longer existed.
    let saved = await f.store.readControl(enrolled.task.id);
    const owner = {controllerId: 'qa-controller', session: {host: 'codex', sessionId: 'qa-writer', implementationSessionId: 'dev', implementationHost: 'claude',
      writable: true, fallbackReason: null}, processId: 4242, processIdentity: 'started-earlier'};
    saved = await f.store.updateControl(enrolled.task.id, saved.revision, c => ({...c, revision: c.revision + 1, state: 'testing', owner}));
    const probe = alive => ({identity: async () => alive ? 'started-earlier' : null, groupAlive: () => alive, signalGroup: async () => {}});
    const exited = await qaStatus(f.store, await f.records(), enrolled.task.id, current, probe(false));
    assert.deepEqual({live: exited.live, writer: exited.writer, blocked: exited.blockers.includes('writer:exited')}, {live: false, writer: 'exited', blocked: true});
    assert.match(renderQaStatus(exited, enrolled.task.id), /writer exited/u); assert.doesNotMatch(renderQaStatus(exited, enrolled.task.id), /writer live/u);
    const running = await qaStatus(f.store, await f.records(), enrolled.task.id, current, probe(true));
    assert.deepEqual({live: running.live, writer: running.writer}, {live: true, writer: 'live'});
    await f.store.updateControl(enrolled.task.id, saved.revision, c => ({...c, revision: c.revision + 1, state: 'passed', owner: null}));
    // Office: live QA always shows; an inactive or halted QA state retires after the window, leaving its records alone.
    const now = Date.parse(at) + 3 * 60 * 60 * 1000;
    const live = {...notEnrolled, rootTaskId: 'task-live', state: 'testing', outcome: 'PENDING', live: true, updatedAt: at};
    const halted = {...live, rootTaskId: 'task-halted', state: 'stopped', live: false, blockers: ['stopped']};
    const recent = {...halted, rootTaskId: 'task-recent', updatedAt: new Date(now - 60_000).toISOString()};
    assert.deepEqual(shownQa(halted, now), {}); assert.deepEqual(shownQa(live, now), {qa: live}); assert.deepEqual(shownQa(recent, now), {qa: recent});
    const diff = {files: 0, insertions: 0, deletions: 0, paths: [], recent: null};
    const desk = (name, qa) => ({name, path: `/w/${name}`, branch: name, sessionId: `s-${name}`, diff, status: 'active', taskId: qa.rootTaskId, qa});
    const snapshot = buildOfficeSnapshot({runs: [], worktrees: [desk('live', live), desk('halted', halted), desk('legacy', notEnrolled)], reviews: [], now});
    assert.deepEqual(snapshot.lobby.map(d => [d.name, d.qa?.state ?? null]), [['live', 'testing'], ['halted', null], ['legacy', 'not-enrolled']]);
    assert.ok(await f.store.readControl(enrolled.task.id), 'Retirement drops a view, never a durable QA record');
    const page = officePage('nonce');
    for (const label of ['Independent QA', '獨立 QA', 'not enrolled (not required)', '未加入（不需要）', 'agent-ops qa show --task '])
      assert.ok(page.includes(label), `Office labels independent QA apart from verify: ${label}`);
  }),
  // Active status compares the complete delivery version the gate uses: HEAD alone cannot hide dirty source or changed config.
  'qa-status-freshness': () => fixture(async f => {
    const {qaStatus} = await need('runtime/src/qa/status.js', 'qaStatus');
    const {runQaCommand} = await need('packages/cli/src/commands/qa.js', 'runQaCommand');
    const {collectOfficeInput} = await need('runtime/src/office/collect.js', 'collectOfficeInput');
    const {recordOfficeSession} = await need('runtime/src/office/sessions.js', 'recordOfficeSession');
    const enrolled = await f.service().create({title: 'Enrolled', criteria: criteria('observable'), qaBinding: f.binding});
    await sealCandidate(f, enrolled.task);
    const commonDir = join(f.root, '.git'), configPath = join(f.root, '.agent-ops/config.json');
    await recordOfficeSession({commonDir, projectRoot: f.root, sessionId: 'qa-fresh', harness: 'claude', event: 'start', taskId: enrolled.task.id, now: Date.parse(at)});
    let spent = 0;
    const spend = async () => {spent++; return null;};
    const loadConfig = async () => JSON.parse(await readFile(configPath, 'utf8'));
    const outcomes = async (records = undefined) => {
      const status = await qaStatus(f.store, records ?? await f.records(), enrolled.task.id, {root: f.root, gitRunner: f.gitRunner, loadConfig});
      if (records !== undefined) return [status.outcome, status.historical];
      const shown = await runQaCommand({args: {command: 'qa', action: 'show', taskId: enrolled.task.id, profiles: [], dryRun: false, json: true, yes: false, rerun: false},
        root: f.root, deliver: spend, adopt: spend, loadConfig, fingerprint: async () => {spent++; return 'a'.repeat(64);}, inRun: false, now: () => at});
      const office = await collectOfficeInput(f.root, commonDir, undefined, Date.parse(at), loadConfig);
      return [status.outcome, shown.data.status.outcome, office.sessions.find(s => s.sessionId === 'qa-fresh')?.qa?.outcome];
    };
    assert.deepEqual(await outcomes(), ['PASS', 'PASS', 'PASS'], 'The unchanged sealed candidate stays PASS everywhere');
    await writeFile(join(f.root, 'feature.mjs'), 'export const answer = () => 3;\n');
    assert.deepEqual(await outcomes(), ['STALE', 'STALE', 'STALE'], 'Dirty source at the same HEAD is never PASS');
    f.git(['checkout', '--', 'feature.mjs']);
    assert.deepEqual(await outcomes(), ['PASS', 'PASS', 'PASS']);
    const saved = await readFile(configPath, 'utf8');
    // Only config that changes how QA executes binds it: verification commands do not, acceptance runners do.
    await writeFile(configPath, JSON.stringify({...config, verification: {...config.verification, commands: [{...config.verification.commands[0], args: ['other.mjs']}]}}));
    assert.equal(f.git(['status', '--porcelain']), '', 'Config lives outside tracked source, so HEAD and source are unchanged');
    assert.deepEqual(await outcomes(), ['PASS', 'PASS', 'PASS'], 'Config QA does not execute keeps the seal');
    await writeFile(configPath, JSON.stringify({...config, verification: {...config.verification, acceptanceRunners: [
      {id: 'independent-qa', command: 'node', args: ['other.mjs'], cwd: '.', adapter: 'generic'}]}}));
    assert.deepEqual(await outcomes(), ['STALE', 'STALE', 'STALE'], 'Changed QA runner config at the same HEAD is never PASS');
    await writeFile(configPath, saved);
    assert.deepEqual(await outcomes(), ['PASS', 'PASS', 'PASS']);
    // A finished delivery keeps the proof it finished with, even after the checkout moves on.
    await writeFile(join(f.root, 'feature.mjs'), 'export const answer = () => 4;\n');
    const finished = (await f.records()).map(r => r.task.id === enrolled.task.id ? {...r, status: 'complete'} : r);
    assert.deepEqual(await outcomes(finished), ['PASS', true]);
    assert.equal(spent, 0, 'Status, show and Office start no model, host or runner');
  }),
  'qa-managed-guides': async () => {
    const {COMMAND_HELP_TEXT} = await load('packages/cli/src/cli.js');
    assert.ok(COMMAND_HELP_TEXT.qa, 'CLI help documents qa');
    const en = await source('docs/en/guides/qa.md'), zh = await source('docs/zh-TW/guides/qa.md');
    for (const [name, guide] of [['EN', en], ['zh-TW', zh]]) {
      for (const part of ['--qa on', '--qa off', 'macOS', 'qa plan --task', 'qa run --task', 'qa show --task', 'qa respond --task', 'qa stop --task',
        'run stop', 'task pin-finding', 'QA_REPAIR_REQUIRED', 'QA_AWAITING_INPUT', 'QA_UNSUPPORTED_PLATFORM', 'UNKNOWN', 'verify --task'])
        assert.ok(guide.includes(part), `${name} QA guide covers ${part}`);
    }
    for (const term of [/defaults ON/iu, /separate session/iu, /isolated clone/iu, /late/iu, /older CLI/iu, /cost/iu, /no total/iu, /never a QA PASS/iu])
      assert.match(en, term);
    for (const term of ['預設開啟', '獨立', '隔離', '晚', '舊版', '費用', '不是 QA PASS']) assert.ok(zh.includes(term), `zh-TW QA guide: ${term}`);
    const readme = await source('README.md');
    assert.ok(readme.includes('docs/en/guides/qa.md') && readme.includes('--qa on'), 'README points at the QA guide');
    for (const [path, part] of [['docs/en/guides/configuration.md', '"qa"'], ['docs/zh-TW/guides/configuration.md', '"qa"'],
      ['docs/en/guides/compatibility.md', 'QA'], ['docs/zh-TW/guides/compatibility.md', 'QA'],
      ['docs/en/spec/acceptance-and-evidence.md', 'independent QA'], ['docs/zh-TW/spec/acceptance-and-evidence.md', '獨立 QA'],
      ['docs/en/spec/review.md', 'qa-proof'], ['docs/zh-TW/spec/review.md', 'qa-proof']])
      assert.ok((await source(path)).includes(part), `${path} covers QA (${part})`);
    for (const path of ['docs/en/guides/compatibility.md', 'docs/zh-TW/guides/compatibility.md'])
      assert.match(await source(path), /qa|QA/u);
    assert.match(await source('docs/en/guides/compatibility.md'), /older CLI[\s\S]{0,60}may reject/iu, 'Downgrade honesty is documented');
  }
};
