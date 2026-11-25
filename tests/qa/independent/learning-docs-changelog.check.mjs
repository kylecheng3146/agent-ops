// Independent QA: configuration guides document the Codex-only catalog id pin; CHANGELOG records it and the 900 s
// learning call deadline (first under [Unreleased], released in 1.4.3). Run by tests/qa/acceptance.mjs from the checkout root.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const read = async path => (await readFile(resolve(path), 'utf8')).replace(/\r\n/gu, '\n');

/** Text of the `## heading` section up to the next `## ` heading, line breaks folded. */
async function section(path, heading) {
  const lines = (await read(path)).split('\n'), start = lines.indexOf(heading);
  assert.ok(start >= 0, `${path} has ${heading}`);
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

const guides = [
  {path: 'docs/en/guides/configuration.md', heading: '## Automatic learning registration', fold: ' ', split: /\.\s+/u,
    codex: /target\s+`codex`/u, negation: /\bnot\b|n't/u},
  {path: 'docs/zh-TW/guides/configuration.md', heading: '## 自動學習註冊', fold: '', split: /。/u,
    codex: /target\s*為\s*`codex`/u, negation: /不/u}
];

export const checks = {
  'docs-and-changelog-entries': async () => {
    for (const g of guides) {
      const text = (await section(g.path, g.heading)).replace(/\s*\n\s*/gu, g.fold);
      const sentences = text.split(g.split);
      assert.ok(sentences.some(s => s.includes('gpt-6.2-sol') && g.codex.test(s)),
        `${g.path} scopes gpt-6.2-sol to target codex in its learning registration section`);
      assert.ok(sentences.some(s => /effort/iu.test(s) && s.includes('-high') && g.negation.test(s)),
        `${g.path} says an effort word such as -high is not accepted as a catalog name`);
    }
    // ponytail: whole-file match; the entries moved from [Unreleased] to [1.4.3] at release.
    const changelog = (await read('CHANGELOG.md')).replace(/\s+/gu, ' ');
    assert.ok(changelog.includes('gpt-6.2-sol'), 'CHANGELOG records the Codex catalog id pin');
    assert.ok(changelog.includes('900 s'), 'CHANGELOG records the 900 s learning call deadline');
  }
};
