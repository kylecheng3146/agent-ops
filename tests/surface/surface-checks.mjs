import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// EVIDENCE-SURFACE-001 acceptance. Modules load lazily so a build without the
// surface audit fails each check as an assertion, never as a crashed runner.
const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const load = async path => {
  try {return await import(pathToFileURL(join(build, path)).href);}
  catch (e) {assert.fail(`${path} is unavailable: ${e.code ?? e.message}`);}
};

const NA = reason => ({na: reason});
const SCENARIOS = {
  initialState: NA('Fixture has no persisted state to start from.'),
  redo: NA('Fixture operations are never retried or redelivered.'),
  timeBoundary: NA('Fixture has no dates, TTLs or timezones.'),
  identitySwitch: NA('Fixture has no stores, roles or tenants.'),
  concurrency: NA('Fixture runs one writer at a time.')
};
function audit({included, excluded = [], unknown = [], queries = {}, scenarios = SCENARIOS}) {
  const axes = Object.fromEntries(['dependents', 'duplicates', 'otherPaths', 'sharedState'].map(axis =>
    [axis, queries[axis] === undefined ? NA(`Fixture ${axis} were searched by the recorded diff tokens.`) : {queries: queries[axis]}]));
  return {axes, included: included.map(([id, path]) => ({id, path, behavior: `${path} shows the changed behavior.`})),
    excluded: excluded.map(([glob, reason]) => ({glob, reason})), unknown, contracts: [], valueChanges: [], scenarios};
}

async function repo(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-surface-')));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const write = async (path, content) => {await mkdir(dirname(join(root, path)), {recursive: true}); await writeFile(join(root, path), content);};
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Surface fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  await write('.gitignore', '.agent-ops/\n');
  for (const [path, content] of Object.entries(files)) await write(path, content);
  git('add', '-A'); git('commit', '-qm', 'base');
  const commit = async (changes, message = 'change') => {
    for (const [path, content] of Object.entries(changes)) await write(path, content);
    git('add', '-A'); git('commit', '-qm', message);
    return git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean);
  };
  const base = git('rev-parse', 'HEAD');
  return {root, git, write, commit, base};
}
const runner = root => ({run: async args => {
  try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']})};}
  catch (e) {return {exitCode: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0)};}
}});
async function withRepo(files, check) {
  const fixture = await repo(files);
  try {return await check(fixture);} finally {await rm(fixture.root, {recursive: true, force: true});}
}
async function gate(fixture, surface, changedFiles, extra = {}) {
  const {runSurfaceGate} = await load('runtime/src/surface/discovery.js');
  return runSurfaceGate({root: fixture.root, taskId: 'task-surface', surface, required: true, base: fixture.base,
    changedFiles, configHash: 'fixture', ...extra});
}
const unclassified = result => {
  assert.equal(result.status, 'NOT_RUN', JSON.stringify(result));
  assert.equal(result.code, 'SURFACE_UNCLASSIFIED', JSON.stringify(result));
  return result.details.map(detail => detail.path).sort();
};

const CRITERIA = [{id: 'behavior', description: 'The behavior holds.', verifierIds: ['unit']},
  {id: 'regression', description: 'Nothing else broke.', verifierIds: ['unit']}];
