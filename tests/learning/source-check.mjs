import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {load, withRepository, reviewedCandidate, runner} from '../followup/fixture.mjs';

const {collectLearningSource} = await load('packages/cli/src/commands/learn.js');
const {runWorktreeCommand} = await load('packages/cli/src/commands/parallel.js');
const {parseArgs} = await load('packages/cli/src/args.js');
const {FileLearningStore} = await load('runtime/src/learning/store.js');
const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js');
const {resolveReviewScope} = await load('runtime/src/review/scope.js');

await withRepository(async f => {
  const candidate = await reviewedCandidate(f, {modern: true, goal: 'Fix a source delivery risk'});
  const prepared = await candidate.prepare();
  await assert.rejects(collectLearningSource(f.source, prepared.path), /missing|completion|incomplete/i,
    'An unfinished receipt is not a learning source');
  const finished = await runWorktreeCommand({cwd: f.root, deps: f.deps, args: parseArgs(['worktree', 'finish', candidate.record.name])});
  assert.equal(finished.status, 'ok', JSON.stringify(finished));
  const source = await collectLearningSource(f.source, finished.data.receipt);
  assert.equal(source.taskId, candidate.records[0].task.id);
  assert.equal(source.commit, candidate.head);
  assert.match(source.evidence.diff, /candidate/);
  assert.ok(source.evidence.verification.some(v => v.status === 'PASS'));
  assert.equal(source.evidence.reviews.length, 1);
  assert.ok(source.evidence.reviews[0].report.adversarial);
  assert.equal(source.evidence.task.origin, undefined, 'Normal success never needs a fake escape-of');
  const scope = await resolveReviewScope({root: f.root, runner: runner(f.root), base: candidate.record.base});
  const before = await calculateSourceFingerprint(f.root, scope, runner(f.root));
  const store = new FileLearningStore(f.commonDir);
  await store.archive('trials', {source, status: 'NOT_RUN'});
  await store.recover('retire', 'No proven strategy to activate');
  assert.equal(await calculateSourceFingerprint(f.root, scope, runner(f.root)), before,
    'Private collection, experiment records and pointer writes do not change source fingerprints');
  const original = await readFile(finished.data.receipt, 'utf8');
  await writeFile(finished.data.receipt, original + ' ');
  await assert.rejects(collectLearningSource(f.source, finished.data.receipt), /missing|changed|completion/i,
    'Modified receipt bytes cannot supply learning evidence');
});
