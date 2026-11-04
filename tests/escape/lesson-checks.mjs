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