const CONFIG = {schemaVersion: 3, profiles: ['core'], verification: {commands: [
  {id: 'unit', command: 'node', args: ['--test'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}]},
features: {completionGate: {enabled: false}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};

async function cli(root) {
  const {TaskService} = await load('runtime/src/task/service.js');
  const {FileTaskStore} = await load('runtime/src/task/store.js');
  const {parseArgs} = await load('packages/cli/src/args.js');
  const {runTaskCommand} = await load('packages/cli/src/commands/task.js');
  let next = 0;
  const service = new TaskService(new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root), {generateId: () => `task-${++next}`});
  const file = async (name, value) => {const path = join(root, name); await writeFile(path, JSON.stringify(value)); return path;};
  const run = async argv => runTaskCommand({args: parseArgs(argv), service});
  const create = async (...extra) => run(['task', 'create', '--title', 'Surfaced', ...CRITERIA.flatMap(c => ['--criterion', JSON.stringify(c)]), ...extra]);
  return {service, file, run, create};
}

const PAGE = (name, size) => `export function ${name}() {\n  return <img className="product-image-container" src={${size}} />;\n}\n`;
const IMAGE_FILES = {
  'src/pages/ProductDetailPage.tsx': PAGE('ProductDetailPage', 'SMALL_IMAGE'),
  'src/pages/StepFlow.tsx': PAGE('StepFlow', 'SMALL_IMAGE'),
  'src/pages/ComboDetailPage.tsx': PAGE('ComboDetailPage', 'SMALL_IMAGE'),
  'src/pages/ComboStepFlowPage.tsx': PAGE('ComboStepFlowPage', 'SMALL_IMAGE'),
  'src/pages/PackDetailPage.tsx': PAGE('PackDetailPage', 'SMALL_IMAGE'),
  'src/pages/PackDetailStepFlow.tsx': PAGE('PackDetailStepFlow', 'SMALL_IMAGE'),
  'src/pages/AboutPage.tsx': 'export function AboutPage() {\n  return <p>About</p>;\n}\n'
};
const SIBLINGS = ['src/pages/ComboDetailPage.tsx', 'src/pages/ComboStepFlowPage.tsx', 'src/pages/PackDetailPage.tsx', 'src/pages/PackDetailStepFlow.tsx'];

/** A real review command run over a committed 864dbbe2-shaped change. */
async function reviewFixture(check) {
  return withRepo(IMAGE_FILES, async fixture => {
    const {TaskService} = await load('runtime/src/task/service.js');
    const {FileTaskStore} = await load('runtime/src/task/store.js');
    const {parseArgs} = await load('packages/cli/src/args.js');
    const {runReviewCommand} = await load('packages/cli/src/commands/review.js');
    const {calculateConfigHash} = await load('runtime/src/config/hash.js');
    const {buildVerificationEvidence, FileEvidenceStore} = await load('runtime/src/verify/evidence.js');
    const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js');
    const {collectBaseChangePaths} = await load('runtime/src/verify/change-surface.js');
    const {taskContractHash} = await load('runtime/src/task/contract.js');
    await fixture.commit({'src/pages/ProductDetailPage.tsx': PAGE('ProductDetailPage', 'LARGE_IMAGE'),
      'src/pages/StepFlow.tsx': PAGE('StepFlow', 'LARGE_IMAGE')});
    const git = runner(fixture.root);
    let next = 0;
    const tasks = new TaskService(new FileTaskStore(join(fixture.root, '.agent-ops/tasks/state.json'), fixture.root), {generateId: () => `task-${++next}`});
    const evidenceStore = new FileEvidenceStore(fixture.root, fixture.root);
    const policyConfigHash = calculateConfigHash(CONFIG);
    const fingerprint = await calculateSourceFingerprint(fixture.root, {mode: 'base', baseRef: fixture.base, resolvedBase: fixture.base,
      changedFiles: await collectBaseChangePaths(git, fixture.base)}, git);
    const verified = async taskId => {
      const record = await tasks.status({taskId});
      const saved = {};
      for (const criterion of record.task.criteria) saved[criterion.id] = [await evidenceStore.save(buildVerificationEvidence({
        taskId, criterionId: criterion.id, command: CONFIG.verification.commands[0], scope: 'project',
        startedAt: '2026-10-13T00:00:00.000Z', finishedAt: '2026-10-13T00:00:01.000Z', exitCode: 0, testCount: 1, status: 'PASS',
        failureClass: 'none', sourceFingerprint: fingerprint, toolVersions: {}, config: CONFIG, taskContractHash: taskContractHash(record.task)}))];
      await tasks.recordEvidence(taskId, saved);
    };
    const review = (taskId, execute) => runReviewCommand({args: parseArgs(['review', '--task', taskId, '--yes', '--rerun', '--base', fixture.base]),
      authorized: true, targets: ['codex', 'agy'], tasks, taskId, root: fixture.root, gitRunner: git, config: CONFIG, policyConfigHash, evidenceStore, execute});
    return check({fixture, tasks, verified, review, policyConfigHash, taskContractHash});
  });
}
function passing(request, report) {
  const targets = request.invocation.plannedTargets ?? [request.invocation.harness, request.invocation.harness];
  return {status: report.results.some(r => r.status === 'FAIL') ? 'FAIL' : 'PASS', harness: targets[0],
    results: report.results.map(({criterionId, status, evidence}) => ({criterionId, status, evidence})), report, plannedTargets: targets,
    sessionIsolation: 'fresh', attempts: targets.map((target, i) => ({target, status: 'PASS', sessionId: `surface-${i}`})),
    adversarial: {target: targets[1], refuted: false, report}};
}
function report(criteria, failed = []) {
  return {summary: 'Surface review.', results: criteria.map(c => ({criterionId: c.id, status: failed.includes(c.id) ? 'FAIL' : 'PASS',
    summary: `Reviewed ${c.id}.`, evidence: [`inspected ${c.id}`]})),
  findings: failed.length === 0 ? [] : [{severity: 'important', blocking: true, title: 'Unlisted sibling page.',
    details: 'A sibling page shares product-image-container and was not listed.', locations: [], evidence: ['git grep -F product-image-container'],
    recommendation: 'Include the sibling page in the surface audit.', criterionIds: failed}],
  residualRisks: [], changedFilesInspected: ['src/pages/ProductDetailPage.tsx', 'src/pages/StepFlow.tsx'], supportingFilesInspected: []};
}

const raw = {
  'surface-spec-docs': async () => {
    const section = (raw, id) => {
      const text = raw.replace(/\r\n/gu, '\n');
      const start = text.indexOf(`## ${id}\n`);
      assert.ok(start >= 0, `missing ${id}`);
      const end = text.indexOf('\n## ', start + 1);
      return text.slice(start, end < 0 ? undefined : end);
    };
    // Windows CI checks the docs out with CRLF; the same sections must still be found there.
    const crlf = section((await readFile(join('docs', 'en', 'spec', 'acceptance-and-evidence.md'), 'utf8')).replace(/\r?\n/gu, '\r\n'), 'EVIDENCE-SURFACE-001');
    assert.ok(crlf.includes('SURFACE_UNCLASSIFIED'), 'CRLF section lost its content');
    for (const lang of ['en', 'zh-TW']) {
      const doc = async name => readFile(join('docs', lang, 'spec', name), 'utf8');
      const rule = section(await doc('acceptance-and-evidence.md'), 'EVIDENCE-SURFACE-001');
      for (const token of ['dependents', 'duplicates', 'otherPaths', 'sharedState', 'valueChanges', 'covers', 'initialState', 'redo',
        'timeBoundary', 'identitySwitch', 'concurrency', 'git grep -F', '--surface-file', 'surface-coverage', 'SURFACE_MISSING',
        'SURFACE_UNCLASSIFIED', 'SURFACE_QUERY_TOO_BROAD', 'SURFACE_EXCLUSION_TOO_BROAD', 'SCENARIO_MISSING', 'SURFACE_BUDGET_EXCEEDED',
        'SURFACE_UNASSIGNED', 'out of scope', 'worktree finish'])
        assert.ok(rule.includes(token), `${lang} EVIDENCE-SURFACE-001 lacks ${token}`);
      assert.match(section(await doc('loop-engineering.md'), 'LOOP-START-001'), /EVIDENCE-SURFACE-001/u, lang);
      const adversarial = section(await doc('review.md'), 'REVIEW-ADVERSARIAL-001');
      assert.match(adversarial, /surface-coverage/u, lang); assert.match(adversarial, /3/u, lang);
      const stop = section(await doc('judgment.md'), 'JUDGMENT-STOP-001');
      for (const token of ['EVIDENCE-SURFACE-001', 'breaking', 'UNKNOWN']) assert.ok(stop.includes(token), `${lang} JUDGMENT-STOP-001 lacks ${token}`);
    }
    const {harnessDescriptor, managedRules} = await load('runtime/src/install/harness.js');
    for (const id of ['claude', 'codex', 'agy', 'opencode']) {
      const rules = managedRules(harnessDescriptor(id), {scope: 'project', profiles: ['core'], capabilities: ['rules', 'task']});
      assert.match(rules, /For every change:\n\n1\. Audit the change's surfaces first \(EVIDENCE-SURFACE-001\)/u, id);
      assert.match(rules.replace(/\s+/gu, ' '), /"out of scope" is not a reason/u, id);
    }
  },

  'surface-task-create': () => withRepo({}, async ({root}) => {
    const {service, file, create} = await cli(root);
    assert.equal((await create()).code, 'SURFACE_MISSING');
    const broad = audit({included: [['page', 'src/**']], excluded: [['lib/**', 'out of scope']]});
    assert.equal((await create('--surface-file', await file('broad.json', broad))).code, 'SURFACE_MISSING');
    assert.equal((await create('--surface-file', await file('empty.json', {...audit({included: [['x', 'x']]}), included: []}))).code, 'SURFACE_MISSING');
    const partial = audit({included: [['x', 'x']]});
    delete partial.axes.sharedState;
    assert.equal((await create('--surface-file', await file('partial.json', partial))).code, 'SURFACE_MISSING');
    const surface = audit({included: [['page', 'src/pages/ProductDetailPage.tsx']], queries: {duplicates: ['product-image-container']},
      unknown: [{id: 'partner-app', reader: 'Partner app reading image URLs', behavior: 'Receives the same URL shape.'}]});
    surface.contracts = [{id: 'image-url', name: 'Image URL query', change: 'compatible', behavior: 'Old URLs still resolve.'}];
    surface.valueChanges = [{producer: 'imageSize()', kind: 'default', change: 'Defaults to LARGE_IMAGE.', consumers: ['ProductDetailPage'],
      indirectConsumers: ['Image CDN cache']}];
    const created = await create('--surface-file', await file('surface.json', surface));
    assert.equal(created.code, 'TASK_CREATED', JSON.stringify(created));
    const task = created.data.record.task;
    assert.deepEqual(task.surface, surface);
    assert.equal(task.surfaceRequired, true);
    const {taskContractHash} = await load('runtime/src/task/contract.js');
    assert.notEqual(taskContractHash(task), taskContractHash({...task, surface: audit({included: [['other', 'other.ts']]})}));
    // A subtask of a surfaced parent declares which included surfaces it covers.
    assert.equal((await create('--parent', task.id)).code, 'SURFACE_MISSING');
    const child = await create('--parent', task.id, '--surface-file', await file('covers.json', {covers: ['page']}));
    assert.equal(child.code, 'TASK_CREATED', JSON.stringify(child));
    assert.deepEqual(child.data.record.task.surface, {covers: ['page']});
    assert.equal((await service.list()).length, 2);
  }),

  'surface-task-revise': () => withRepo({}, async ({root}) => {
    const {service, file, run, create} = await cli(root);
    const first = audit({included: [['page', 'src/pages/ProductDetailPage.tsx']]});
    const created = (await create('--surface-file', await file('first.json', first))).data.record;
    const {taskContractHash} = await load('runtime/src/task/contract.js');
    const before = taskContractHash(created.task);
    await service.recordEvidence(created.task.id, {behavior: ['review:agy:stale']});
    const second = audit({included: [['page', 'src/pages/ProductDetailPage.tsx'], ['combo', 'src/pages/ComboDetailPage.tsx']]});
    const revise = async (path, expected) => run(['task', 'revise', '--task', created.task.id, '--expected-contract', expected,
      '--surface-file', path, '--reason', 'Discovery found a sibling page.']);
    assert.equal((await revise(await file('bad.json', {...second, excluded: [{glob: 'x', reason: 'n/a'}]}), before)).code, 'SURFACE_MISSING');
    assert.equal((await service.status({taskId: created.task.id})).task.contractRevision ?? 0, 0);
    assert.equal((await revise(await file('second.json', second), 'f'.repeat(64))).code, 'TASK_CONTRACT_CHANGED');
    const revised = await revise(await file('second.json', second), before);
    assert.equal(revised.code, 'TASK_REVISED', JSON.stringify(revised));
    const record = await service.status({taskId: created.task.id});
    assert.deepEqual(record.task.surface, second);
    assert.deepEqual(record.task.criteria, created.task.criteria);
    assert.equal(record.task.contractRevision, 1);
    assert.notEqual(taskContractHash(record.task), before);
    assert.deepEqual(record.evidence, {}, 'a surface revision needs fresh evidence');
    assert.deepEqual(record.revisions.map(r => r.previousTask.surface), [first]);
    assert.equal(record.revisions[0].reason, 'Discovery found a sibling page.');
  }),

  'surface-legacy-grandfathered': () => reviewFixture(async ({tasks, verified, review, policyConfigHash}) => {
    // Created through the API without the front-door flag, like every pre-release task.
    const legacy = await tasks.create({title: 'Legacy task', criteria: CRITERIA, policyConfigHash});
    assert.equal(legacy.task.surface, undefined);
    assert.equal(legacy.task.surfaceRequired, undefined);
    await verified(legacy.task.id);
    let reached = 0;
    const result = await review(legacy.task.id, async request => {reached += 1; return passing(request, report(request.invocation.packet.criteria));});
    assert.equal(reached, 1, JSON.stringify(result.data?.result?.reason));
    assert.equal(result.data.result.status, 'PASS');
    assert.equal(result.data.result.surface, undefined);
    assert.ok(!(await tasks.status({taskId: legacy.task.id})).task.criteria.some(c => c.id === 'surface-coverage'));
    // A new task without its audit never reaches a reviewer.
    const fresh = await tasks.create({title: 'New task', criteria: CRITERIA, policyConfigHash, requireSurface: true}).catch(e => e);
    assert.equal(fresh.code, 'SURFACE_MISSING');
  }),

  'surface-replay-image-siblings': () => withRepo(IMAGE_FILES, async fixture => {
    const changed = await fixture.commit({'src/pages/ProductDetailPage.tsx': PAGE('ProductDetailPage', 'LARGE_IMAGE'),
      'src/pages/StepFlow.tsx': PAGE('StepFlow', 'LARGE_IMAGE')});
    const listed = [['product', 'src/pages/ProductDetailPage.tsx'], ['step', 'src/pages/StepFlow.tsx']];
    // The siblings import nothing from the changed pages; only the shared markup and constant find them.
    assert.deepEqual(unclassified(await gate(fixture, audit({included: listed}), changed)), SIBLINGS);
    const classified = audit({included: [...listed, ['combo', 'src/pages/Combo*.tsx'], ['pack-detail', 'src/pages/PackDetailPage.tsx']],
      excluded: [['src/pages/PackDetailStepFlow.tsx', 'Pack step flow renders a fixed placeholder image that never changes size.']]});
    const passed = await gate(fixture, classified, changed);
    assert.equal(passed.status, 'PASS', JSON.stringify(passed));
    assert.ok(passed.discovery.sources['diff-token'].files >= 6, JSON.stringify(passed.discovery));
  }),

  'surface-replay-token-entry': () => withRepo({
    'src/dinein/TableForm.ts': 'export function submitTable(params) {\n  return post("/orders", params);\n}\n',
    'src/entry/entryCode.ts': 'export function decodeEntry(code) {\n  return {store: code.store, table_number: code.t};\n}\n',
    'src/entry/useEntryCodeRouting.ts': 'export function useEntryCodeRouting(entry) {\n  return `/menu?table=${entry.table_number}`;\n}\n',
    'src/menu/Menu.ts': 'export const menu = [];\n'
  }, async fixture => {
    const changed = await fixture.commit({'src/dinein/TableForm.ts':
      'export function submitTable(params) {\n  return post("/orders", {...params, table_number: params.table});\n}\n'});
    const surface = audit({included: [['form', 'src/dinein/TableForm.ts']]});
    assert.deepEqual(unclassified(await gate(fixture, surface, changed)), ['src/entry/entryCode.ts', 'src/entry/useEntryCodeRouting.ts']);
    const hits = (await gate(fixture, surface, changed)).details.flatMap(detail => detail.hits.map(hit => hit.query));
    assert.ok(hits.includes('table_number'), JSON.stringify(hits));
    const passed = await gate(fixture, audit({included: [['form', 'src/dinein/TableForm.ts'], ['entry', 'src/entry/**']]}), changed);
    assert.equal(passed.status, 'PASS', JSON.stringify(passed));
  }),

  'surface-extract-fragments': () => withRepo({
    'src/orders.ts': 'export function loadOrder(id) {\n  const cached = null;\n  return cached;\n}\n',
    'src/screen.ts': 'import {loadOrder} from "./orders";\nexport const screen = () => loadOrder(1);\n',
    'src/cache.ts': 'export const orderKey = id => "order:" + id;\n'
  }, async fixture => {
    const {extractDiffQueries} = await load('runtime/src/surface/discovery.js');
    const queries = extractDiffQueries([
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
      '@@ -10,2 +10,2 @@ export async function loadOrder(id: string) {',
      '-  const key = `order:${id}`;', '+  const key = `order:${id}:v2`;',
      "+  const user = 'user_' + id;", '+  const label = "menu." + section;',
      '@@ -40 +40 @@ def refresh_menu(store):', '+    table_number = store.table  # surface update'
    ].join('\n'));
    for (const fragment of ['order:', 'user_', 'menu.']) assert.ok(queries.fragments.includes(fragment), `${fragment}: ${JSON.stringify(queries)}`);
    assert.deepEqual(queries.functions.sort(), ['loadOrder', 'refresh_menu']);
    assert.ok(queries.tokens.includes('table_number'), JSON.stringify(queries.tokens));
    // Prose words are not queries; compound identifiers are.
    for (const word of ['surface', 'update', 'section']) assert.ok(!queries.tokens.includes(word), word);
    const changed = await fixture.commit({
      'src/orders.ts': 'export function loadOrder(id) {\n  const cached = readCache(`order:${id}`);\n  return cached;\n}\n'});
    const result = await gate(fixture, audit({included: [['orders', 'src/orders.ts']]}), changed);
    assert.deepEqual(unclassified(result), ['src/cache.ts', 'src/screen.ts']);
    const sources = new Map(result.details.map(detail => [detail.path, detail.hits.map(hit => `${hit.source}:${hit.query}`)]));
    assert.ok(sources.get('src/screen.ts').includes('hunk-header:loadOrder'), JSON.stringify([...sources]));
    assert.ok(sources.get('src/cache.ts').includes('template-fragment:order:'), JSON.stringify([...sources]));
  }),

  'surface-code-matrix': () => withRepo({
    'src/target.ts': 'export const target = "shared_marker";\n',
    ...Object.fromEntries(Array.from({length: 201}, (_, i) => [`gen/file${i}.ts`, `export const v${i} = "common_marker";\n`])),
    ...Object.fromEntries(Array.from({length: 11}, (_, i) => [`lib/module${i}.ts`, `export const m${i} = ${i};\n`]))
  }, async fixture => {
    const changed = await fixture.commit({'src/target.ts': 'export const target = "shared_marker_v2";\n'});
    const ok = audit({included: [['target', 'src/target.ts']]});
    const expectCode = (result, code) => {assert.equal(result.status, 'NOT_RUN', JSON.stringify(result)); assert.equal(result.code, code, JSON.stringify(result));};
    const expectPass = result => assert.equal(result.status, 'PASS', JSON.stringify(result));
    expectPass(await gate(fixture, ok, changed));
    // SURFACE_QUERY_TOO_BROAD: one recorded query hits more than 200 files.
    expectCode(await gate(fixture, audit({included: [['target', 'src/target.ts'], ['gen', 'gen/**']], queries: {duplicates: ['common_marker']}}), changed),
      'SURFACE_QUERY_TOO_BROAD');
    expectPass(await gate(fixture, audit({included: [['target', 'src/target.ts']], queries: {duplicates: ['shared_marker']}}), changed));
    // SURFACE_EXCLUSION_TOO_BROAD: one glob hides more than 10 files, or a file in the diff.
    expectCode(await gate(fixture, audit({included: [['target', 'src/target.ts']], excluded: [['lib/**', 'Generated modules only hold constants never read by target.']]}), changed),
      'SURFACE_EXCLUSION_TOO_BROAD');
    expectCode(await gate(fixture, audit({included: [['target', 'src/target.ts']], excluded: [['src/*.ts', 'Source helpers never read the marker.']]}), changed),
      'SURFACE_EXCLUSION_TOO_BROAD');
    expectPass(await gate(fixture, audit({included: [['target', 'src/target.ts']], excluded: [['lib/module1*.ts', 'Generated modules only hold constants never read by target.']]}), changed));
    // SCENARIO_MISSING: every dimension needs applies+behavior or n/a: reason.
    const {concurrency: _omitted, ...four} = SCENARIOS;
    expectCode(await gate(fixture, audit({included: [['target', 'src/target.ts']], scenarios: four}), changed), 'SCENARIO_MISSING');
    expectPass(await gate(fixture, audit({included: [['target', 'src/target.ts']], scenarios: {...four, concurrency: {applies: true, behavior: 'Two writers keep the last marker.'}}}), changed));
    // SURFACE_BUDGET_EXCEEDED: never silently skipped.
    let clock = 0;
    expectCode(await gate(fixture, ok, changed, {budgetMs: 2_000, now: () => (clock += 1_000)}), 'SURFACE_BUDGET_EXCEEDED');
    expectPass(await gate(fixture, ok, changed, {budgetMs: 120_000, now: () => (clock += 1)}));
    // SURFACE_UNASSIGNED: the children's covers union must equal the parent's included list.
    const parent = audit({included: [['target', 'src/target.ts'], ['docs', 'docs/**']]});
    expectCode(await gate(fixture, parent, changed, {children: [{taskId: 'child-1', covers: ['target']}]}), 'SURFACE_UNASSIGNED');
    expectCode(await gate(fixture, parent, changed, {children: [{taskId: 'child-1', covers: ['target', 'docs', 'ghost']}]}), 'SURFACE_UNASSIGNED');
    expectPass(await gate(fixture, parent, changed, {children: [{taskId: 'child-1', covers: ['target']}, {taskId: 'child-2', covers: ['docs']}]}));
    // SURFACE_MISSING: a required task without a parseable audit.
    expectCode(await gate(fixture, undefined, changed), 'SURFACE_MISSING');
    expectCode(await gate(fixture, {axes: {}}, changed), 'SURFACE_MISSING');
  }),

  'surface-no-shell': () => withRepo({
    'src/literal.ts': 'export const s = "$(touch pwned-a); touch pwned-b | a.*b";\n',
    'src/regex.ts': 'export const r = "axxb";\n',
    'src/dash.ts': 'export const d = "--output=leak";\n'
  }, async fixture => {
    const changed = await fixture.commit({'README.md': 'docs\n'});
    const queries = ['$(touch pwned-a)', '; touch pwned-b', 'a.*b', '--output=leak', '`touch pwned-c`'];
    const result = await gate(fixture, audit({included: [['readme', 'README.md']], queries: {duplicates: queries}}), changed);
    for (const name of ['pwned-a', 'pwned-b', 'pwned-c', 'leak']) assert.equal(existsSync(join(fixture.root, name)), false, name);
    // Fixed strings: the regex-looking query matches only its literal text, never axxb.
    assert.deepEqual(unclassified(result), ['src/dash.ts', 'src/literal.ts']);
    const byQuery = new Map(result.details.flatMap(detail => detail.hits.map(hit => [hit.query, detail.path])));
    assert.equal(byQuery.get('a.*b'), 'src/literal.ts');
    assert.equal(byQuery.get('--output=leak'), 'src/dash.ts');
    const source = await readFile(join(build, 'runtime/src/surface/discovery.js'), 'utf8');
    assert.match(source, /shell: false/u);
    assert.match(source, /import \{ execFile \} from "node:child_process";/u);
    assert.doesNotMatch(source, /execSync|spawnSync|shell: true/u);
  }),

  'surface-review-packet': () => reviewFixture(async ({tasks, verified, review, policyConfigHash, taskContractHash}) => {
    const {buildAdversarialPrompt, buildReviewPrompt} = await load('runtime/src/review/runner.js');
    const listed = [['product', 'src/pages/ProductDetailPage.tsx'], ['step', 'src/pages/StepFlow.tsx']];
    const first = audit({included: listed, queries: {duplicates: ['product-image-container']}});
    const task = await tasks.create({title: 'Image size', criteria: CRITERIA, policyConfigHash, requireSurface: true, surface: first});
    await verified(task.task.id);
    let spawned = 0;
    const blocked = await review(task.task.id, async () => {spawned += 1; throw new Error('blocked review must not start');});
    assert.equal(spawned, 0);
    assert.equal(blocked.code, 'SURFACE_UNCLASSIFIED');
    assert.equal(blocked.data.result.reason, 'surface-unclassified');
    for (const sibling of SIBLINGS) assert.ok(blocked.data.text.includes(sibling), sibling);
    // Excluding a sibling only after the block is flagged to reviewers.
    const second = audit({included: [...listed, ['combo', 'src/pages/Combo*.tsx'], ['pack-detail', 'src/pages/PackDetailPage.tsx']],
      queries: {duplicates: ['product-image-container']},
      excluded: [['src/pages/PackDetailStepFlow.tsx', 'Pack step flow renders a fixed placeholder image that never changes size.']]});
    await tasks.revise(task.task.id, {expectedContractHash: taskContractHash(task.task), surface: second, reason: 'Classify discovered siblings.'});
    await verified(task.task.id);
    let seen;
    const passed = await review(task.task.id, async request => {seen = request; return passing(request, report(request.invocation.packet.criteria));});
    assert.equal(passed.data.result.status, 'PASS', JSON.stringify(passed.data.result.reason));
    const packet = seen.invocation.packet;
    assert.deepEqual(packet.surface.audit, second);
    assert.deepEqual(packet.surface.history.map(h => h.surface), [first]);
    assert.deepEqual(packet.surface.postBlockExclusions.map(e => e.path), ['src/pages/PackDetailStepFlow.tsx']);
    assert.ok(packet.surface.discovery.sources.agent.queries >= 1);
    assert.deepEqual(packet.criteria.map(c => c.id), ['behavior', 'regression', 'surface-coverage']);
    const primary = buildReviewPrompt(seen.invocation);
    assert.match(primary, /narrow exception to "Do not survey"/u);
    assert.match(primary, /Round 1: replay every recorded axis query with `git grep -F/u);
    assert.match(primary, /valueChanges consumer/u);
    const challenge = buildAdversarialPrompt(seen.invocation, report(packet.criteria));
    assert.match(challenge, /Round 2: check the five fixed scenarios/u);
    assert.match(challenge, /at most 3 new `git grep -F` queries per axis/u);
    assert.ok(primary.includes('PackDetailStepFlow.tsx') && challenge.includes('PackDetailStepFlow.tsx'), 'reviewers see the post-block exclusion');
  }),

  'surface-coverage-blocking': () => reviewFixture(async ({tasks, verified, review, policyConfigHash}) => {
    const {reviewReportStatus, validateReviewReport} = await load('runtime/src/review/report.js');
    const surface = audit({included: [['product', 'src/pages/ProductDetailPage.tsx'], ['step', 'src/pages/StepFlow.tsx'],
      ['siblings', 'src/pages/*Detail*.tsx'], ['combo-flow', 'src/pages/ComboStepFlowPage.tsx']]});
    const task = await tasks.create({title: 'Image size', criteria: CRITERIA, policyConfigHash, requireSurface: true, surface});
    await verified(task.task.id);
    let criteria;
    const failed = await review(task.task.id, async request => {
      criteria = request.invocation.packet.criteria;
      return passing(request, report(criteria, ['surface-coverage']));
    });
    const ids = criteria.map(c => c.id);
    assert.ok(ids.includes('surface-coverage'));
    // The reviewer must answer surface-coverage, and an omission FAIL blocks.
    assert.equal(validateReviewReport(report(criteria.filter(c => c.id !== 'surface-coverage')), ids).ok, false);
    const omission = validateReviewReport(report(criteria, ['surface-coverage']), ids);
    assert.equal(omission.ok, true, JSON.stringify(omission.errors));
    assert.equal(reviewReportStatus(omission.value), 'FAIL');
    assert.equal(failed.status, 'error');
    assert.equal(failed.data.result.status, 'FAIL');
    const record = await tasks.status({taskId: task.task.id});
    assert.ok(!Object.values(record.evidence).flat().some(ref => ref.startsWith('review:')), 'a blocked review records no review evidence');
  }),

  'surface-finish-receipt': async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-surface-finish-')));
    try {
      const {finishWorktree} = await load('runtime/src/parallel/finish.js');
      const {addWorktree} = await load('runtime/src/parallel/service.js');
      const {CompletionGateService} = await load('runtime/src/hooks/completion-gate.js');
      const {TaskService} = await load('runtime/src/task/service.js');
      const {FileTaskStore} = await load('runtime/src/task/store.js');
      const {calculateConfigHash} = await load('runtime/src/config/hash.js');
      const {buildVerificationEvidence, FileEvidenceStore} = await load('runtime/src/verify/evidence.js');
      const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js');
      const {collectBaseChangePaths} = await load('runtime/src/verify/change-surface.js');
      const {reviewReportDigest, saveReviewAttestation, saveReviewReportArtifact} = await load('runtime/src/review/attestation.js');
      const {parseArgs} = await load('packages/cli/src/args.js');
      const {runWorktreeCommand} = await load('packages/cli/src/commands/parallel.js');
      const config = {...CONFIG, profiles: ['core', 'loop'], verification: {commands: [{id: 'node-test', command: 'node', args: ['--test'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}]},
        features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}};
      const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
      const write = async (base, path, content) => {await mkdir(dirname(join(base, path)), {recursive: true}); await writeFile(join(base, path), content);};
      git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'user.name', 'Fixture');
      git(root, 'config', 'core.autocrlf', 'false');
      await write(root, '.gitignore', '.agent-ops/\n'); await write(root, 'source.txt', 'base\n'); await write(root, 'CLAUDE.md', 'rules\n');
      git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
      await write(root, '.agent-ops/config.json', JSON.stringify(config));
      await write(root, '.agent-ops/CLAUDE.md', 'managed rules\n');
      await write(root, '.agent-ops/manifest.json', JSON.stringify({schemaVersion: 2, scope: 'project', harness: ['claude'],
        artifacts: [{id: 'config', path: '.agent-ops/config.json', hash: 'a'.repeat(64), owner: 'agent-ops'},
          {id: 'claude-rules', path: '.agent-ops/CLAUDE.md', hash: 'b'.repeat(64), owner: 'agent-ops'}],
        markers: [{id: 'claude-routing', path: 'CLAUDE.md', hash: 'c'.repeat(64), owner: 'agent-ops', startMarker: '<!-- start -->', endMarker: '<!-- end -->'}]}));
      const loadConfig = async () => config;
      const gitDep = async (cwd, args) => {
        try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}), stderr: ''};}
        catch (e) {return {exitCode: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '')};}
      };
      const gateFor = cwd => new CompletionGateService({root: cwd, config, gitRunner: runner(cwd),
        taskService: new TaskService(new FileTaskStore(join(cwd, '.agent-ops/tasks/state.json'), cwd), {completion: {root: cwd, gitRunner: runner(cwd), loadConfig}}),
        evidenceStore: new FileEvidenceStore(cwd, cwd), forRoot: async other => gateFor(other)});
      const deps = {git: gitDep, loadConfig, trust: {status: async () => 'TRUSTED', grant: async () => {}, revoke: async () => {}},
        gate: async cwd => gateFor(cwd), runSetup: async () => ({exitCode: 0, output: ''}), now: () => '2026-10-13T00:00:00.000Z',
        tasks: (cwd, completionBase) => new TaskService(new FileTaskStore(join(cwd, '.agent-ops/tasks/state.json'), cwd),
          completionBase === undefined ? {} : {completion: {root: cwd, gitRunner: runner(cwd), base: completionBase, loadConfig}}),
        processRunner: {start: () => ({pid: 1, stdout: (async function* () {})(), stderr: (async function* () {})(),
          completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => undefined})}};
      const finish = async name => {
        const {record} = await addWorktree(deps, {cwd: root, name, sessionId: `session-${name}`});
        await write(record.path, `${name}.txt`, `${name} work\n`);
        git(record.path, 'add', '-A'); git(record.path, 'commit', '-qm', `${name} work`);
        const worktreeGit = runner(record.path);
        const fingerprint = await calculateSourceFingerprint(record.path, {mode: 'base', baseRef: record.base, resolvedBase: record.base,
          changedFiles: await collectBaseChangePaths(worktreeGit, record.base)}, worktreeGit);
        const tasks = new TaskService(new FileTaskStore(join(record.path, '.agent-ops/tasks/state.json'), record.path));
        const task = await tasks.create({title: `Change ${name}`, criteria: [
          {id: 'behavior', description: 'The behavior holds.', verifierIds: ['node-test']},
          {id: 'regression', description: 'Nothing else broke.', verifierIds: ['node-test']}], policyConfigHash: calculateConfigHash(config), sessionId: record.sessionId});
        const evidence = new FileEvidenceStore(record.path, record.path);
        const references = {};
        for (const criterion of task.task.criteria) references[criterion.id] = [await evidence.save(buildVerificationEvidence({
          taskId: task.task.id, criterionId: criterion.id, command: config.verification.commands[0], scope: 'project',
          startedAt: '2026-10-13T00:00:00Z', finishedAt: '2026-10-13T00:00:01Z', exitCode: 0, testCount: 1, status: 'PASS',
          failureClass: 'none', sourceFingerprint: fingerprint, toolVersions: {}, config}))];
        const round = (summary, risk, finding) => ({summary, results: [{criterionId: 'change-quality', status: 'PASS', summary, evidence: ['fixture']}],
          findings: finding === undefined ? [] : [{severity: 'minor', blocking: false, title: finding, details: 'Worth saying, not blocking.',
            locations: [], evidence: ['fixture'], recommendation: 'Consider it later.', criterionIds: ['change-quality']}],
          residualRisks: [risk], changedFilesInspected: [`${name}.txt`], supportingFilesInspected: []});
        const primary = round('primary passed', `${name} primary residual risk`, `${name} primary note`);
        const adversarial = round('adversarial passed', `${name} adversarial residual risk`);
        await saveReviewReportArtifact(record.path, {status: 'PASS', harness: 'codex', model: 'fixture', effort: 'fixture', prompt: 'fixture',
          plannedTargets: ['codex', 'agy'], sourceFingerprint: fingerprint, sessionIsolation: 'fresh',
          attempts: [{target: 'codex', status: 'PASS', sessionId: 'p'}, {target: 'agy', status: 'PASS', sessionId: 'a'}], preflight: [],
          report: primary, adversarial: {target: 'agy', refuted: false, report: adversarial}}, fingerprint, task.task.id);
        await saveReviewAttestation(record.path, {schemaVersion: 2, taskId: task.task.id, harness: 'codex', status: 'PASS', sourceFingerprint: fingerprint,
          reviewTargets: ['codex', 'agy'], reviewSessionIds: ['p', 'a'], sessionIsolation: 'fresh', primaryReportDigest: reviewReportDigest(primary),
          adversarialReportDigest: reviewReportDigest(adversarial), reportArtifact: `.agent-ops/reviews/${fingerprint}.${task.task.id}.reports.json`,
          createdAt: '2026-10-13T00:00:00.000Z'});
        await tasks.recordEvidence(task.task.id, references, record.base);
        return record;
      };
      // Plain finish: no advance, no run, no final proof.
      const alpha = await finish('alpha');
      const result = await finishWorktree(deps, {cwd: root, name: 'alpha'});
      assert.ok(result.receipt, `plain finish wrote no receipt: ${JSON.stringify(result.warnings)}`);
      const receipt = JSON.parse(await readFile(result.receipt, 'utf8'));
      assert.deepEqual([...receipt.residualRisks].sort(), ['alpha adversarial residual risk', 'alpha primary residual risk']);
      assert.deepEqual(receipt.nonBlockingFindings.map(f => [f.round, f.title]), [['primary', 'alpha primary note']]);
      assert.deepEqual([...result.residualRisks].sort(), [...receipt.residualRisks].sort());
      assert.match(git(root, 'notes', '--ref=agent-ops', 'show', result.mergedHead), new RegExp(`receipt: ${result.receipt.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'));
      assert.equal(existsSync(alpha.path), false);
      // The CLI prints the residual risks without asking.
      await finish('beta');
      const printed = await runWorktreeCommand({args: parseArgs(['worktree', 'finish', 'beta']), cwd: root, deps});
      assert.equal(printed.status, 'ok', JSON.stringify(printed));
      for (const line of ['Receipt: ', '- beta primary residual risk', '- beta adversarial residual risk'])
        assert.ok(printed.data.text.includes(line), `${line} missing from ${printed.data.text}`);
    } finally {await rm(root, {recursive: true, force: true});}
  }
};

/** Missing behavior surfaces as a failed assertion, so the baseline is red, not broken. */
export const surfaceChecks = Object.fromEntries(Object.entries(raw).map(([id, check]) => [id, async () => {
  try {await check();}
  catch (e) {
    if (e?.code === 'ERR_ASSERTION') throw e;
    throw new assert.AssertionError({message: `${id}: ${e?.code ?? ''} ${e?.stack ?? e}`});
  }
}]));
