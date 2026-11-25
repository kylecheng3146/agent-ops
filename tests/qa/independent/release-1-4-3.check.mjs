// Independent QA for the 1.4.3 release: version metadata, release notes, and the learning docs/changelog check
// staying release-safe without losing its guide and changelog assertions. Run by tests/qa/acceptance.mjs from the
// checkout root.
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

const VERSION = '1.4.3';
const UNRELEASED = '## [Unreleased]';
const HEADING = '## [1.4.3] - 2026-11-25';
const PREVIOUS = '## [1.4.2] - 2026-11-24';
const OLDER = '## [1.4.1] - 2026-11-23';
const LEARNING_CHECK = new URL('./learning-docs-changelog.check.mjs', import.meta.url);

const read = async path => (await readFile(resolve(path), 'utf8')).replace(/\r\n/gu, '\n');
const fold = lines => lines.join(' ').replace(/\s+/gu, ' ');

/** Lines of the section under `heading` up to the next `## ` heading. */
function sectionLines(lines, heading) {
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `CHANGELOG has ${heading}`);
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** Asserts [Unreleased] is the first ## heading and holds only blank lines before the dated 1.4.3 heading. */
async function releasedChangelog() {
  const lines = (await read('CHANGELOG.md')).split('\n');
  const headings = lines.map((line, i) => ({line, i})).filter(h => h.line.startsWith('## '));
  assert.equal(headings[0]?.line, UNRELEASED, 'The first ## heading is ## [Unreleased]');
  assert.equal(headings[1]?.line, HEADING, `${HEADING} directly follows ## [Unreleased]`);
  assert.deepEqual(lines.slice(headings[0].i + 1, headings[1].i).filter(line => line.trim() !== ''), [],
    '## [Unreleased] holds only blank lines');
  const released = lines.indexOf(HEADING), previous = lines.indexOf(PREVIOUS), older = lines.indexOf(OLDER);
  assert.ok(previous > released, `${PREVIOUS} is preserved below ${HEADING}`);
  assert.ok(older > previous, `${OLDER} is preserved below ${PREVIOUS}`);
  return lines;
}

// Minimal guides that satisfy the learning check; mutations below break exactly one requirement each.
const EN_GUIDE = `# Configuration

## Automatic learning registration

Under target \`codex\` an exact catalog id such as \`gpt-6.2-sol\` is accepted as a
fixed model. An effort word such as \`-high\` is not accepted as a catalog name.

## Other settings

Nothing here.
`;
const ZH_GUIDE = `# 設定

## 自動學習註冊

target 為 \`codex\` 時，精確的目錄 id（例如 \`gpt-6.2-sol\`）可作為固定模型。
effort 字詞（例如 \`-high\`）不會被接受為目錄名稱。

## 其他設定

此處無內容。
`;
const ENTRIES = `- Automatic learning accepts an exact Codex catalog id such as \`gpt-6.2-sol\`
  under target \`codex\`.
- A learning experiment call now has 900 s instead of 300 s.
`;
const UNRELEASED_CHANGELOG = `# Changelog

${UNRELEASED}

${ENTRIES}
${PREVIOUS}

- Earlier release notes.
`;
const RELEASED_CHANGELOG = `# Changelog

${UNRELEASED}

${HEADING}

${ENTRIES}
${PREVIOUS}

- Earlier release notes.
`;
const BASE = {
  'docs/en/guides/configuration.md': EN_GUIDE,
  'docs/zh-TW/guides/configuration.md': ZH_GUIDE,
  'CHANGELOG.md': UNRELEASED_CHANGELOG
};

async function learningCheck() {
  const {checks} = await import(LEARNING_CHECK.href);
  assert.equal(typeof checks?.['docs-and-changelog-entries'], 'function', 'docs-and-changelog-entries is exported');
  return checks;
}

/** Runs `fn` with cwd set to a fresh temp dir holding `files`; restores cwd and removes the dir afterwards. */
async function inFixture(files, fn) {
  const cwd = process.cwd(), dir = await mkdtemp(join(tmpdir(), 'qa-release-1-4-3-'));
  try {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), {recursive: true});
      await writeFile(join(dir, path), text);
    }
    process.chdir(dir);
    return await fn();
  } finally {
    process.chdir(cwd);
    await rm(dir, {recursive: true, force: true});
  }
}

