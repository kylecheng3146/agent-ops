import assert from 'node:assert/strict';
import {execFile as execute} from 'node:child_process';
import {chmod, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {withRepository, reviewedCandidate, rewriteReceipt, sealNativeCandidate, load, moduleUrl, checkedGit, config} from '../followup/fixture.mjs';
const execFile = promisify(execute);
async function modules() {
  try {return {...await load('runtime/src/learning/intake.js'), ...await load('runtime/src/learning/store.js'),
    ...await load('runtime/src/parallel/finish.js')};}
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') assert.fail('The completed-delivery learning intake must exist');
    throw error;
  }
}
const finish = (m, f, c) => m.finishWorktree(f.deps, {cwd: f.root, name: c.record.name, finalProof: c.finalProof});
const candidate = (f, options = {}) => reviewedCandidate(f, {modern: true, goal: 'Deliver traceable ordinary or repaired work', ...options});

const surface = {included: [{id: 'source', path: 'source.txt', behavior: 'Source behavior'}]};
const advice = {summary: 'Bounded advice', recommendations: [], limitations: []};
const proposal = {strategies: [{id: 'source-boundary', paths: ['source.txt'], cue: 'Check reentry', check: 'Require a repeat delivery assertion'}], expectedImprovement: 'Catch omitted repeat behavior', failureCondition: 'Any regression'};
async function adviceModules() {
  try {return {...await load('runtime/src/review/criteria.js'), ...await load('runtime/src/learning/intake.js'),
    ...await load('runtime/src/learning/history.js'), ...await load('runtime/src/learning/store.js'),
    ...await load('runtime/src/learning/setup.js'), ...await load('runtime/src/parallel/finish.js'),
    ...await load('runtime/src/learning/data.js')};}
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND' && ['history', 'setup'].some(name =>
      error.url === moduleUrl(`runtime/src/learning/${name}.js`)))
      assert.fail('Historical candidate authoring and evaluation setup must exist');
    throw error;
  }
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
    const m = await adviceModules();
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
    const m = await adviceModules();
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
    const m = await adviceModules();
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

