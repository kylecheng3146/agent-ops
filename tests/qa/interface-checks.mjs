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

export const interfaceChecks = {
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
    assert.equal((await runQaCommand(options({action: 'respond', taskId: enrolled.task.id, questionId: 'q-invented', answer: 'yes'}))).code, 'QA_NOT_AWAITING_INPUT');
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
      assert.equal(fresh.config.qa, undefined, 'QA defaults OFF: no field, no spending, legacy hashes unchanged');
      assert.doesNotMatch(rules(fresh), /Independent QA/u);
      assert.match(formatInstallPlan(fresh), /Independent QA: disabled/u);
      const enabled = await install({qaEnabled: true});
      assert.deepEqual(enabled.config.qa, {enabled: true});
      assert.match(formatInstallPlan(enabled), /Independent QA: enabled for new delivery tasks \(macOS only/u);
      assert.match(rules(enabled), /independent-qa/u);
      assert.match(rules(enabled), /agent-ops qa respond --task <id> --question <id> --answer <text>/u);
      await applyInstallPlan(root, enabled);
      // update preserves the explicit choice unless told otherwise; off removes only the project default.
      const kept = await update({});
      assert.deepEqual(kept.installation.config.qa, {enabled: true});
      assert.match(formatUpdatePlan(kept), /Independent QA: enabled/u);
      const disabled = await update({qaEnabled: false});
      assert.equal(disabled.installation.config.qa, undefined);
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
    const {qaDeliveryVersion} = await load('runtime/src/qa/gate.js');
    const legacy = await f.service().create({title: 'Legacy', criteria: criteria('legacy'), qaBinding: null});
    const enrolled = await f.service().create({title: 'Enrolled', criteria: criteria('observable'), qaBinding: f.binding});
    const head = f.git(['rev-parse', 'HEAD']);
    const notEnrolled = await qaStatus(f.store, await f.records(), legacy.task.id, head);
    assert.deepEqual([notEnrolled.state, notEnrolled.outcome, notEnrolled.rootTaskId], ['not-enrolled', 'NOT_REQUIRED', null]);
    assert.match(renderQaStatus(notEnrolled, legacy.task.id), /not enrolled \(not required; this is not a QA PASS\)/u);
    // task status/JSON carry the QA summary next to (never instead of) verify coverage.
    const status = await runTaskCommand({args: {command: 'task', action: 'status', taskId: legacy.task.id, profiles: [], dryRun: false, json: true, yes: false, rerun: false},
      service: f.service(), qaStatus: async (record, records) => await qaStatus(f.store, records, record.task.id, head)});
    assert.equal(status.data.qa.state, 'not-enrolled');
    assert.match(status.data.text, /Independent QA: not enrolled/u); assert.match(status.data.text, /Acceptance: /u);
    // A sealed PASS is PASS only for the candidate it names; another HEAD makes it STALE; a finished delivery keeps it as history.
    const version = qaDeliveryVersion({tasks: [enrolled.task], config, candidateCommit: head, sourceFingerprint: 'a'.repeat(64)});
    const attestation = await f.store.put('attestation', {schemaVersion: 1, version, plan: {kind: 'plan', digest: 'd'.repeat(64)}, report: {kind: 'report', digest: 'e'.repeat(64)},
      executions: [], decisions: [], materialDigest: 'c'.repeat(64), caseIds: ['case-one'], session: author, generation: 1, sealedAt: at});
    await f.store.updateControl(enrolled.task.id, 0, () => ({schemaVersion: 1, taskId: enrolled.task.id, revision: 1, generation: 1, state: 'passed',
      continuation: true, owner: null, plan: null, attempt: null, report: null, attestation, progress: null, updatedAt: at}));
    assert.equal((await qaStatus(f.store, await f.records(), enrolled.task.id, head)).outcome, 'PASS');
    assert.equal((await qaStatus(f.store, await f.records(), enrolled.task.id, '0'.repeat(40))).outcome, 'STALE');
    const finished = (await f.records()).map(r => r.task.id === enrolled.task.id ? {...r, status: 'complete'} : r);
    const history = await qaStatus(f.store, finished, enrolled.task.id, '0'.repeat(40));
    assert.deepEqual([history.outcome, history.historical], ['PASS', true]);
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
  'qa-managed-guides': async () => {
    const {COMMAND_HELP_TEXT} = await load('packages/cli/src/cli.js');
    assert.ok(COMMAND_HELP_TEXT.qa, 'CLI help documents qa');
    const en = await source('docs/en/guides/qa.md'), zh = await source('docs/zh-TW/guides/qa.md');
    for (const [name, guide] of [['EN', en], ['zh-TW', zh]]) {
      for (const part of ['--qa on', '--qa off', 'macOS', 'qa plan --task', 'qa run --task', 'qa show --task', 'qa respond --task', 'qa stop --task',
        'run stop', 'task pin-finding', 'QA_REPAIR_REQUIRED', 'QA_AWAITING_INPUT', 'QA_UNSUPPORTED_PLATFORM', 'UNKNOWN', 'verify --task'])
        assert.ok(guide.includes(part), `${name} QA guide covers ${part}`);
    }
    for (const term of [/opt-in/iu, /separate session/iu, /isolated clone/iu, /late/iu, /older CLI/iu, /cost/iu, /no total/iu, /never a QA PASS/iu])
      assert.match(en, term);
    for (const term of ['預設關閉', '獨立', '隔離', '晚', '舊版', '費用', '不是 QA PASS']) assert.ok(zh.includes(term), `zh-TW QA guide: ${term}`);
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
