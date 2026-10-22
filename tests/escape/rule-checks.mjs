import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Escape Loop R2 acceptance on synthetic repositories only. Modules load lazily
// so a build without R2 fails each check as an assertion, never as a crash.
const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const load = async path => {
  try {return await import(pathToFileURL(join(build, path)).href);}
  catch (e) {assert.fail(`${path} is unavailable: ${e.code ?? e.message}`);}
};
const need = (module, ...names) => {
  for (const name of names) assert.equal(typeof module[name], 'function', `${name} is not implemented`);
  return module;
};
const rules = async (...names) => need(await load('runtime/src/escape/rules.js'), ...names);
const link = async (...names) => need(await load('runtime/src/escape/link.js'), ...names);

const runner = root => ({run: async args => {
  try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']})};}
  catch (e) {return {exitCode: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0)};}
}});
/** A synthetic repository; `files` is the first commit. */
async function repo(files, root) {
  root ??= await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-rules-')));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const write = async (path, content) => {await mkdir(dirname(join(root, path)), {recursive: true}); await writeFile(join(root, path), content);};
  const commit = async (changes, message = 'change') => {
    for (const [path, content] of Object.entries(changes)) await write(path, content);
    git('add', '-A'); git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  if (!existsSync(join(root, '.git'))) {
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Rule fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.autocrlf', 'false');
    await write('.gitignore', '.agent-ops/\n');
  }
  const base = Object.keys(files).length === 0 ? git('rev-parse', 'HEAD') : await commit(files, 'base');
  const pad = async n => {for (let i = 0; i < n; i += 1) await commit({[`docs/note-${i}.md`]: `note ${i}\n`}, `note ${i}`);};
  return {root, git, write, commit, pad, base, runner: runner(root)};
}
// Windows: a git child killed by a 1 ms budget can hold the directory briefly (EBUSY); rm retries.
async function withRepo(files, check) {
  const f = await repo(files);
  try {return await check(f);} finally {await rm(f.root, {recursive: true, force: true, maxRetries: 10});}
}
async function withHome(check) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-rules-home-')));
  try {return await check(home);} finally {await rm(home, {recursive: true, force: true, maxRetries: 10});}
}
const events = async home => {
  try {return (await readFile(join(home, '.agent-ops/state/logs/events.ndjson'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));}
  catch (e) {if (e.code === 'ENOENT') return []; throw e;}
};

const NA = reason => ({na: reason});
const SCENARIOS = {initialState: NA('Fixture has no persisted state to start from.'), redo: NA('Fixture operations are never retried.'),
  timeBoundary: NA('Fixture has no dates, TTLs or timezones.'), identitySwitch: NA('Fixture has no stores, roles or tenants.'),
  concurrency: NA('Fixture runs one writer at a time.')};
const audit = ({included, excluded = [], unknown = []}) => ({
  axes: {dependents: NA('Fixture pages import nothing.'), duplicates: {queries: ['ProductPage']}, otherPaths: NA('Fixture has one route per page.'),
    sharedState: NA('Fixture pages keep no shared state.')},
  included: included.map(path => ({id: path.replace(/\W+/gu, '-').toLowerCase().replace(/^-|-$/gu, ''), path, behavior: `${path} shows the size.`})),
  excluded: excluded.map(glob => ({glob, reason: 'This page renders a fixed banner image whose size never changes.'})),
  unknown: unknown.map(path => ({id: 'unknown-' + path.replace(/\W+/gu, '-').toLowerCase(), reader: 'Fixture reader', behavior: 'Unknown.', path})),
  contracts: [], valueChanges: [], scenarios: SCENARIOS});
// The changed line carries no shared literal, so only a learned rule can find the siblings.
const PAGE = (name, size = 'SMALL') => `export function ${name}() {\n  const size = ${size};\n  return <img className="product-image-size" src={size} />;\n}\n`;
const PAGES = {'src/pages/ProductPage.tsx': PAGE('ProductPage'), 'src/pages/ComboPage.tsx': PAGE('ComboPage'),
  'src/pages/PackPage.tsx': PAGE('PackPage'), 'src/pages/AboutPage.tsx': 'export function AboutPage() {\n  return <p>About</p>;\n}\n'};
const SIBLINGS = ['src/pages/ComboPage.tsx', 'src/pages/PackPage.tsx'];
const rule = (escape, extra = {}) => ({id: 'image-size-siblings', escape, label: 'surface-unseen',
  trigger: {paths: ['src/pages/ProductPage.tsx'], tokens: []}, expand: {paths: [], queries: ['product-image-size']}, noExclude: true, ...extra});
const writeRule = async (f, value) => f.write(`.agent-ops-escapes/rules/${value.id}.json`, JSON.stringify(value, null, 2) + '\n');

async function gate(f, surface, changedFiles, extra = {}) {
  const {runSurfaceGate} = await load('runtime/src/surface/discovery.js');
  return runSurfaceGate({root: f.root, taskId: 'task-rules', surface, required: true, base: f.base, changedFiles, configHash: 'fixture', ...extra});
}
const productChange = async f => f.write('src/pages/ProductPage.tsx', PAGE('ProductPage', 'LARGE'));

/** A non-DEBUG behavioral task (red baseline, green candidate) from the DEBUG acceptance helper; escape proof never blocks its finish. */
async function behavioralTask() {
  const {fixture} = await import('../debug/acceptance-helper.mjs');
  const f = await fixture(false);
  const r = await repo({}, f.root);
  const {taskContractHash} = await load('runtime/src/task/contract.js');
  const id = f.record.task.id;
  const declare = async origin => {
    const current = await f.tasks.status({taskId: id});
    await f.tasks.revise(id, {expectedContractHash: taskContractHash(current.task), origin: await f.tasks.resolveOrigin(origin),
      reason: 'Declare where the bug escaped from.'});
    return await f.tasks.declareEscape(id);
  };
  // Commit everything, verify red-to-green, then try to complete: the escape proof runs before review.
  const finish = async () => {
    await f.candidate();
    const report = await f.verify();
    assert.equal(report.status, 'PASS', JSON.stringify(report).slice(0, 2000));
    const current = await f.tasks.status({taskId: id});
    try {await f.tasks.complete(id, current.evidence); return 'COMPLETED';}
    catch (e) {return e.code;}
  };
  return {...f, ...r, id, declare, finish, contract: async () => taskContractHash((await f.tasks.status({taskId: id})).task)};
}

const raw = {
  'escape-rule-schema': async () => {
    const {parseRule, loadRules} = await rules('parseRule', 'loadRules');
    const sha = 'a'.repeat(40);
    const good = rule(sha);
    assert.deepEqual(parseRule(good, 'image-size-siblings.json'), good);
    const bad = [
      [{...good, exclude: ['src/**']}, 'a field that relaxes the gate'],
      [{...good, id: 'Image'}, 'an id that is not kebab-case'],
      [good, 'a file name that does not match the id', 'other.json'],
      [{...good, escape: 'abc1234'}, 'a short escape commit'],
      [{...good, label: 'anything'}, 'an unknown label'],
      [{...good, trigger: {paths: [], tokens: []}}, 'an empty trigger'],
      [{...good, expand: {paths: ['../outside/**'], queries: []}}, 'a glob leaving the repository'],
      [{...good, expand: {paths: [], queries: ['two\nlines']}}, 'a multi-line query'],
      [{...good, trigger: {...good.trigger, remove: ['x']}}, 'an extra trigger field'],
      [{...good, noExclude: 'yes'}, 'a non-boolean noExclude']];
    for (const [value, what, file = 'image-size-siblings.json'] of bad)
      assert.throws(() => parseRule(value, file), {code: 'ESCAPE_RULE_INVALID'}, `accepted ${what}`);
    await withRepo(PAGES, async f => {
      assert.deepEqual(await loadRules(f.root), [], 'no rules directory means no rules');
      await f.write('.agent-ops-escapes/rules/image-size-siblings.json', '{"id": "image-size-siblings"');
      await productChange(f);
      const broken = await gate(f, audit({included: ['src/pages/ProductPage.tsx']}), ['src/pages/ProductPage.tsx']);
      assert.equal(broken.status, 'NOT_RUN'); assert.equal(broken.code, 'ESCAPE_RULE_INVALID', JSON.stringify(broken));
      await writeRule(f, good);
      await f.write('.agent-ops-escapes/rules/README.md', 'notes\n');
      assert.equal((await gate(f, audit({included: ['src/pages/ProductPage.tsx']}), ['src/pages/ProductPage.tsx'])).code, 'ESCAPE_RULE_INVALID',
        'a non-rule file in the rules directory fails closed');
    });
  },
  'escape-rule-unsafe': async () => withRepo(PAGES, async f => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-rules-outside-')));
    try {
      await writeFile(join(outside, 'image-size-siblings.json'), JSON.stringify(rule('a'.repeat(40))));
      await productChange(f);
      const surface = audit({included: ['src/pages/ProductPage.tsx']});
      await mkdir(join(f.root, '.agent-ops-escapes'), {recursive: true});
      await symlink(outside, join(f.root, '.agent-ops-escapes/rules'), 'junction');
      const viaDirectory = await gate(f, surface, ['src/pages/ProductPage.tsx']);
      assert.equal(viaDirectory.code, 'ESCAPE_RULE_UNSAFE', JSON.stringify(viaDirectory));
      await rm(join(f.root, '.agent-ops-escapes/rules'), {recursive: true, force: true});
      await mkdir(join(f.root, '.agent-ops-escapes/rules'));
      try {await symlink(join(outside, 'image-size-siblings.json'), join(f.root, '.agent-ops-escapes/rules/image-size-siblings.json'));}
      catch (e) {if (process.platform === 'win32' && e.code === 'EPERM') return; throw e;}
      assert.equal((await gate(f, surface, ['src/pages/ProductPage.tsx'])).code, 'ESCAPE_RULE_UNSAFE', 'a symlinked rule file is never followed');
    } finally {await rm(outside, {recursive: true, force: true});}
  }),
  'escape-rule-fire': async () => withRepo(PAGES, async f => withHome(async home => {
    await productChange(f);
    const surface = audit({included: ['src/pages/ProductPage.tsx']});
    const before = await gate(f, surface, ['src/pages/ProductPage.tsx']);
    assert.equal(before.status, 'PASS', `without a rule the sibling pages stay unseen: ${JSON.stringify(before)}`);
    const marker = join(f.root, 'shell-ran');
    await writeRule(f, rule('a'.repeat(40), {expand: {paths: [], queries: ['product-image-size', `$(touch ${marker})`]}}));
    const fired = await gate(f, surface, ['src/pages/ProductPage.tsx'], {metrics: true, logHome: home});
    assert.equal(fired.status, 'NOT_RUN'); assert.equal(fired.code, 'SURFACE_UNCLASSIFIED', JSON.stringify(fired));
    assert.deepEqual(fired.details.map(d => d.path).sort(), SIBLINGS);
    assert.ok(fired.details.every(d => d.hits.some(h => h.source === 'escape-rule' && h.query === 'rule:image-size-siblings')));
    assert.equal(existsSync(marker), false, 'rule queries are argv, never shell');
    const logged = (await events(home)).filter(e => e.type === 'escape-rule');
    assert.deepEqual(logged.map(({ruleId, included, excluded}) => ({ruleId, included, excluded})), [{ruleId: 'image-size-siblings', included: 1, excluded: 0}]);
    const classified = await gate(f, audit({included: ['src/pages/ProductPage.tsx', ...SIBLINGS]}), ['src/pages/ProductPage.tsx']);
    assert.equal(classified.status, 'PASS', JSON.stringify(classified));
  })),
  'escape-rule-no-fire': async () => withRepo(PAGES, async f => {
    await writeRule(f, rule('a'.repeat(40), {trigger: {paths: ['src/pages/ProductPage.tsx'], tokens: ['LARGE_IMAGE']}}));
    await f.write('src/pages/AboutPage.tsx', 'export function AboutPage() {\n  return <p>About us</p>;\n}\n');
    const result = await gate(f, {...audit({included: ['src/pages/AboutPage.tsx']}), axes: {...audit({included: []}).axes, duplicates: {queries: ['AboutPage']}}},
      ['src/pages/AboutPage.tsx']);
    assert.equal(result.status, 'PASS', `a rule whose trigger the diff does not match adds nothing: ${JSON.stringify(result)}`);
    await f.write('src/pages/AboutPage.tsx', 'export function AboutPage() {\n  return <p>About LARGE_IMAGE</p>;\n}\n');
    const token = await gate(f, {...audit({included: ['src/pages/AboutPage.tsx']}), axes: {...audit({included: []}).axes, duplicates: {queries: ['AboutPage']}}},
      ['src/pages/AboutPage.tsx']);
    assert.equal(token.code, 'SURFACE_UNCLASSIFIED', 'a trigger token on a changed line fires the rule');
  }),
  'escape-rule-no-exclude': async () => withRepo(PAGES, async f => {
    await productChange(f);
    await writeRule(f, rule('a'.repeat(40)));
    const excluded = audit({included: ['src/pages/ProductPage.tsx'], excluded: SIBLINGS});
    const blocked = await gate(f, excluded, ['src/pages/ProductPage.tsx']);
    assert.equal(blocked.status, 'NOT_RUN'); assert.equal(blocked.code, 'ESCAPE_RULE_NO_EXCLUDE', JSON.stringify(blocked));
    assert.deepEqual(blocked.details.map(d => d.path).sort(), SIBLINGS);
    assert.equal((await gate(f, audit({included: ['src/pages/ProductPage.tsx'], unknown: SIBLINGS}), ['src/pages/ProductPage.tsx'])).status, 'PASS',
      'UNKNOWN still classifies a noExclude hit');
    await writeRule(f, rule('a'.repeat(40), {noExclude: false}));
    assert.equal((await gate(f, excluded, ['src/pages/ProductPage.tsx'])).status, 'PASS', 'without noExclude a reasoned exclusion classifies the hit');
  }),
  'escape-proof-surface': async () => withRepo(PAGES, async f => {
    const {declareEscape, escapeCompletionProblem} = await link('declareEscape', 'escapeCompletionProblem');
    await f.pad(10);
    const escaped = await f.commit({'src/pages/ProductPage.tsx': PAGE('ProductPage', 'LARGE')}, 'large product image');
    for (const path of SIBLINGS) await f.write(path, PAGE(path.slice(10, -4), 'LARGE'));
    const origin = {kind: 'escape-of', commit: escaped, label: 'surface'};
    const declare = async () => (await declareEscape({root: f.root, git: f.runner, taskId: 'task-fix', origin, base: escaped, now: '2026-10-14T00:00:00.000Z'})).record;
    const finish = () => escapeCompletionProblem({root: f.root, taskId: 'task-fix', origin, base: escaped});
    let record = await declare();
    assert.deepEqual(record.missedPaths, SIBLINGS);
    assert.equal(record.proof.status, 'unproven'); assert.equal(record.proof.code, 'ESCAPE_RULE_UNPROVEN');
    assert.equal((await finish())?.code, 'ESCAPE_RULE_UNPROVEN', 'no rule: finish refuses');
    await writeRule(f, rule(escaped, {trigger: {paths: ['src/pages/AboutPage.tsx'], tokens: []}}));
    record = await declare();
    assert.match(record.proof.reason, /does not fire/u);
    assert.equal((await finish())?.code, 'ESCAPE_RULE_UNPROVEN', 'a rule that does not fire on the escaped commit proves nothing');
    await writeRule(f, rule(escaped, {expand: {paths: ['src/pages/ComboPage.tsx'], queries: []}}));
    record = await declare();
    assert.match(record.proof.reason, /misses src\/pages\/PackPage\.tsx/u);
    assert.equal((await finish())?.code, 'ESCAPE_RULE_UNPROVEN', 'a rule must hit every missed path');
    await writeRule(f, rule(escaped));
    assert.equal((await finish())?.code, 'ESCAPE_RULE_UNPROVEN', 'a stale ledger record fails closed');
    record = await declare();
    assert.equal(record.proof.status, 'proven', JSON.stringify(record.proof));
    assert.equal(record.proof.rule, 'image-size-siblings');
    assert.equal(await finish(), null, 'a replayed rule that hits every missed path lets finish proceed');
    await writeRule(f, rule(escaped, {noExclude: false}));
    assert.equal((await finish())?.code, 'ESCAPE_RULE_UNPROVEN', 'editing the proving rule makes the record stale');
  }),
  'escape-proof-criteria': async () => {
    const f = await behavioralTask();
    try {
      const {parseArgs} = await load('packages/cli/src/args.js');
      const {runTaskCommand} = await load('packages/cli/src/commands/task.js');
      const escaped = f.baseline;
      await f.declare({kind: 'escape-of', commit: escaped, label: 'criteria'});
      assert.equal(await f.finish(), 'TASK_COMPLETION_REVIEW_REQUIRED', 'advisory, finish goes on to review: a criteria escape names its promoted check');
      await f.declare({kind: 'escape-of', commit: escaped, label: 'criteria', promote: 'regression:related'});
      assert.equal(await f.finish(), 'TASK_COMPLETION_REVIEW_REQUIRED', 'advisory, finish goes on to review: an invariant (never red) check is not a red-to-green promotion');
      const configPath = join(f.root, '.agent-ops/config.json');
      const before = existsSync(configPath) ? await readFile(configPath, 'utf8') : null;
      const printed = await runTaskCommand({args: parseArgs(['task', 'revise', f.id, '--expected-contract', await f.contract(),
        '--escape-of', escaped, '--escape-label', 'verify', '--escape-promote', 'regression:issue', '--reason', 'Promote the regression check.']), service: f.tasks});
      assert.equal(printed.status, 'ok', JSON.stringify(printed));
      assert.match(printed.data.text, /Config proposal \(not written\)/u);
      assert.equal(printed.data.escape.configProposal.verification.commands[0].required, true);
      assert.equal(printed.data.escape.configProposal.verification.commands[0].command, process.execPath);
      assert.equal(existsSync(configPath) ? await readFile(configPath, 'utf8') : null, before, 'agent-ops never writes the config proposal');
      assert.equal(await f.finish(), 'TASK_COMPLETION_REVIEW_REQUIRED', 'a proven red-to-green promoted check satisfies the escape');
    } finally {await f.close();}
  },
  'escape-proof-lesson': async () => withRepo(PAGES, async f => {
    const {declareEscape, escapeCompletionProblem} = await link('declareEscape', 'escapeCompletionProblem');
    const escaped = await f.commit({'src/pages/ProductPage.tsx': PAGE('ProductPage', 'LARGE')}, 'large product image');
    await f.write('src/pages/ComboPage.tsx', PAGE('ComboPage', 'LARGE'));
    for (const label of ['scenario', 'review', 'requirement', 'flagged', 'out-of-model']) {
      const origin = {kind: 'escape-of', commit: escaped, label};
      const {record} = await declareEscape({root: f.root, git: f.runner, taskId: `task-${label}`, origin, base: escaped, now: '2026-10-14T00:00:00.000Z'});
      assert.equal(record.proof.status, 'lesson', `${label}: ${JSON.stringify(record.proof)}`);
      assert.match(record.proof.reason, new RegExp(label, 'u'));
      assert.equal(await escapeCompletionProblem({root: f.root, taskId: `task-${label}`, origin, base: escaped}), null, `${label} does not block`);
    }
  }),
  'escape-backtest-broad': async () => withRepo(PAGES, async f => {
    const {backtestRule, proveEscape} = await rules('backtestRule', 'proveEscape');
    const {declareEscape, escapeCompletionProblem} = await link('declareEscape', 'escapeCompletionProblem');
    for (let i = 0; i < 6; i += 1) await f.commit({'src/pages/ProductPage.tsx': PAGE('ProductPage', `SIZE_${i}`)}, `tweak ${i}`);
    await f.pad(4);
    const escaped = await f.commit({'src/pages/ProductPage.tsx': PAGE('ProductPage', 'LARGE')}, 'large product image');
    for (const path of SIBLINGS) await f.write(path, PAGE(path.slice(10, -4), 'LARGE'));
    await writeRule(f, rule(escaped));
    const origin = {kind: 'escape-of', commit: escaped, label: 'surface'};
    const {record} = await declareEscape({root: f.root, git: f.runner, taskId: 'task-broad', origin, base: escaped, now: '2026-10-14T00:00:00.000Z'});
    assert.equal(record.proof.code, 'ESCAPE_RULE_TOO_BROAD', JSON.stringify(record.proof));
    assert.deepEqual(record.proof.backtest, {commits: 12, fires: 8, rate: 0.667}, 'fires and rate are stored in the ledger record');
    assert.equal((await escapeCompletionProblem({root: f.root, taskId: 'task-broad', origin, base: escaped}))?.code, 'ESCAPE_RULE_TOO_BROAD');
    for (let i = 0; i < 200; i += 1) f.git('commit', '-q', '--allow-empty', '-m', `empty ${i}`);
    const window = await backtestRule(f.root, {rule: rule(escaped), hash: 'window'});
    assert.equal(window.commits, 200, 'only the last 200 first-parent commits count');
    assert.equal(window.fires, 0);
    const proof = await proveEscape({root: f.root, escapeOf: escaped, label: 'surface', missedPaths: SIBLINGS});
    assert.equal(proof.status, 'proven', 'the same rule is narrow over a longer quiet history');
  }),
  'escape-backtest-budget-cache': async () => withRepo(PAGES, async f => {
    const {backtestRule, proveEscape} = await rules('backtestRule', 'proveEscape');
    await f.pad(10);
    const escaped = await f.commit({'src/pages/ProductPage.tsx': PAGE('ProductPage', 'LARGE')}, 'large product image');
    await writeRule(f, rule(escaped));
    const loaded = {rule: rule(escaped), hash: 'h'.repeat(64)};
    await assert.rejects(backtestRule(f.root, loaded, 1), {code: 'SURFACE_BUDGET_EXCEEDED'}, 'over budget never passes silently');
    const over = await proveEscape({root: f.root, escapeOf: escaped, label: 'surface', missedPaths: SIBLINGS, budgetMs: 1});
    assert.equal(over.status, 'unproven'); assert.equal(over.code, 'SURFACE_BUDGET_EXCEEDED');
    const fresh = await backtestRule(f.root, loaded);
    assert.deepEqual(fresh, {commits: 12, fires: 2, rate: 0.167});
    const cache = join(f.root, '.agent-ops/tasks/escape/backtest');
    assert.equal((await readdir(cache)).length, 1, 'the backtest is cached');
    assert.deepEqual(await backtestRule(f.root, loaded, 1), fresh, 'a cached backtest needs no budget');
    await f.commit({'docs/later.md': 'later\n'}, 'later');
    await assert.rejects(backtestRule(f.root, loaded, 1), {code: 'SURFACE_BUDGET_EXCEEDED'}, 'a new HEAD misses the cache');
  }),
  'escape-fix-sibling-page': async () => {
    const f = await behavioralTask();
    try {
      const {parseArgs} = await load('packages/cli/src/args.js');
      const parsed = parseArgs(['task', 'create', '--title', 'Backfill', '--escape-of', 'HEAD~1', '--escape-label', 'surface', '--escape-fix', 'HEAD']);
      assert.equal(parsed.escapeFix, 'HEAD');
      assert.throws(() => parseArgs(['task', 'create', '--title', 'Backfill', '--escape-fix', 'HEAD']), {code: 'CLI_MISSING_VALUE'});
      await f.commit(PAGES, 'pages');
      await f.pad(10);
      const escaped = await f.commit({'src/pages/ProductPage.tsx': PAGE('ProductPage', 'LARGE')}, 'large product image');
      const fix = await f.commit(Object.fromEntries(SIBLINGS.map(path => [path, PAGE(path.slice(10, -4), 'LARGE')])), 'fix sibling pages');
      const plain = await f.contract();
      const declared = await f.declare({kind: 'escape-of', commit: escaped, label: 'surface', fix});
      assert.notEqual(await f.contract(), plain, 'the fix commit is bound into the contract');
      assert.equal(declared.record.fix, fix);
      assert.deepEqual(declared.record.missedPaths, SIBLINGS, 'missed paths come from the fix commit, not the task diff');
      assert.equal(await f.finish(), 'TASK_COMPLETION_REVIEW_REQUIRED', 'advisory, finish goes on to review: red: the sibling-page omission has no proving rule');
      await writeRule(f, rule(escaped));
      assert.equal((await f.declare({kind: 'escape-of', commit: escaped, label: 'surface', fix})).record.proof.status, 'proven');
      assert.equal(await f.finish(), 'TASK_COMPLETION_REVIEW_REQUIRED', 'green: the rule proves the omission');
    } finally {await f.close();}
  },
  'escape-fix-alternate-entry': async () => {
    const f = await behavioralTask();
    try {
      await f.commit({'src/order/tableOrder.ts': 'export const mode = "DINE_IN";\nexport const payload = (table) => ({mode});\n',
        'src/entry/entryCode.ts': 'export const entryMode = "DINE_IN";\nexport const fromEntry = (code) => ({mode: entryMode});\n'}, 'order entry');
      await f.pad(10);
      const escaped = await f.commit({'src/order/tableOrder.ts': 'export const mode = "DINE_IN";\nexport const payload = (table) => ({mode, table_number: table});\n'},
        'send the table number');
      const fix = await f.commit({'src/entry/entryCode.ts': 'export const entryMode = "DINE_IN";\nexport const fromEntry = (code) => ({mode: entryMode, table_number: code});\n'},
        'send the table number from the short-link entry too');
      const origin = {kind: 'escape-of', commit: escaped, label: 'surface', fix};
      const declared = await f.declare(origin);
      assert.deepEqual(declared.record.missedPaths, ['src/entry/entryCode.ts']);
      assert.equal(await f.finish(), 'TASK_COMPLETION_REVIEW_REQUIRED', 'advisory, finish goes on to review: red: the alternate entry path has no proving rule');
      await writeRule(f, {id: 'table-number-entries', escape: escaped, label: 'surface-unseen', trigger: {paths: [], tokens: ['table_number']},
        expand: {paths: [], queries: ['DINE_IN']}, noExclude: true});
      assert.equal((await f.declare(origin)).record.proof.status, 'proven');
      assert.equal(await f.finish(), 'TASK_COMPLETION_REVIEW_REQUIRED', 'green: the rule proves the alternate entry omission');
    } finally {await f.close();}
  },
  'escape-report': async () => withRepo(PAGES, async f => withHome(async home => {
    const {parseArgs} = await load('packages/cli/src/args.js');
    const {runEscapesCommand} = await load('packages/cli/src/commands/escapes.js');
    const {appendLocalLog} = await load('runtime/src/logging/local-log.js');
    assert.equal(parseArgs(['escapes', '--json']).command, 'escapes');
    assert.throws(() => parseArgs(['escapes', '--task', 'x']), {code: 'CLI_OPTION_NOT_ALLOWED'});
    const empty = await runEscapesCommand({root: f.root, home});
    assert.equal(empty.status, 'ok'); assert.equal(empty.data.misses.n, 0); assert.equal(empty.data.misses.status, 'insufficient-data');
    const sha = 'b'.repeat(40);
    const ledger = (id, label, link, at) => f.write(`.agent-ops-escapes/${id}.json`, JSON.stringify({schemaVersion: 1, taskId: id, escapeOf: sha, link,
      agentLabel: 'surface', label, missedPaths: [], facts: [], residualRisks: 0, declaredAt: at}));
    await ledger('task-a', 'surface-unseen', {state: 'ungated'}, '2026-10-01T00:00:00.000Z');
    await ledger('task-b', 'criteria', {state: 'unresolved', reason: 'receipt-not-local'}, '2026-10-05T00:00:00.000Z');
    await f.write('.agent-ops-escapes/task-c.json', '{broken');
    await writeRule(f, rule(sha));
    await writeRule(f, {...rule(sha), id: 'quiet-rule'});
    await f.write('.agent-ops/tasks/state.json', JSON.stringify({tasks: [
      {createdAt: '2026-10-01T00:00:00.000Z', task: {origin: {kind: 'escape-of'}}},
      {createdAt: '2026-10-02T00:00:00.000Z', task: {origin: {kind: 'pre-existing'}, debug: {}}},
      {createdAt: '2026-10-03T00:00:00.000Z', task: {debug: {}}}, {createdAt: '2026-10-04T00:00:00.000Z', task: {}}]}));
    const state = {anchorDirectory: home};
    const log = join(home, '.agent-ops/state/logs/events.ndjson');
    for (let i = 0; i < 10; i += 1)
      await appendLocalLog(log, {type: 'escape-rule', ruleId: 'image-size-siblings', included: 0, excluded: 2}, {...state, now: new Date(Date.now() - i * 1000).toISOString()});
    await appendLocalLog(log, {type: 'gate-catch', code: 'SURFACE_UNCLASSIFIED', taskId: 'task-a'}, state);
    await appendLocalLog(log, {type: 'gate-catch', code: 'REVIEW_FAIL', taskId: 'task-b'}, state);
    const snapshot = async () => {
      const rows = [];
      const walk = async dir => {for (const name of (await readdir(dir)).sort()) {
        const path = join(dir, name), s = await stat(path);
        if (s.isDirectory()) await walk(path); else rows.push(`${path} ${s.size} ${s.mtimeMs}`);
      }};
      await walk(f.root); await walk(home); return rows;
    };
    const before = await snapshot();
    const report = await runEscapesCommand({root: f.root, home});
    assert.deepEqual(await snapshot(), before, 'the report is read-only');
    const d = report.data;
    assert.equal(report.status, 'ok');
    assert.deepEqual(d.misses.counts, {'surface-unseen': 1, criteria: 1}); assert.equal(d.misses.n, 2);
    assert.equal(d.misses.status, 'insufficient-data');
    assert.deepEqual(d.misses.window, {first: '2026-10-01T00:00:00.000Z', last: '2026-10-05T00:00:00.000Z'});
    assert.deepEqual(d.catches.counts, {SURFACE_UNCLASSIFIED: 1, REVIEW_FAIL: 1});
    assert.ok(d.catches.window.first !== null);
    assert.deepEqual(d.origins.counts, {'escape-of': 1, 'pre-existing': 1, undeclared: 1});
    assert.deepEqual(d.links.counts, {ungated: 1, unresolved: 1}); assert.deepEqual(d.links.reasons, {'receipt-not-local': 1});
    const fired = d.rules.find(r => r.id === 'image-size-siblings');
    assert.deepEqual({fires: fired.fires, included: fired.included, excluded: fired.excluded, status: fired.status}, {fires: 10, included: 0, excluded: 20, status: 'ok'});
    assert.equal(d.rules.find(r => r.id === 'quiet-rule').status, 'insufficient-data');
    assert.deepEqual(d.retirementCandidates.map(c => c.id), ['image-size-siblings'], 'retirement is only listed, never applied');
    assert.ok(d.warnings.some(w => w.includes('task-c.json')), 'an unreadable record is a warning, not a failure');
    assert.match(d.text, /insufficient-data/u);
    await f.write('.agent-ops-escapes/rules/bad.json', '{');
    const failOpen = await runEscapesCommand({root: f.root, home});
    assert.equal(failOpen.status, 'ok', 'the report fails open'); assert.ok(failOpen.data.warnings.some(w => w.startsWith('Rules unreadable')));
  })),
  'escape-r2-spec-docs': async () => {
    const section = (text, id) => {
      const source = text.replace(/\r\n/gu, '\n');
      const start = source.indexOf(`## ${id}\n`);
      assert.ok(start >= 0, `missing ${id}`);
      const end = source.indexOf('\n## ', start + 1);
      return source.slice(start, end < 0 ? undefined : end);
    };
    for (const lang of ['en', 'zh-TW']) {
      const rule = section(await readFile(join('docs', lang, 'spec', 'acceptance-and-evidence.md'), 'utf8'), 'EVIDENCE-ESCAPE-002');
      for (const token of ['.agent-ops-escapes/rules/', 'trigger', 'expand', 'noExclude', 'SURFACE_UNCLASSIFIED', 'ESCAPE_RULE_INVALID',
        'ESCAPE_RULE_UNSAFE', 'ESCAPE_RULE_NO_EXCLUDE', 'ESCAPE_RULE_UNPROVEN', 'ESCAPE_RULE_TOO_BROAD', 'SURFACE_BUDGET_EXCEEDED', '200', '30%',
        '--escape-fix', '--escape-promote', 'agent-ops escapes', 'insufficient-data', 'surface.aliases', 'surface stats', 'git grep -F'])
        assert.ok(rule.includes(token), `${lang} EVIDENCE-ESCAPE-002 lacks ${token}`);
    }
    const {harnessDescriptor, managedRules} = await load('runtime/src/install/harness.js');
    for (const id of ['claude', 'codex', 'agy', 'opencode']) {
      const text = managedRules(harnessDescriptor(id), {scope: 'project', profiles: ['core'], capabilities: ['rules', 'task']});
      for (const token of ['--escape-of', 'never blocks finish'])
        assert.ok(text.includes(token), `${id} managed DEBUG text lacks ${token}`);
    }
  }
};

/** Missing behavior surfaces as a failed assertion, so the baseline is red, not broken. */
export const ruleChecks = Object.fromEntries(Object.entries(raw).map(([id, check]) => [id, async () => {
  try {await check();}
  catch (e) {
    if (e?.code === 'ERR_ASSERTION') throw e;
    throw new assert.AssertionError({message: `${id}: ${e?.code ?? ''} ${e?.stack ?? e}`});
  }
}]));
