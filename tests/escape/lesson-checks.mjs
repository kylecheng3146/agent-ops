import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, realpath, rm, symlink, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Escape lesson store and surface gate, on synthetic repositories only. Modules load
// lazily so a build without lessons fails each check as an assertion, never as a crash.
const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const load = async (path, ...names) => {
  let module;
  try {module = await import(pathToFileURL(join(build, path)).href);}
  catch (e) {assert.fail(`${path} is unavailable: ${e.code ?? e.message}`);}
  for (const name of names) assert.equal(typeof module[name], 'function', `${name} is not implemented`);
  return module;
};

async function withRepo(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-lessons-')));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const write = async (path, content) => {await mkdir(dirname(join(root, path)), {recursive: true}); await writeFile(join(root, path), content);};
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Lesson fixture'); git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'core.autocrlf', 'false');
    await write('.gitignore', '.agent-ops/\n');
    await write('src/cart/Cart.ts', 'export function addItem() {\n  return 1;\n}\n');
    await write('src/about/About.ts', 'export function aboutText() {\n  return "about";\n}\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    return await check({root, git, write, base: git('rev-parse', 'HEAD')});
  } finally {await rm(root, {recursive: true, force: true, maxRetries: 10});}
}
async function withHome(check) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-lessons-home-')));
  try {return await check(home);} finally {await rm(home, {recursive: true, force: true, maxRetries: 10});}
}
const events = async home => {
  try {return (await readFile(join(home, '.agent-ops/state/logs/events.ndjson'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));}
  catch (e) {if (e.code === 'ENOENT') return []; throw e;}
};

const NA = reason => ({na: reason});
const surface = (paths, lessons) => ({
  axes: {dependents: NA('Fixture modules import nothing.'), duplicates: NA('Fixture has one module per feature.'),
    otherPaths: NA('Fixture has one entry per feature.'), sharedState: NA('Fixture keeps no shared state.')},
  included: paths.map(path => ({id: path.replace(/\W+/gu, '-').toLowerCase().replace(/^-|-$/gu, ''), path, behavior: `${path} changes.`})),
  excluded: [], unknown: [], contracts: [], valueChanges: [],
  scenarios: {initialState: NA('Fixture has no persisted state.'), redo: NA('Fixture operations are never retried.'),
    timeBoundary: NA('Fixture has no dates or TTLs.'), identitySwitch: NA('Fixture has no tenants.'), concurrency: NA('Fixture has one writer.')},
  ...(lessons === undefined ? {} : {lessons})});
const lesson = (extra = {}) => ({id: 'cart-retry', escape: 'a'.repeat(40), taskId: 'task-fix-cart', label: 'scenario', status: 'lesson',
  cue: 'Cart writes can be retried by the client.', check: 'Does a repeated add keep one line item?', evidence: 'Escape fixed a double add on retry.',
  trigger: {paths: ['src/cart/**'], tokens: ['CART_RETRY']}, backtest: {commits: 20, fires: 2, rate: 0.1},
  reflector: {target: 'claude', attempts: 1}, ...extra});
const noEntry = (id, status = 'no-entry') => ({...lesson({id, status, cue: null, check: null, trigger: null, backtest: null}),
  evidence: 'Reflector found no transferable lesson.'});
const writeLesson = (f, value) => f.write(`.agent-ops-escapes/lessons/${value.id}.json`, JSON.stringify(value, null, 2) + '\n');
async function gate(f, audit, changedFiles, extra = {}) {
  const {runSurfaceGate} = await load('runtime/src/surface/discovery.js', 'runSurfaceGate');
  return runSurfaceGate({root: f.root, taskId: 'task-lessons', surface: audit, required: true, base: f.base, changedFiles, configHash: 'fixture', ...extra});
}
const cartChange = f => f.write('src/cart/Cart.ts', 'export function addItem() {\n  return 2;\n}\n');

// Reflect fixtures: an escaped commit on src/cart, a fix on top, and enough unrelated history for a 30% backtest.
const TASK = 'task-fix-cart';
async function escapeHistory(f, label = 'scenario') {
  for (let i = 0; i < 6; i++) {await f.write(`docs/note-${i}.md`, `note ${i}\n`); f.git('add', '-A'); f.git('commit', '-qm', `note ${i}`);}
  await f.write('src/cart/Cart.ts', 'export function addItem() {\n  return addOnce();\n}\n'); f.git('add', '-A'); f.git('commit', '-qm', 'escaped');
  const escaped = f.git('rev-parse', 'HEAD');
  for (let i = 6; i < 12; i++) {await f.write(`docs/note-${i}.md`, `note ${i}\n`); f.git('add', '-A'); f.git('commit', '-qm', `note ${i}`);}
  const fixBase = f.git('rev-parse', 'HEAD');
  await f.write('src/cart/Cart.ts', 'export function addItem() {\n  return addOnce(RETRY_SAFE_FIX);\n}\n'); f.git('add', '-A'); f.git('commit', '-qm', 'fix');
  if (label !== null) await writeRecord(f, escaped, label);
  return {escaped, fixBase, fix: f.git('rev-parse', 'HEAD')};
}
const writeRecord = (f, escaped, label, taskId = TASK) => f.write(`.agent-ops-escapes/${taskId}.json`, JSON.stringify({schemaVersion: 1, taskId, escapeOf: escaped,
  link: {state: 'ungated'}, agentLabel: label, label, missedPaths: ['src/cart/Cart.ts'], facts: [], residualRisks: 0, declaredAt: '2026-11-04T00:00:00.000Z'}));
const reply = (trigger, extra = {}) => ({ok: true, value: {status: 'lesson', cue: 'Cart writes can be retried by the client.',
  check: 'Does a repeated add keep one line item?', evidence: 'The escape double-added on retry.', trigger, ...extra}});
const CART = {paths: ['src/cart/**'], tokens: []};
/** A scripted reflector: answers in order and records every prompt. */
function fake(...answers) {
  const prompts = [];
  const call = async prompt => {prompts.push(prompt); return answers.length > 1 ? answers.shift() : answers[0];};
  return {call, prompts};
}
async function reflect(f, extra) {
  const {runEscapesReflectCommand} = await load('packages/cli/src/commands/escapes.js', 'runEscapesReflectCommand');
  return runEscapesReflectCommand({root: f.root, taskId: TASK, rerun: false, target: 'fake', task: {goal: 'Adding an item twice on retry keeps one line.',
    criteria: [{id: 'retry-safe', description: 'A retried add keeps one line item.'}]}, ...extra});
}
const stored = async f => JSON.parse(await readFile(join(f.root, `.agent-ops-escapes/lessons/${TASK}.json`), 'utf8'));

const raw = {
  'escape-lesson-store': async () => {
    const {parseLesson, readLessons, loadLessons} = await load('runtime/src/escape/lessons.js', 'parseLesson', 'readLessons', 'loadLessons');
    const good = lesson();
    assert.deepEqual(parseLesson(good, 'cart-retry.json'), good);
    assert.deepEqual(parseLesson(noEntry('cart-none'), 'cart-none.json').trigger, null);
    const bad = [
      [{...good, confidence: 0.9}, 'an extra key'],
      [(({cue, ...rest}) => rest)(good), 'a missing key'],
      [good, 'a file name other than <id>.json', 'other.json'],
      [{...good, id: 'Cart_Retry'}, 'a non-kebab id'],
      [{...good, label: 'surface'}, 'a label without lessons'],
      [{...good, label: 'flagged'}, 'a flagged label'],
      [{...good, status: 'retired'}, 'an unknown status'],
      [{...good, trigger: {paths: [], tokens: ['CART_RETRY']}}, 'a trigger without paths'],
      [{...good, trigger: {paths: ['../outside/**'], tokens: []}}, 'a glob leaving the repository'],
      [{...good, trigger: {...good.trigger, exclude: []}}, 'an extra trigger key'],
      [{...good, backtest: {commits: 10, fires: 5, rate: 0.5}}, 'a trigger broader than 30%'],
      [{...good, escape: 'abc1234'}, 'a short escape commit'],
      [{...noEntry('cart-retry'), cue: 'stray'}, 'a no-entry record carrying a cue']];
    for (const [value, what, file = 'cart-retry.json'] of bad)
      assert.throws(() => parseLesson(value, file), {code: 'ESCAPE_LESSON_INVALID'}, `accepted ${what}`);
    await withRepo(async f => {
      assert.deepEqual(await readLessons(f.root), [], 'no lessons directory means no lessons');
      await writeLesson(f, good); await writeLesson(f, noEntry('cart-none')); await writeLesson(f, noEntry('cart-skipped', 'not-run'));
      assert.deepEqual((await readLessons(f.root)).map(l => l.lesson.status).sort(), ['lesson', 'no-entry', 'not-run'], 'every record is readable');
      assert.deepEqual((await loadLessons(f.root)).map(l => l.lesson.id), ['cart-retry'], 'only status lesson entries match');
      await f.write('.agent-ops-escapes/lessons/README.md', 'notes\n');
      await assert.rejects(loadLessons(f.root), {code: 'ESCAPE_LESSON_INVALID'}, 'a non-lesson file fails closed');
      await rm(join(f.root, '.agent-ops-escapes/lessons/README.md'));
      await f.write('.agent-ops-escapes/lessons/broken.json', '{');
      await assert.rejects(loadLessons(f.root), {code: 'ESCAPE_LESSON_INVALID'}, 'unparseable JSON fails closed');
      await rm(join(f.root, '.agent-ops-escapes/lessons/broken.json'));
      await mkdir(join(f.root, '.agent-ops-escapes/lessons/nested.json'));
      await assert.rejects(loadLessons(f.root), {code: 'ESCAPE_LESSON_UNSAFE'}, 'a non-regular entry fails closed');
      await rm(join(f.root, '.agent-ops-escapes/lessons/nested.json'), {recursive: true});
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-lessons-outside-')));
      try {
        await writeFile(join(outside, 'cart-linked.json'), JSON.stringify(lesson({id: 'cart-linked'})));
        try {await symlink(join(outside, 'cart-linked.json'), join(f.root, '.agent-ops-escapes/lessons/cart-linked.json'));}
        catch (e) {if (process.platform === 'win32' && e.code === 'EPERM') return; throw e;}
        await assert.rejects(loadLessons(f.root), {code: 'ESCAPE_LESSON_UNSAFE'}, 'a symlinked lesson is never followed');
        await rm(join(f.root, '.agent-ops-escapes/lessons'), {recursive: true});
        await symlink(outside, join(f.root, '.agent-ops-escapes/lessons'), 'junction');
        await assert.rejects(loadLessons(f.root), {code: 'ESCAPE_LESSON_UNSAFE'}, 'a symlinked lessons directory is never followed');
      } finally {await rm(outside, {recursive: true, force: true});}
    });
  },
  'escape-lesson-gate': async () => withRepo(async f => {
    const {surfaceAdvisory} = await load('runtime/src/surface/discovery.js', 'surfaceAdvisory');
    await cartChange(f);
    const changed = ['src/cart/Cart.ts'];
    const quiet = await gate(f, surface(changed), changed);
    assert.equal(quiet.status, 'PASS', `no lesson and no lessons key passes as before: ${JSON.stringify(quiet)}`);
    assert.equal(quiet.discovery.cached, false);
    assert.equal((await gate(f, surface(changed), changed)).discovery.cached, true, 'an unchanged run reuses the discovery cache');
    await writeLesson(f, lesson()); await writeLesson(f, noEntry('cart-none'));
    const missing = await gate(f, surface(changed), changed);
    assert.equal(missing.status, 'NOT_RUN'); assert.equal(missing.code, 'LESSON_MISSING', JSON.stringify(missing));
    assert.deepEqual(missing.details.map(d => d.lesson), ['cart-retry'], 'only the fired status lesson entry is named');
    const advisory = surfaceAdvisory(missing).join('\n');
    assert.match(advisory, /LESSON_MISSING/u); assert.match(advisory, /cart-retry/u);
    assert.equal((await gate(f, surface(changed, {other: NA('Unrelated lesson.')}), changed)).code, 'LESSON_MISSING',
      'an answer to another lesson does not answer this one');
    const applies = await gate(f, surface(changed, {'cart-retry': {applies: true, behavior: 'A repeated add keeps one line item.'}}), changed);
    assert.equal(applies.status, 'PASS', JSON.stringify(applies));
    assert.equal(applies.discovery.cached, false, 'a new lesson set misses the old discovery cache');
    const na = await gate(f, surface(changed, {'cart-retry': NA('This change only renames a return value; no write is retried.')}), changed);
    assert.equal(na.status, 'PASS', JSON.stringify(na));
    assert.equal(na.discovery.cached, true, 'answers alone do not change the discovery cache');
    await writeLesson(f, lesson({cue: 'Cart writes can be replayed by the client.'}));
    const edited = await gate(f, surface(changed, {'cart-retry': NA('This change only renames a return value; no write is retried.')}), changed);
    assert.equal(edited.discovery.cached, false, 'an edited lesson under the same HEAD misses the old discovery cache');
    const invalid = await gate(f, surface(changed, {'cart-retry': {applies: true}}), changed);
    assert.equal(invalid.code, 'SURFACE_MISSING', 'an invalid lessons answer is a surface defect');
    assert.equal((await gate(f, surface(changed, {'cart-retry': NA('n/a')}), changed)).code, 'SURFACE_MISSING', 'a bare n/a is no reason');
    // Token trigger: a changed line outside the trigger paths still fires.
    await f.git('checkout', '--', 'src/cart/Cart.ts');
    await f.write('src/about/About.ts', 'export function aboutText() {\n  return "CART_RETRY";\n}\n');
    const token = await gate(f, surface(['src/about/About.ts']), ['src/about/About.ts']);
    assert.equal(token.code, 'LESSON_MISSING', `a trigger token on a changed line fires the lesson: ${JSON.stringify(token)}`);
    await f.write('src/about/About.ts', 'export function aboutText() {\n  return "about us";\n}\n');
    assert.equal((await gate(f, surface(['src/about/About.ts']), ['src/about/About.ts'])).status, 'PASS', 'an unmatched change fires nothing');
    await f.write('.agent-ops-escapes/lessons/bad.json', '{');
    assert.equal((await gate(f, surface(['src/about/About.ts']), ['src/about/About.ts'])).code, 'ESCAPE_LESSON_INVALID',
      'a broken lesson store stops the gate');
  }),
  'escape-lesson-metrics': async () => withRepo(async f => withHome(async home => {
    await cartChange(f);
    const changed = ['src/cart/Cart.ts'];
    await writeLesson(f, lesson()); await writeLesson(f, lesson({id: 'cart-total', trigger: {paths: ['src/cart/Cart.ts'], tokens: []}}));
    await writeLesson(f, lesson({id: 'about-copy', trigger: {paths: ['src/about/**'], tokens: []}}));
    const answered = surface(changed, {'cart-retry': {applies: true, behavior: 'A repeated add keeps one line item.'},
      'cart-total': NA('Totals are computed elsewhere and untouched here.')});
    assert.equal((await gate(f, answered, changed, {metrics: true, logHome: home})).status, 'PASS');
    assert.equal((await gate(f, surface(changed), changed, {metrics: true, logHome: home})).code, 'LESSON_MISSING');
    const rows = (await events(home)).filter(e => e.type === 'escape-lesson').map(({lessonId, answer}) => `${lessonId}:${answer}`);
    assert.deepEqual(rows.sort(), ['cart-retry:applies', 'cart-retry:unanswered', 'cart-total:na', 'cart-total:unanswered'],
      'each fired lesson records its answer; an unfired lesson records nothing');
    const blockedHome = join(home, 'not-a-directory');
    await writeFile(blockedHome, 'file');
    assert.equal((await gate(f, answered, changed, {metrics: true, logHome: blockedHome})).status, 'PASS', 'a log write failure never changes PASS');
    assert.equal((await gate(f, surface(changed), changed, {metrics: true, logHome: blockedHome})).code, 'LESSON_MISSING',
      'a log write failure never hides LESSON_MISSING');
  })),
  'escape-lesson-reflect': async () => withRepo(async f => {
    const {parseArgs} = await load('packages/cli/src/args.js', 'parseArgs');
    assert.throws(() => parseArgs(['escapes', 'reflect']), {code: 'CLI_MISSING_VALUE'}, '--task is required');
    assert.throws(() => parseArgs(['escapes', 'reflect', '--task', TASK, '--yes']), {code: 'CLI_UNKNOWN_OPTION'});
    assert.throws(() => parseArgs(['escapes', '--task', TASK]), {code: 'CLI_OPTION_NOT_ALLOWED'}, 'the report takes no reflect options');
    const parsed = parseArgs(['escapes', 'reflect', '--task', TASK, '--fix', 'abc1234', '--rerun', '--json']);
    assert.deepEqual([parsed.command, parsed.action, parsed.taskId, parsed.escapeFix, parsed.rerun, parsed.json], ['escapes', 'reflect', TASK, 'abc1234', true, true]);
    const help = parseArgs(['escapes', 'reflect', '--help']);
    assert.equal(help.helpTopic, 'escapes');
    const {COMMAND_HELP_TEXT} = await load('packages/cli/src/cli.js');
    for (const flag of ['escapes reflect --task <id>', '--fix <sha>', '--rerun', '--json', 'ESCAPE_LESSON_INELIGIBLE'])
      assert.ok(COMMAND_HELP_TEXT?.escapes?.includes(flag), `escapes help documents ${flag}`);
    const {readLessons} = await load('runtime/src/escape/lessons.js', 'readLessons');
    const h = await escapeHistory(f);
    // A valid trigger: status lesson, one call, DATA carries both diffs, missed paths, goal and criteria.
    let r = fake(reply(CART));
    let out = await reflect(f, {call: r.call, base: h.fixBase});
    assert.equal(out.status, 'ok'); assert.equal(out.data.lesson.status, 'lesson', JSON.stringify(out.data.lesson));
    assert.equal(r.prompts.length, 1);
    for (const needle of ['RETRY_SAFE_FIX', 'addOnce()', 'src/cart/Cart.ts', 'Adding an item twice', 'retry-safe', 'BEGIN UNTRUSTED DATA'])
      assert.ok(r.prompts[0].includes(needle), `reflector DATA carries ${needle}`);
    let saved = await stored(f);
    assert.deepEqual([saved.id, saved.taskId, saved.escape, saved.label, saved.reflector], [TASK, TASK, h.escaped, 'scenario', {target: 'fake', attempts: 1}]);
    assert.ok(saved.backtest.rate <= 0.3 && saved.backtest.commits > 0, JSON.stringify(saved.backtest));
    assert.deepEqual((await readLessons(f.root)).map(l => l.lesson.id), [TASK], 'one schema-valid record names the task');
    // Too broad, then valid: the second call carries the reason.
    r = fake(reply({paths: ['**'], tokens: []}), reply(CART));
    out = await reflect(f, {call: r.call, base: h.fixBase});
    assert.equal(out.data.lesson.status, 'lesson'); assert.equal(r.prompts.length, 2);
    assert.match(r.prompts[1], /ESCAPE_LESSON_TOO_BROAD/u, 'the retry names the rejection');
    assert.equal((await stored(f)).reflector.attempts, 2);
    // Misses the escaped commit twice: not-run after exactly two calls.
    r = fake(reply({paths: ['src/about/**'], tokens: []}));
    out = await reflect(f, {call: r.call, base: h.fixBase});
    assert.equal(out.status, 'ok'); assert.equal(out.data.lesson.status, 'not-run'); assert.equal(r.prompts.length, 2);
    assert.match(r.prompts[1], /ESCAPE_LESSON_UNPROVEN/u); assert.match((await stored(f)).evidence, /ESCAPE_LESSON_UNPROVEN/u);
    // A launch failure is not-run, not an error, and is not retried.
    r = fake({ok: false, code: 'ESCAPE_REFLECT_MISSING_EXECUTABLE'});
    out = await reflect(f, {call: r.call, base: h.fixBase});
    assert.equal(out.status, 'ok'); assert.equal(out.data.lesson.status, 'not-run'); assert.equal(r.prompts.length, 1);
    assert.equal((await reflect(f, {call: null, target: null, base: h.fixBase})).data.lesson.status, 'not-run', 'no configured target is not-run');
    // NO_ENTRY overwrites the earlier record for the same task.
    r = fake({ok: true, value: {status: 'NO_ENTRY', cue: null, check: null, evidence: 'A one-off typo; nothing transfers.', trigger: null}});
    out = await reflect(f, {call: r.call, base: h.fixBase});
    assert.equal(out.data.lesson.status, 'no-entry'); assert.equal((await stored(f)).evidence, 'A one-off typo; nothing transfers.');
    assert.deepEqual((await readLessons(f.root)).length, 1, 'a rerun replaces the record instead of adding one');
    // --fix replaces base..HEAD: the named commit's diff is the fix diff.
    r = fake(reply(CART));
    await reflect(f, {call: r.call, base: null, fix: h.escaped});
    assert.ok(!r.prompts[0].includes('RETRY_SAFE_FIX'), 'the fix diff comes from --fix, not base..HEAD');
    await assert.rejects(reflect(f, {call: r.call, base: null}), {code: 'ESCAPE_REFLECT_FIX_REQUIRED'});
    // --rerun adds the latest review findings in one more call.
    await assert.rejects(reflect(f, {call: r.call, base: h.fixBase, rerun: true}), {code: 'ESCAPE_REFLECT_NO_REVIEW'});
    const {writePrivateFile} = await load('runtime/src/security/permissions.js', 'writePrivateFile');
    const artifact = (createdAt, title) => JSON.stringify({schemaVersion: 2, sourceFingerprint: 'f'.repeat(64), taskId: TASK, status: 'FAIL', createdAt,
      report: {findings: [{severity: 'important', blocking: true, title}]}});
    await writePrivateFile(join(f.root, `.agent-ops/reviews/${'a'.repeat(64)}.${TASK}.reports.json`), artifact('2026-11-01T00:00:00.000Z', 'Old finding'), f.root);
    await writePrivateFile(join(f.root, `.agent-ops/reviews/${'b'.repeat(64)}.${TASK}.reports.json`), artifact('2026-11-02T00:00:00.000Z', 'The lesson cue is vague'), f.root);
    r = fake(reply(CART));
    await reflect(f, {call: r.call, base: h.fixBase, rerun: true});
    assert.equal(r.prompts.length, 1); assert.match(r.prompts[0], /The lesson cue is vague/u); assert.ok(!r.prompts[0].includes('Old finding'));
    // Concurrent reflects of one task run one after another and leave one valid record.
    let active = 0, peak = 0;
    const slow = async () => {active += 1; peak = Math.max(peak, active); await new Promise(res => setTimeout(res, 50)); active -= 1; return reply(CART);};
    const both = await Promise.all([reflect(f, {call: slow, base: h.fixBase}), reflect(f, {call: slow, base: h.fixBase})]);
    assert.equal(peak, 1, 'the second reflect waited for the first');
    assert.deepEqual(both.map(o => o.data.lesson.status), ['lesson', 'lesson']);
    assert.equal((await readLessons(f.root)).length, 1);
    // The real CLI: no review role configured is a not-run record and exit 0.
    const bin = join(build, 'packages/cli/src/bin.js');
    const cli = execFileSync(process.execPath, [bin, 'escapes', 'reflect', '--task', TASK, '--fix', h.fix, '--json'], {cwd: f.root, encoding: 'utf8'});
    const envelope = JSON.parse(cli);
    assert.equal(envelope.code, 'ESCAPE_LESSON_WRITTEN'); assert.equal(envelope.data.lesson.status, 'not-run');
  }),
  'escape-lesson-reflect-ineligible': async () => withRepo(async f => {
    const h = await escapeHistory(f, null);
    const lessons = join(f.root, '.agent-ops-escapes/lessons');
    const r = fake(reply(CART));
    await assert.rejects(reflect(f, {call: r.call, base: h.fixBase}), {code: 'ESCAPE_LESSON_INELIGIBLE'}, 'no escape record');
    for (const label of ['surface', 'criteria', 'verify', 'flagged', 'out-of-model', 'surface-excluded']) {
      await writeRecord(f, h.escaped, label);
      await assert.rejects(reflect(f, {call: r.call, base: h.fixBase}), {code: 'ESCAPE_LESSON_INELIGIBLE'}, `label ${label}`);
    }
    assert.equal(r.prompts.length, 0, 'an ineligible task never calls the reflector');
    await assert.rejects(readFile(join(lessons, `${TASK}.json`)), {code: 'ENOENT'}, 'no file is written');
    const bin = join(build, 'packages/cli/src/bin.js');
    let failed;
    try {execFileSync(process.execPath, [bin, 'escapes', 'reflect', '--task', TASK, '--json'], {cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});}
    catch (e) {failed = e;}
    assert.ok(failed && failed.status !== 0, 'the CLI exits non-zero');
    assert.match(failed.stdout + failed.stderr, /ESCAPE_LESSON_INELIGIBLE/u);
  }),
  'escape-lesson-finish': async () => withRepo(async f => {
    const {checkTaskCompletionEvidence} = await load('runtime/src/task/completion.js', 'checkTaskCompletionEvidence');
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js');
    const escaped = f.base;
    const config = {schemaVersion: 3, profiles: ['core'], verification: {commands: [
      {id: 'unit', command: 'node', args: ['--test'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}]},
    features: {completionGate: {enabled: false}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};
    const finish = async (origin, taskId = TASK) => {
      const record = {task: {schemaVersion: 2, id: taskId, title: 'Fix', criteria: [{id: 'a', description: 'Holds.', verifierIds: ['unit']},
        {id: 'b', description: 'Holds too.', verifierIds: ['unit']}], ...(origin === undefined ? {} : {origin})},
        status: 'active', evidence: {}, createdSourceCommit: f.base, failureFingerprint: null, policyConfigHash: 'x',
        createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', completedAt: null, archivedAt: null};
      return (await checkTaskCompletionEvidence(record, {root: f.root, config, sourceFingerprint: 'f'.repeat(64),
        evidenceStore: new FileEvidenceStore(f.root, f.root)}))?.code ?? null;
    };
    const of = label => ({kind: 'escape-of', commit: escaped, label});
    for (const label of ['scenario', 'requirement', 'review']) {
      assert.equal(await finish(of(label)), 'ESCAPE_LESSON_MISSING', `a ${label} escape without a lesson record`);
      await writeRecord(f, escaped, label);
      assert.equal(await finish(of(label)), 'ESCAPE_LESSON_MISSING', `a ${label} ledger record without a lesson record`);
    }
    await writeLesson(f, lesson({id: 'other-task', taskId: 'task-other'}));
    assert.equal(await finish(of('scenario')), 'ESCAPE_LESSON_MISSING', "another task's lesson does not count");
    for (const status of ['lesson', 'no-entry', 'not-run']) {
      await rm(join(f.root, '.agent-ops-escapes/lessons'), {recursive: true, force: true});
      // Hand-written records, as an agent writes no-entry after a --rerun rejection.
      await writeLesson(f, status === 'lesson' ? lesson({id: TASK, taskId: TASK, escape: escaped, label: 'review'}) :
        {...noEntry(TASK, status), taskId: TASK, escape: escaped, label: 'review', evidence: 'Review rejected the lesson twice: the cue was task-specific.'});
      const code = await finish(of('review'));
      assert.notEqual(code, 'ESCAPE_LESSON_MISSING', `a ${status} record lets finish pass the lesson gate`);
      assert.equal(code, 'TASK_STALE', 'the remaining gates still apply');
    }
    await rm(join(f.root, '.agent-ops-escapes/lessons'), {recursive: true, force: true});
    assert.equal(await finish(undefined, 'task-plain'), 'TASK_STALE', 'a task without an escape completes as before');
    for (const label of ['flagged', 'out-of-model', 'surface', 'criteria', 'verify'])
      assert.equal(await finish(of(label), `task-${label}`), 'TASK_STALE', `a ${label} escape needs no lesson`);
    await writeRecord(f, escaped, 'surface-excluded');
    assert.equal(await finish(of('scenario')), 'TASK_STALE', 'the ledger primary label wins over the declared one');
  }),
  'escape-lesson-report': async () => withRepo(async f => withHome(async home => {
    const {runEscapesCommand} = await load('packages/cli/src/commands/escapes.js', 'runEscapesCommand');
    const {appendLocalLog} = await load('runtime/src/logging/local-log.js', 'appendLocalLog');
    const {localStatePaths} = await load('runtime/src/security/permissions.js', 'localStatePaths');
    await writeRecord(f, f.base, 'scenario');
    await writeLesson(f, lesson({id: 'cart-quiet'})); await writeLesson(f, lesson({id: 'cart-useful'})); await writeLesson(f, noEntry('cart-none'));
    const state = localStatePaths(home);
    const log = (lessonId, answer) => appendLocalLog(join(state.logDirectory, 'events.ndjson'), {type: 'escape-lesson', lessonId, answer}, {anchorDirectory: state.anchorDirectory});
    for (let i = 0; i < 10; i++) await log('cart-quiet', i % 2 ? 'na' : 'unanswered');
    for (const answer of ['applies', 'na', 'unanswered', 'na', 'na', 'na', 'na', 'na', 'na', 'na', 'na']) await log('cart-useful', answer);
    const before = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {cwd: f.root, encoding: 'utf8'});
    const {data} = await runEscapesCommand({root: f.root, home});
    const row = id => data.lessons.find(l => l.id === id);
    assert.deepEqual(data.lessons.map(l => l.id).sort(), ['cart-quiet', 'cart-useful'], 'only status lesson entries are listed');
    assert.deepEqual([row('cart-quiet').fires, row('cart-quiet').applies, row('cart-quiet').na], [10, 0, 5]);
    assert.deepEqual([row('cart-useful').fires, row('cart-useful').applies, row('cart-useful').na], [11, 1, 9]);
    assert.deepEqual(data.lessonRetirementCandidates.map(c => c.id), ['cart-quiet'], 'fired >= 10 with zero applies');
    assert.match(data.text, /Lessons: 2/u); assert.match(data.text, /cart-quiet \(scenario\): fires 10, applies 0, na 5/u);
    assert.match(data.text, /Lesson retirement candidates: cart-quiet/u);
    assert.equal(data.misses.n, 1, 'lesson files are never read as escape records');
    assert.deepEqual(data.warnings.filter(w => /lesson/iu.test(w)), [], 'the lesson store reads cleanly');
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {cwd: f.root, encoding: 'utf8'}), before, 'the report deletes or writes nothing');
    const cli = JSON.parse(execFileSync(process.execPath, [join(build, 'packages/cli/src/bin.js'), 'escapes', '--json'], {cwd: f.root, encoding: 'utf8',
      env: {...process.env, AGENT_OPS_HOME: home}}));
    assert.deepEqual(cli.data.lessonRetirementCandidates.map(c => c.id), ['cart-quiet'], 'escapes --json carries the lessons section');
  }))
};

/** Missing behavior surfaces as a failed assertion, so the baseline is red, not broken. */
export const lessonChecks = Object.fromEntries(Object.entries(raw).map(([id, check]) => [id, async () => {
  try {await check();}
  catch (e) {
    if (e?.code === 'ERR_ASSERTION') throw e;
    throw new assert.AssertionError({message: `${id}: ${e?.code ?? ''} ${e?.stack ?? e}`});
  }
}]));
