import assert from 'node:assert/strict';
import {lstat, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {followupModules, withRepository, reviewedCandidate, load, checkedGit, runner, config, finding} from './fixture.mjs';

async function assessmentModule() {
  try {return await load('runtime/src/review/followup.js');}
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') assert.fail('Current-source followup assessment must exist');
    throw error;
  }
}

export const report = (conclusion = 'PRESENT', overrides = {}) => ({summary: conclusion,
  results: [{criterionId: 'followup-assessment', status: 'PASS',
    summary: conclusion === 'ABSENT'
      ? 'The cited replacement statement has no unsafe branch; inspection of its callers confirms the original branch is no longer reachable.'
      : 'The original unsafe branch remains in the inspected current source; the cited statement still takes that branch.',
    evidence: ['source.txt:1: candidate candidate']}], findings: [], residualRisks: [],
  changedFilesInspected: [], supportingFilesInspected: ['source.txt'], ...overrides});

function bytes(text) {return {async *[Symbol.asyncIterator]() {if (text) yield Buffer.from(text);}};}

/** Real clone/snapshot execution, scripted model transport at the existing process boundary. */
export async function reviewer(f, scripts = [report(), report()], extra = {}) {
  const {NodeVerificationProcessRunner} = await load('runtime/src/verify/spawn.js');
  const native = new NodeVerificationProcessRunner();
  const calls = [], helps = [];
  let index = 0;
  const processRunner = {start(request) {
    if (request.command === 'git') return native.start(request);
    if (request.args.includes('--help')) {
      helps.push(request);
      return {pid: null, stdout: bytes('--add-dir --permission-mode --no-session-persistence --safe-mode --disable-slash-commands --json-schema'),
        stderr: bytes(''), completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => {}};
    }
    calls.push(request);
    const script = scripts[index++] ?? report();
    let end;
    const completion = script.hang ? new Promise(resolve => {end = resolve;}) : Promise.resolve().then(async () => {
      assert.notEqual(request.cwd, f.root);
      assert.equal(await readFile(join(request.cwd, 'source.txt'), 'utf8'), 'candidate candidate\n');
      assert.ok(request.args.includes('--permission-mode') && request.args.includes('plan'));
      assert.ok(request.args.includes('--safe-mode') && request.args.includes('--no-session-persistence'));
      assert.match(request.stdin, /original.*provenance.*finding/su);
      assert.doesNotMatch(request.stdin, /Machine verification \(runtime-owned\)/u);
      await script.before?.(request);
      return {exitCode: 0, signal: null};
    });
    return {pid: null, stdout: bytes(typeof script === 'string' ? script : script.hang ? '' : JSON.stringify({structured_output: script})),
      stderr: bytes(''), completion, terminateTree: async () => end?.({exitCode: null, signal: 'SIGTERM'})};
  }};
  return {calls, helps, options: {targets: ['claude'], runner: processRunner,
    probeBind: async () => true, preflightTarget: async () => 'ok', env: {}, timeoutMs: 2000, ...extra}};
}

export async function withAssessment(check) {
  const api = await assessmentModule();
  const modules = await followupModules();
  await withRepository(async f => {
    const {finishWorktree} = await load('runtime/src/parallel/finish.js');
    const candidate = await reviewedCandidate(f);
    await finishWorktree(f.deps, {cwd: f.root, name: candidate.record.name});
    const store = new modules.FileFollowupStore(f.commonDir);
    const items = (await store.read()).items, item = items.find(item => item.kind === 'candidate');
    const options = review => ({root: f.root, commonDir: f.commonDir, itemId: item.id, targetBranch: 'main',
      gitRunner: runner(f.root), loadConfig: async () => config, review});
    await check({f, store, item, items, options, api, modules});
  });
}

