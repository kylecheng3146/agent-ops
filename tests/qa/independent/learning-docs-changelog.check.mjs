// Independent QA: configuration guides document the Codex-only catalog id pin; CHANGELOG records it and the 900 s
// learning call deadline under [Unreleased] without a version bump. Run by tests/qa/acceptance.mjs from the checkout root.
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
    const lines = (await read('CHANGELOG.md')).split('\n'), start = lines.indexOf('## [Unreleased]');
    assert.ok(start >= 0, 'CHANGELOG keeps ## [Unreleased]');
    const end = lines.findIndex((line, i) => i > start && line.startsWith('## ['));
    const unreleased = lines.slice(start + 1, end < 0 ? undefined : end).join(' ').replace(/\s+/gu, ' ');
    assert.ok(unreleased.includes('gpt-6.2-sol'), '[Unreleased] records the Codex catalog id pin');
    assert.ok(unreleased.includes('900 s'), '[Unreleased] records the 900 s learning call deadline');
  },
  'no-version-bump-invariant': async () => {
    assert.equal(JSON.parse(await read('package.json')).version, '1.4.2', 'package.json stays at 1.4.2');
    const lines = (await read('CHANGELOG.md')).split('\n'), start = lines.indexOf('## [Unreleased]');
    assert.ok(start >= 0, 'CHANGELOG keeps ## [Unreleased]');
    const next = lines.find((line, i) => i > start && line.startsWith('## ['));
    assert.ok(next?.startsWith('## [1.4.2]'), `The newest release heading stays 1.4.2, got ${next}`);
  }
};
