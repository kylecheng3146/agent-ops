import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {load, withRepository, reviewedCandidate, checkedGit, config} from '../followup/fixture.mjs';
const surface = {included: [{id: 'source', path: 'source.txt', behavior: 'Source behavior'}]};
const advice = {summary: 'Bounded advice', recommendations: [], limitations: []};
const proposal = {strategies: [{id: 'source-boundary', paths: ['source.txt'], cue: 'Check reentry', check: 'Require a repeat delivery assertion'}], expectedImprovement: 'Catch omitted repeat behavior', failureCondition: 'Any regression'};
async function modules() {
  return {...await load('runtime/src/review/criteria.js'), ...await load('runtime/src/learning/intake.js'),
    ...await load('runtime/src/learning/history.js'), ...await load('runtime/src/learning/store.js'),
    ...await load('runtime/src/learning/setup.js'), ...await load('runtime/src/parallel/finish.js'),
    ...await load('runtime/src/learning/data.js')};
}
async function delivered(m, f, name = 'history') {
  const c = await reviewedCandidate(f, {name, modern: true, goal: 'Preserve traceable delivery behavior'});
  await m.finishWorktree(f.deps, {cwd: f.root, name: c.record.name, finalProof: c.finalProof});
  return c;
}
function modelSpy(reply) {
  const requests = [];
  async function* stream(v = '') {yield Buffer.from(v);}
  return {requests, runner: {start: request => {
    requests.push(request);
    return {pid: 123, stdout: stream(JSON.stringify(reply())), stderr: stream(),
      completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => {}};
  }}};
}
export const adviceChecks = {
  'learning-advisory-proposals': async () => {
    const m = await modules();
    await withRepository(async f => {
      const c = await delivered(m, f), task = {...c.records[0].task, id: 'task-new-advice', surface, goal: 'New task for source.txt'};
      const cases = await m.matchingCompletedCases(f.source, ['source.txt']), id = cases[0].id;
      const spy = modelSpy(() => ({...advice, historicalUses: [{caseId: id, use: 'Checked repeat criteria'}], candidates: [{sourceCaseIds: [id], proposal}]}));
      const result = await m.runCriteriaReview({root: f.root, commonDir: f.commonDir, learningSource: f.source, task, target: 'codex', runner: spy.runner});
      assert.equal(result.report.status, 'COMPLETED', JSON.stringify(result));
      assert.equal(spy.requests.length, 1, 'Proposal authoring reuses exactly the ordinary advisory call');
      assert.notEqual(spy.requests[0].cwd, f.root);
      const prompt = spy.requests[0].stdin;
      assert.match(prompt, /transfer is unvalidated/);
      assert.ok(prompt.includes(id));
      assert.ok(!prompt.includes('Revalidate the branch'), 'Raw unadopted review recommendations are absent');
      assert.ok(!prompt.includes('holdout-retry') && !prompt.includes('expected":"redo'), 'Suite answers never loaded');
      assert.equal(result.report.snapshot.history.length, 1);
      const store = new m.CandidateStore(f.commonDir), ids = await store.ids(), record = await store.read(ids[0]);
      assert.equal(ids.length, 1); assert.deepEqual(record.proposal, proposal);
      assert.equal(record.history[0].provenance.receiptDigest, cases[0].provenance.receiptDigest);
      assert.equal(record.author.attemptId, result.report.attemptId);
      const usePath = join(f.commonDir, 'agent-ops/learning/uses');
      const {readdir} = await import('node:fs/promises');
      const uses = JSON.parse(await readFile(join(usePath, (await readdir(usePath))[0]), 'utf8'));
      assert.deepEqual(uses.modelReportedUses, [{caseId: id, use: 'Checked repeat criteria'}]);
      assert.equal(uses.loadedHistory[0].id, id);
      assert.equal((await new m.FileLearningStore(f.commonDir).read()).active, null);
      const base = {candidates: [{sourceCaseIds: [id], proposal}]};
      assert.equal(m.validateHistoricalAdvice(base, cases, ['source.txt']), true);
      for (const bad of [
        {candidates: [{sourceCaseIds: ['0'.repeat(64)], proposal}]},
        {candidates: [{sourceCaseIds: [id], proposal: {...proposal, strategies: [{...proposal.strategies[0], paths: ['elsewhere/**']}]}}]},
        {historicalUses: [{caseId: '0'.repeat(64), use: 'Invented use'}]},
        {candidates: [...base.candidates, ...base.candidates]},
        {candidates: [{sourceCaseIds: [id], proposal: {...proposal, command: 'unsafe'}}]}
      ]) assert.equal(m.validateHistoricalAdvice(bad, cases, ['source.txt']), false);
      const empty = modelSpy(() => ({...advice, candidates: []}));
      const declined = await m.runCriteriaReview({root: f.root, commonDir: f.commonDir, learningSource: f.source,
        task: {...task, id: 'task-empty-proposal'}, target: 'codex', runner: empty.runner});
      assert.equal(declined.report.status, 'COMPLETED'); assert.equal(empty.requests.length, 1);
      assert.deepEqual(await store.ids(), ids);
      assert.equal(m.candidateKey(proposal), m.candidateKey({...proposal, strategies: [{...proposal.strategies[0], id: 'renamed'}]}));
    });
  },
  'learning-history-snapshots': async () => {
    const m = await modules();
    await withRepository(async f => {
      const c = await delivered(m, f), task = {...c.records[0].task, id: 'task-old-snapshot', surface};
      const spy = modelSpy(() => advice);
      const first = await m.runCriteriaReview({root: f.root, task, commonDir: f.commonDir, target: 'codex', runner: spy.runner});
      const bytes = await readFile(first.reportPath, 'utf8');
      assert.equal(first.report.snapshot.history, undefined);
      const cached = await m.runCriteriaReview({root: f.root, task, commonDir: f.commonDir, learningSource: f.source, target: 'codex', runner: spy.runner});
      assert.equal(cached.stale, false); assert.equal(spy.requests.length, 1);
      assert.equal(await readFile(first.reportPath, 'utf8'), bytes);
      assert.equal(m.revisionReviewDue(await m.readCriteriaReview(f.root, task)), false);
      const unrelated = {...task, id: 'task-unrelated', surface: {...task.surface, included: [{id: 'unrelated', path: 'unrelated.txt', behavior: 'Unrelated change'}]}};
      const next = await m.runCriteriaReview({root: f.root, task: unrelated, commonDir: f.commonDir, learningSource: f.source, target: 'codex', runner: spy.runner});
      assert.equal(next.report.status, 'COMPLETED'); assert.equal(next.report.snapshot.history, undefined);
      assert.ok(!spy.requests[1].stdin.includes('DATA history contains'));
      assert.equal(m.validateCriteriaAdvice(advice), true);
      assert.equal(m.validateCriteriaAdvice({...advice, candidates: []}), true);
      assert.equal((await new m.FileLearningStore(f.commonDir).read()).generation, 0);
      assert.deepEqual(await new m.CandidateStore(f.commonDir).ids(), []);
      const prior = {...next.report.snapshot, history: [{id: 'historical-context-changed'}]};
      await writeFile(next.reportPath, JSON.stringify({...next.report, snapshot: prior}));
      assert.equal((await m.readCriteriaReview(f.root, unrelated)).stale, false, 'History changes alone never make a revise due');
    });
  },
  'learning-suite-eligibility': async () => {
    const m = await modules();
    await withRepository(async f => {
      const c = await delivered(m, f), history = await m.matchingCompletedCases(f.source, ['source.txt']);
      const candidate = {schemaVersion: 1, proposal, history, author: {taskId: c.records[0].task.id, attemptId: 'author', snapshotHash: 'a'.repeat(64)}};
      const suite = {schemaVersion: 1, cases: Array.from({length: 4}, (_, i) => ({id: `independent-${i}`, split: i < 2 ? 'probe' : 'holdout',
        snapshot: {originalGoal: `Independent labelled behavior ${i}`, criteria: [{id: 'behavior', description: `Required behavior ${i}`}, {id: 'regression', description: 'Boundaries'}], surface: {included: [{path: 'source.txt'}]}}, expected: i % 2 ? [] : ['redo']}))};
      const registration = {suitePath: 'evaluation.json', suiteDigest: m.digest(suite), humanConfirmed: true, independentlyLabelled: true, settings: {target: 'codex', model: 'model-2026-01', effort: 'high'}};
      const configured = {...config, reviewRoles: [{role: 'independent-review', targets: ['codex']}], learning: registration};
      const resolve = (conf = configured, cand = candidate) => m.resolveLearningSetup({...f.source, config: conf, candidate: cand});
      assert.equal((await resolve({...config})).reason, 'SETUP_MISSING');
      assert.equal((await resolve()).reason, 'SUITE_NOT_COMMITTED');
      const commitSuite = async value => {await writeFile(join(f.root, 'evaluation.json'), JSON.stringify(value)); await checkedGit(f.root, ['add', 'evaluation.json']); await checkedGit(f.root, ['commit', '-qm', 'Register fixture evaluation']);};
      await commitSuite(suite);
      const eligible = await resolve();
      assert.equal(eligible.status, 'eligible'); assert.deepEqual(eligible.suite, suite);
      assert.equal(eligible.suiteCommit, await checkedGit(f.root, ['rev-parse', 'HEAD']));
      assert.equal((await resolve({...configured, learning: {...registration, humanConfirmed: false}})).reason, 'SUITE_UNCONFIRMED');
      assert.equal((await resolve({...configured, learning: {...registration, independentlyLabelled: false}})).reason, 'SUITE_UNCONFIRMED');
      for (const model of ['latest', 'default', 'model-1-latest', 'opus', 'gpt-4o', 'gpt-5.4']) assert.equal((await resolve({...configured, learning: {...registration, settings: {...registration.settings, model}}})).reason, 'MODEL_NOT_FIXED');
      assert.equal((await resolve({...configured, learning: {...registration, suiteDigest: '0'.repeat(64)}})).reason, 'SUITE_DIGEST_CHANGED');
      assert.equal((await resolve({...configured, learning: {...registration, suitePath: 'tests/learning/scenarios.json'}})).reason, 'SYNTHETIC_SUITE');
      assert.equal((await resolve({...configured, reviewRoles: []})).reason, 'TARGET_UNCONFIGURED');
      assert.equal((await resolve(configured, {...candidate, proposal: {...proposal, strategies: [{...proposal.strategies[0], paths: ['other.txt']}]}})).reason, 'CANDIDATE_SOURCE_INVALID');
      assert.equal((await resolve(configured, {...candidate, history: [{...history[0], tasks: [{...history[0].tasks[0], goal: 'Tampered historical goal'}]}]})).reason, 'CANDIDATE_SOURCE_CHANGED');
      assert.equal((await resolve(configured, {...candidate, proposal: {...proposal, expectedImprovement: 'independent-2'}})).reason, 'HOLDOUT_LEAKAGE');
      assert.equal((await resolve(configured, {...candidate, history: [{...history[0], tasks: [{...history[0].tasks[0], goal: suite.cases[2].snapshot.originalGoal}]}]})).reason, 'SOURCE_CASE_LEAKAGE');
      await writeFile(join(f.root, 'evaluation.json'), '{}');
      assert.equal((await resolve()).reason, 'SUITE_DIRTY');
      await checkedGit(f.root, ['checkout', '--', 'evaluation.json']);
      const inapplicable = structuredClone(suite);
      for (const c of inapplicable.cases) c.snapshot.surface.included[0].path = 'unrelated.txt';
      await commitSuite(inapplicable);
      assert.equal((await resolve({...configured, learning: {...registration, suiteDigest: m.digest(inapplicable)}})).reason, 'SUITE_INAPPLICABLE');
      const leaked = structuredClone(suite); leaked.cases[2].snapshot.expected = ['redo'];
      await commitSuite(leaked);
      assert.equal((await resolve({...configured, learning: {...registration, suiteDigest: m.digest(leaked)}})).reason, 'SUITE_CONTEXT_LEAKAGE');
      const metadataDuplicate = structuredClone(suite);
      metadataDuplicate.cases[2].snapshot = {...metadataDuplicate.cases[0].snapshot, taskId: 'different-metadata-only'};
      await commitSuite(metadataDuplicate);
      assert.equal((await resolve({...configured, learning: {...registration, suiteDigest: m.digest(metadataDuplicate)}})).reason, 'SUITE_DUPLICATE_TASKS');
      const duplicate = structuredClone(suite); duplicate.cases[2].snapshot = duplicate.cases[0].snapshot;
      await commitSuite(duplicate);
      assert.equal((await resolve({...configured, learning: {...registration, suiteDigest: m.digest(duplicate)}})).status, 'waiting');
      const {validateConfig} = await load('runtime/src/schema/validate.js');
      const {mergeConfigLayers} = await load('runtime/src/config/merge.js');
      const {explainConfig} = await load('runtime/src/config/explain.js');
      assert.equal(validateConfig(config).ok, true); assert.equal(validateConfig(configured).ok, true);
      for (const patch of [{suitePath: '../bad'}, {suiteDigest: 'bad'}, {settings: {...registration.settings, target: 'unknown'}}, {unknown: true}])
        assert.equal(validateConfig({...configured, learning: {...registration, ...patch}}).ok, false);
      const merged = mergeConfigLayers([{source: 'default', sourcePath: 'default', config}, {source: 'project', sourcePath: '.agent-ops/config.json', config: configured}]);
      assert.deepEqual(merged.config.learning, registration); assert.equal(explainConfig(merged).learning.source, 'project');
      assert.deepEqual(merged.config.verification, config.verification, 'Verifier authority preserved');
      assert.equal(mergeConfigLayers([{source: 'user', sourcePath: 'user', config: configured}]).config.learning, undefined, 'User defaults cannot enable repository experiments');
      // Any accidental production model call during setup is a test failure: setup receives no call implementation.
    });
  }
};