export const assessmentChecks = {
  'followup-assessment-semantics': () => withAssessment(async ({f, store, item, items, options, api, modules}) => {
    const before = await readFile(store.path, 'utf8');
    const receipt = await readFile(item.provenance.receiptPath, 'utf8');
    await writeFile(item.provenance.receiptPath, `${receipt} `);
    const untrusted = await reviewer(f);
    const rejected = await api.assessFollowup(options(untrusted.options));
    assert.equal(rejected.assessment.conclusion, 'UNKNOWN');
    assert.equal(untrusted.calls.length, 0, 'Tampered original receipt cannot authorize assessment');
    await writeFile(item.provenance.receiptPath, receipt);
    for (const conclusion of ['PRESENT', 'ABSENT']) {
      const mock = await reviewer(f, [report(conclusion), report(conclusion)]);
      const result = await api.assessFollowup(options(mock.options));
      assert.equal(result.assessment.conclusion, conclusion, result.assessment.reason);
      assert.equal(mock.calls.length, 2, 'Conclusions require both fresh independent sessions');
      assert.notEqual(mock.calls[0].cwd, mock.calls[1].cwd);
      assert.equal(result.assessment.proofKind, 'review-only');
      assert.equal(result.assessment.review.verification, undefined, 'No synthetic verifier authority');
      assert.deepEqual(result.assessment.original, item.original);
      assert.deepEqual(result.assessment.provenance, item.provenance);
      assert.equal(await api.isFollowupAssessmentCurrent(options(mock.options), result.assessment), true);
      assert.deepEqual(await api.readFollowupAssessment(f.commonDir, result.reference), result.assessment);
      if (process.platform !== 'win32') assert.equal((await lstat(result.reference.path)).mode & 0o777, 0o600);
      const content = await readFile(result.reference.path, 'utf8');
      await writeFile(result.reference.path, `${content} `);
      await assert.rejects(api.readFollowupAssessment(f.commonDir, result.reference), {code: 'FOLLOWUP_ASSESSMENT_CHANGED'});
      await writeFile(result.reference.path, content);
      await rm(result.reference.path); await symlink(join(f.root, 'source.txt'), result.reference.path);
      await assert.rejects(api.readFollowupAssessment(f.commonDir, result.reference), {code: 'PRIVATE_STATE_PATH_INVALID'});
      await rm(result.reference.path);
    }
    assert.equal(await readFile(store.path, 'utf8'), before, 'Assessment never repairs, resolves or changes dispositions');
    const variants = [
      [report('UNKNOWN'), report('UNKNOWN')],
      [report(), report('ABSENT')],
      [report('NOT_A_CONCLUSION'), report()],
      [report('PRESENT', {extra: 'invalid field'}), report()],
      [report('ABSENT', {results: []}), report()],
      [report('ABSENT', {results: [{...report().results[0], evidence: ['npm test PASS']}]}), report('ABSENT')],
      [report('ABSENT', {results: [{...report().results[0], evidence: ['source.txt:1: invented contents']}]}), report('ABSENT')],
      [report('ABSENT', {results: [{...report().results[0], summary: 'Path changed'}]}), report('ABSENT')],
      ['{"structured_output":', report()],
      [report('PRESENT', {results: [{...report().results[0], status: 'FAIL'}]}), report()]
    ];
    for (const scripts of variants) {
      const mock = await reviewer(f, scripts);
      const result = await api.assessFollowup(options(mock.options));
      assert.equal(result.assessment.conclusion, 'UNKNOWN', JSON.stringify(scripts));
      assert.equal(await api.isFollowupAssessmentCurrent(options(mock.options), result.assessment), false);
    }
    const observation = items.find(item => item.kind === 'observation');
    const mock = await reviewer(f);
    await assert.rejects(api.assessFollowup({...options(mock.options), itemId: observation.id}), {code: 'FOLLOWUP_CLARIFICATION_REQUIRED'});
    assert.equal(mock.calls.length, 0);
    await modules.clarifyFollowup(store, observation.id, finding, 'Explicit concrete current-source claim.');
    const clarified = await api.assessFollowup({...options(mock.options), itemId: observation.id});
    assert.equal(clarified.assessment.conclusion, 'PRESENT');
    assert.equal(typeof clarified.assessment.original, 'string', 'Original residual text survives clarification');
    await modules.clarifyFollowup(store, observation.id, {...finding, details: 'A different concrete claim needs assessment.'}, 'Changed scope.');
    assert.equal(await api.isFollowupAssessmentCurrent({...options(mock.options), itemId: observation.id}, clarified.assessment), false);
  }),
  'followup-assessment-isolation-drift': () => withAssessment(async ({f, store, item, options, api}) => {
    let mock = await reviewer(f);
    const proof = await api.assessFollowup(options(mock.options));
    assert.equal(proof.assessment.conclusion, 'PRESENT');
    assert.equal(proof.assessment.binding.commit, await checkedGit(f.root, ['rev-parse', 'HEAD']));
    const changedConfig = {...options(mock.options), loadConfig: async () => ({...config, profiles: ['core']})};
    assert.equal(await api.isFollowupAssessmentCurrent(changedConfig, proof.assessment), false);
    assert.equal(await api.isFollowupAssessmentCurrent({...options(mock.options), targetBranch: 'different'}, proof.assessment), false);
    assert.equal(await api.isFollowupAssessmentCurrent(options(mock.options), {...proof.assessment, original: 'forged'}), false);
    assert.equal(await api.isFollowupAssessmentCurrent(options(mock.options), {...proof.assessment,
      review: {...proof.assessment.review, prompt: 'Assessment of a different finding'}}), false);
    for (const afterRound of [0, 1]) {
      const scripts = [report(), report()];
      scripts[afterRound] = {...report(), before: async () => writeFile(join(f.root, 'source.txt'), 'source drift\n')};
      // The callback is test transport behavior, not part of the JSON report.
      mock = await reviewer(f, scripts);
      const result = await api.assessFollowup(options(mock.options));
      assert.equal(result.assessment.conclusion, 'UNKNOWN');
      assert.equal(result.assessment.reason, 'FOLLOWUP_SOURCE_CHANGED');
      assert.equal(mock.calls.length, afterRound === 0 ? 1 : 2);
      await writeFile(join(f.root, 'source.txt'), 'candidate candidate\n');
    }
    mock = await reviewer(f, [{...report(), before: async () => {
      await store.mutate(items => {const index = items.findIndex(i => i.id === item.id);
        items[index] = {...items[index], original: {...item.original, details: 'Changed original claim.'}};});
    }}]);
    assert.equal((await api.assessFollowup(options(mock.options))).assessment.conclusion, 'UNKNOWN');
    await store.mutate(items => {items[items.findIndex(i => i.id === item.id)] = item;});
    for (const preflight of ['missing-executable', 'timeout', 'unauthenticated', 'capability-unavailable']) {
      mock = await reviewer(f, [], {preflightTarget: async () => preflight});
      const result = await api.assessFollowup(options(mock.options));
      assert.equal(result.assessment.conclusion, 'UNKNOWN');
      assert.equal(mock.calls.length, 0);
    }
    mock = await reviewer(f, [], {env: {CODEX_SANDBOX_NETWORK_DISABLED: '1'}});
    const denied = await api.assessFollowup(options(mock.options));
    assert.equal(denied.assessment.conclusion, 'UNKNOWN');
    assert.equal(denied.assessment.reason, 'host-required');
    assert.equal(mock.calls.length, 0);
    mock = await reviewer(f, [{hang: true}], {timeoutMs: 2000});
    const timeout = await api.assessFollowup(options(mock.options));
    assert.equal(timeout.assessment.conclusion, 'UNKNOWN');
    assert.equal(timeout.assessment.reason, 'timeout');
    assert.equal(mock.calls.length, 1, 'Timeout exercises the live reviewer after its real clone');
    await writeFile(join(f.root, 'source.txt'), 'dirty\n');
    mock = await reviewer(f);
    const dirty = await api.assessFollowup(options(mock.options));
    assert.equal(dirty.assessment.reason, 'FOLLOWUP_DIRTY_SOURCE');
    assert.equal(mock.calls.length, 0);
    await checkedGit(f.root, ['add', 'source.txt']); await checkedGit(f.root, ['commit', '-qm', 'changed source']);
    assert.equal(await api.isFollowupAssessmentCurrent(options(mock.options), proof.assessment), false);
  })
};