export const pipelineChecks = {
  ...adviceChecks,
  'learning-delivery-history': async () => {
    const m = await modules();
    for (const tree of [false, true]) await withRepository(async f => {
      const c = await candidate(f, {tree});
      const preliminary = await c.prepare();
      assert.equal((await m.collectLearningReceipt({...f.source, path: preliminary.path})).added, 0);
      const result = await finish(m, f, c);
      assert.equal(result.learning.added, 1);
      assert.deepEqual(result.warnings, []);
      const store = new m.FileLearningStore(f.commonDir), ids = await store.caseIds();
      assert.equal(ids.length, 1);
      const value = await m.readCompletedCase(f.source, ids[0]);
      assert.equal(value.tasks.length, tree ? 2 : 1);
      assert.equal(value.reviews.length, 1, 'Shared tree reports are retained once by reference');
      assert.equal(value.tasks[0].goal, c.records[0].task.goal);
      assert.deepEqual(value.tasks[0].criteria, c.records[0].task.criteria.map(({id, description}) => ({id, description})));
      assert.equal(value.provenance.candidateHead, result.mergedHead);
      assert.equal(value.provenance.sourceFingerprint, c.fingerprint);
      assert.equal(value.provenance.receiptPath, result.receipt);
      assert.deepEqual(value.paths, ['source.txt']);
      assert.ok(value.tasks.every(t => t.verification.some(v => v.status === 'PASS')));
      assert.ok(!JSON.stringify(value).includes('Revalidate the branch'), 'Unadopted recommendations stay out of cases');
      assert.deepEqual(await m.matchingCompletedCases(f.source, ['unrelated/file.ts']), []);
      const contexts = await m.matchingCompletedCases(f.source, ['source.txt']);
      assert.equal(contexts.length, 1);
      assert.match(contexts[0].referenceOnly, /unvalidated/);
      assert.equal(contexts[0].id, ids[0]);
      assert.equal((await store.read()).generation, 0, 'History does not adopt experience');
      const original = await readFile(result.receipt, 'utf8');
      for (const mutate of [
        r => {r.tasks[0].status = 'active';},
        r => {r.tasks[0].task.goal = 'Rewritten objective';},
        r => {r.tasks[0].evidence = {};},
        r => {r.reviews[r.tasks[0].task.id].report.digest = '0'.repeat(64);},
        r => {r.sourceFingerprint = '0'.repeat(64);}
      ]) {
        await writeFile(result.receipt, original);
        await rewriteReceipt(result.receipt, f, mutate);
        assert.equal((await m.collectLearningReceipt({...f.source, path: result.receipt})).added, 0);
        await assert.rejects(m.readCompletedCase(f.source, ids[0]));
        assert.deepEqual(await m.matchingCompletedCases(f.source, ['source.txt']), []);
      }
      await rm(result.receipt);
      assert.equal((await m.collectLearningReceipt({...f.source, path: result.receipt})).added, 0);
    });
    await withRepository(async f => {
      for (let i = 0; i < 4; i++) {
        const c = await candidate(f, {name: `bounded-${i}`});
        await finish(m, f, c);
      }
      const huge = await candidate(f, {name: 'oversized-context', goal: 'Long original goal '.repeat(1200)});
      await finish(m, f, huge);
      const contexts = await m.matchingCompletedCases(f.source, ['source.txt']);
      assert.equal(contexts.length, 3, 'At most three matching cases are loaded');
      assert.ok(Buffer.byteLength(JSON.stringify(contexts)) <= 12002);
      assert.ok(contexts.every(c => c.tasks.every(t => t.goal.length < 12000)), 'Oversized cases remain stored, but never overflow the prompt');
      assert.equal((await new m.FileLearningStore(f.commonDir).caseIds()).length, 5);
    });
    await withRepository(async f => {
      const c = await reviewedCandidate(f);
      const result = await m.finishWorktree(f.deps, {cwd: f.root, name: c.record.name});
      assert.deepEqual(result.learning, {added: 0, warnings: []}, 'Legacy receipts never qualify merely because finish succeeds');
      assert.deepEqual(await new m.FileLearningStore(f.commonDir).caseIds(), []);
    });
  },
  'learning-intake-reconciliation': async () => {
    const m = await modules();
    for (const native of [false, true]) await withRepository(async f => {
      const c = await candidate(f);
      const store = new m.FileLearningStore(f.commonDir);
      await mkdir(join(store.directory, 'cases.json'), {recursive: true});
      let result;
      if (native) {
        const run = await sealNativeCandidate(f, c);
        const blocked = {...f.deps, git: async (cwd, args) => args[0] === 'worktree' && args[1] === 'remove'
          ? {exitCode: 1, stdout: '', stderr: 'interrupted cleanup'} : f.git(cwd, args)};
        await assert.rejects(m.finishWorktree(blocked, {cwd: f.root, name: run.record.name, finalProof: c.finalProof}), {code: 'WORKTREE_FINISH_PARTIAL'});
        await rm(join(store.directory, 'cases.json'), {recursive: true});
        result = await m.finishWorktree(f.deps, {cwd: f.root, name: run.record.name, finalProof: {...c.finalProof, recovery: true}});
        assert.equal(result.learning.added, 1, 'Recovery collects exact sealed delivery');
      } else {
        result = await finish(m, f, c);
        assert.equal(result.mergedHead, c.head);
        assert.ok(result.warnings.some(w => w.startsWith('learning:')));
        assert.equal(result.followup.added, 3, 'Learning failure preserves followup behavior');
        const bytes = await readFile(result.receipt, 'utf8');
        await rm(join(store.directory, 'cases.json'), {recursive: true});
        assert.equal((await m.reconcileLearning(f.source)).added, 1);
        assert.equal(await readFile(result.receipt, 'utf8'), bytes);
      }
      assert.equal((await m.reconcileLearning(f.source)).added, 0);
      assert.equal((await store.caseIds()).length, 1);
      // Corruption is fail-open and preserved, never reset to an empty store.
      await writeFile(join(store.directory, 'cases.json'), '{interrupted');
      assert.ok((await m.reconcileLearning(f.source)).warnings.length);
      assert.equal(await readFile(join(store.directory, 'cases.json'), 'utf8'), '{interrupted');
      assert.ok((await readFile(result.receipt, 'utf8')).includes(c.head));
    });
  },
  'learning-source-immutability': async () => {
    const m = await modules();
    await withRepository(async f => {
      const secret = 'sk-' + 'A'.repeat(48);
      const c = await candidate(f, {tree: true, goal: `Repair delivery with credential ${secret}`});
      const result = await finish(m, f, c), store = new m.FileLearningStore(f.commonDir);
      const before = await readFile(result.receipt, 'utf8');
      const id = (await store.caseIds())[0], artifact = await readFile(join(store.directory, 'cases', id + '.json'), 'utf8');
      assert.ok(!artifact.includes(secret));
      assert.ok(before.includes(secret), 'Original source remains exact; only history is redacted');
      const original = await m.readCompletedCase(f.source, id);
      const concurrent = await Promise.all(Array.from({length: 4}, () => m.reconcileLearning(f.source)));
      assert.equal(concurrent.reduce((n, v) => n + v.added, 0), 0);
      // Delete only the derived index; cross-process imports must reserve one shared entry.
      await rm(join(store.directory, 'cases.json'));
      const bin = join(f.root, 'model-spies'), marker = join(f.root, 'unexpected-model-call');
      await mkdir(bin);
      for (const name of ['codex', 'claude', 'agy', 'agent-ops']) {
        const path = join(bin, name);
        await writeFile(path, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.LEARNING_MODEL_SPY, 'called'); process.exit(99);\n`);
        await chmod(path, 0o700);
      }
      const script = 'const {reconcileLearning}=await import(process.argv[1]); const {git}=await import(process.argv[2]); console.log(JSON.stringify(await reconcileLearning({git,mainRoot:process.argv[3],commonDir:process.argv[4]})));';
      const runs = await Promise.all([1,2].map(() => execFile(process.execPath, ['--input-type=module', '-e', script,
        moduleUrl('runtime/src/learning/intake.js'), new URL('../followup/fixture.mjs', import.meta.url).href, f.root, f.commonDir], {env: {...process.env, PATH: bin + ':' + process.env.PATH, LEARNING_MODEL_SPY: marker}})));
      await assert.rejects(readFile(marker), {code: 'ENOENT'}, 'Real CLI/model spies must not run during import');
      assert.equal(runs.map(r => JSON.parse(r.stdout).added).reduce((a,b) => a+b), 1);
      assert.deepEqual(await store.caseIds(), [id]);
      assert.equal(await readFile(result.receipt, 'utf8'), before, 'Tasks, seals, reviews and fingerprints stay byte-identical');
      assert.equal(await readFile(join(store.directory, 'cases', id + '.json'), 'utf8'), artifact);
      assert.deepEqual(await m.readCompletedCase(f.source, id), original);
      const contexts = await m.matchingCompletedCases(f.source, ['source.txt']);
      assert.ok(Buffer.byteLength(JSON.stringify(contexts)) <= 12002);
      assert.ok(contexts.length <= 3);
    });
  }
};
