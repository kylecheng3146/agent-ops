// Independent QA for the 1.4.1 release metadata and notes. Run by tests/qa/acceptance.mjs from the checkout root.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const VERSION = '1.4.1';
const UNRELEASED = '## [Unreleased]';
const HEADING = '## [1.4.1] - 2026-11-23';
const read = async path => (await readFile(resolve(path), 'utf8')).replace(/\r\n/gu, '\n');

async function changelog() {
  const lines = (await read('CHANGELOG.md')).split('\n');
  const unreleased = lines.indexOf(UNRELEASED), released = lines.indexOf(HEADING);
  assert.ok(unreleased >= 0, 'CHANGELOG keeps ## [Unreleased]');
  assert.ok(released > unreleased, 'The dated 1.4.1 heading sits below ## [Unreleased]');
  const next = lines.findIndex((line, index) => index > released && line.startsWith('## '));
  return {lines, unreleased, released, section: lines.slice(released + 1, next < 0 ? undefined : next).join(' ').replace(/\s+/gu, ' ')};
}

export const checks = {
  'qa-release-1-4-1-version-consistency': async () => {
    assert.equal(JSON.parse(await read('package.json')).version, VERSION, 'package.json version');
    const lock = JSON.parse(await read('package-lock.json'));
    assert.equal(lock.version, VERSION, 'package-lock.json root version');
    assert.equal(lock.packages?.['']?.version, VERSION, 'package-lock.json packages[""] version');
    assert.ok((await read('README.md')).includes(`This source release is version ${VERSION}.`), 'README status line names 1.4.1');
    const {lines, unreleased} = await changelog();
    const dated = lines.findIndex(line => /^## \[1\.4\.1\] - \d{4}-\d{2}-\d{2}$/u.test(line));
    assert.ok(dated > unreleased, 'A dated ## [1.4.1] - YYYY-MM-DD heading sits below ## [Unreleased]');
    assert.equal(lines.findIndex(line => line.startsWith('## [') && line !== UNRELEASED), dated, '1.4.1 is the newest release heading');
  },
  'qa-changelog-1-4-1-entries': async () => {
    const {lines, unreleased, released, section} = await changelog();
    assert.deepEqual(lines.slice(unreleased + 1, released).filter(line => line.trim() !== ''), [], '## [Unreleased] is empty');
    assert.match(section, /QA author/u, '1.4.1 notes describe the QA author fix');
    assert.match(section, /clone/u, 'The QA author fix concerns its isolated clone');
    assert.match(section, /AGENT_OPS_QA_TASK_ID/u, 'The QA author gate condition is named');
    assert.match(section, /\.agent-ops\/qa-author-input\.json/u, 'The QA author gate marker file is named');
    assert.match(section, /QA plann(?:ing|er)/u, '1.4.1 notes describe the QA planner fix');
    assert.match(section, /runner/u, 'The planner fix concerns acceptance runners');
    assert.match(section, /command/u, 'The planner now sees what each runner executes (its command)');
    assert.match(section, /\bargs\b/u, 'The planner now sees runner args');
    assert.match(section, /\bcwd\b/u, 'The planner now sees runner cwd');
  }
};