/** Replaces `from` with `to` in one fixture file, asserting the mutation actually changed it. */
function mutate(path, from, to) {
  const text = BASE[path].replace(from, to);
  assert.notEqual(text, BASE[path], `Mutation of ${path} applies`);
  return {...BASE, [path]: text};
}

export const checks = {
  'qa-release-1-4-3-metadata': async () => {
    assert.equal(JSON.parse(await read('package.json')).version, VERSION, 'package.json version');
    const lock = JSON.parse(await read('package-lock.json'));
    assert.equal(lock.version, VERSION, 'package-lock.json root version');
    assert.equal(lock.packages?.['']?.version, VERSION, 'package-lock.json packages[""] version');
    const readme = await read('README.md');
    assert.ok(readme.includes(`This source release is version ${VERSION}.`), 'README status line names 1.4.3');
    assert.ok(!readme.includes('This source release is version 1.4.2.'), 'README no longer names 1.4.2');
    await releasedChangelog();
  },

  'qa-release-1-4-3-changelog-entries': async () => {
    const lines = await releasedChangelog();
    // Each required item must be recorded within a single bullet of the 1.4.3 section.
    const bullets = sectionLines(lines, HEADING).join('\n').split(/\n(?=- )/u).map(b => b.replace(/\s+/gu, ' '));
    const items = {
      'Codex catalog id pin': [/gpt-6\.2-sol/u, /`codex`/u],
      '900 s learning call deadline': [/900 s/u, /learning/iu],
      'agent-ops qa show explanations': [/`agent-ops qa show`/u, /explain/iu],
      'planning at first QA run with qa plan reuse and --replan --reason':
        [/(?:verify --task|qa run)/u, /`qa plan` reuses/u, /--replan --reason/u],
      'private uncommitted QA materials': [/\.git\/agent-ops\/qa\/materials\//u, /untracked/u],
      'QA provider-limit host failover': [/provider limit/iu, /host/u, /QA_PROVIDER_LIMIT/u, /qa-session/u],
      'Claude stream-json provider limits and once-per-session cost':
        [/stream-json/u, /api_error/u, /rate_limit_event/u, /cost once/u]
    };
    for (const [name, patterns] of Object.entries(items))
      assert.ok(bullets.some(b => patterns.every(p => p.test(b))), `1.4.3 notes record: ${name}`);
    const previous = fold(sectionLines(lines, PREVIOUS)), older = fold(sectionLines(lines, OLDER));
    assert.match(previous, /surface reclassification/u, '1.4.2 notes keep the QA reuse entry');
    assert.match(previous, /planner output limit/u, '1.4.2 notes keep the planner output limit entry');
    assert.doesNotMatch(previous, /gpt-6\.2-sol|900 s/u, '1.4.3 entries were not filed under 1.4.2');
    assert.match(older, /AGENT_OPS_QA_TASK_ID/u, '1.4.1 notes keep the QA author gate entry');
  },

  'qa-learning-check-release-safe': async () => {
    const learning = await learningCheck();
    assert.equal(learning['no-version-bump-invariant'], undefined, 'no-version-bump-invariant is no longer exported');
    await inFixture({...BASE, 'CHANGELOG.md': RELEASED_CHANGELOG}, () => learning['docs-and-changelog-entries']());
    await learning['docs-and-changelog-entries'](); // checkout root
  },

  'qa-learning-check-rejects-violations': async () => {
    const run = (await learningCheck())['docs-and-changelog-entries'];
    await inFixture(BASE, run);
    const en = 'docs/en/guides/configuration.md', zh = 'docs/zh-TW/guides/configuration.md';
    const mutations = {
      'English guide without gpt-6.2-sol scoped to target codex': mutate(en, 'target `codex`', 'target `claude`'),
      'English guide without the effort/-high refusal': mutate(en, 'is not accepted', 'is accepted'),
      'Traditional Chinese guide without gpt-6.2-sol scoped to target codex': mutate(zh, '為 `codex`', '為 `claude`'),
      'Traditional Chinese guide without the effort/-high refusal': mutate(zh, '不會被接受', '會被接受'),
      'CHANGELOG without gpt-6.2-sol': mutate('CHANGELOG.md', 'gpt-6.2-sol', 'gpt-6.2'),
      'CHANGELOG without 900 s': mutate('CHANGELOG.md', '900 s', '15 minutes')
    };
    for (const [name, files] of Object.entries(mutations))
      await assert.rejects(inFixture(files, run), {code: 'ERR_ASSERTION'}, `Rejects: ${name}`);
  }
};
