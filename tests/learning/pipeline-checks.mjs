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


async function automationModules() {
  return {...await adviceModules(), ...await load('runtime/src/learning/automation.js'), ...await load('runtime/src/learning/experiment.js')};
}
async function automationFixture(check) {
  const m = await automationModules();
  await withRepository(async f => {
    const c = await delivered(m, f), history = await m.matchingCompletedCases(f.source, ['source.txt']);
    const candidates = new m.CandidateStore(f.commonDir);
    const enqueue = async (p = proposal, author = 'author') => (await candidates.enqueue({taskId: c.records[0].task.id, attemptId: author,
      snapshotHash: 'a'.repeat(64), history, candidates: [{sourceCaseIds: [history[0].id], proposal: p}]}))[0];
    const id = await enqueue();
    const suite = {schemaVersion: 1, cases: Array.from({length: 4}, (_, i) => ({id: `independent-${i}`, split: i < 2 ? 'probe' : 'holdout',
      snapshot: {originalGoal: `Independent ${i % 2 ? 'formatted display' : 'repeat delivery'} ${i}`,
        criteria: [{id: 'behavior', description: 'Required behavior'}, {id: 'regression', description: 'Boundaries'}],
        surface: {included: [{path: 'source.txt'}]}}, expected: i % 2 ? [] : ['redo']}))};
    await writeFile(join(f.root, 'evaluation.json'), JSON.stringify(suite));
    await checkedGit(f.root, ['add', 'evaluation.json']); await checkedGit(f.root, ['commit', '-qm', 'Register independent fixture suite']);
    const settings = {target: 'codex', model: 'model-2026-01', effort: 'high'};
    let configured = {...config, reviewRoles: [{role: 'independent-review', targets: ['codex']}],
      learning: {suitePath: 'evaluation.json', suiteDigest: m.digest(suite), humanConfirmed: true, independentlyLabelled: true, settings}};
    let now = new Date('2026-11-09T23:59:59Z'), allowed = true, authority = 'authority-a', live = true;
    let owner = {pid: process.pid, identity: 'fixture', group: false};
    const launches = [], prompts = [];
    const controller = new m.LearningAutomation({...f.source, loadConfig: async () => configured,
      authority: async () => ({allowed, fingerprint: authority, reason: 'NATIVE_DENIED'}),
      owner: async () => owner, alive: async () => live, now: () => now, launch: async job => {launches.push(job);}});
    const input = prompt => JSON.parse(prompt.slice(prompt.lastIndexOf('BEGIN UNTRUSTED DATA\n') + 21, prompt.lastIndexOf('\nEND UNTRUSTED DATA')));
    const call = (options = {}) => async (prompt, schema) => {
      prompts.push(prompt);
      if (options.hook) await options.hook(prompt);
      const data = input(prompt);
      assert.ok(!prompt.startsWith('Propose'), 'Supplied candidates never regenerate proposals');
      let value;
      if (prompt.startsWith('Compose')) {
        assert.ok(!prompt.includes('independent-2') && !prompt.includes('independent-3'));
        assert.ok(!prompt.includes(suite.cases[2].snapshot.originalGoal));
        value = options.composition ?? proposal;
      } else {
        value = {results: data.cases.map(c => {
          const detects = (options.perfect || (!options.noGain && c.snapshot.experiences.length > 0)) && c.snapshot.originalGoal.includes('repeat');
          return {caseId: c.caseId, advice: {...advice, recommendations: detects ? [{criterionId: 'behavior', issue: 'Repeat can duplicate delivery',
            recommendation: 'Specify repeat safety', reason: 'Repeated calls are possible'}] : []},
            omissions: detects ? [{dimension: 'redo', recommendationIndex: 0}] : []};
        })};
      }
      return {value, durationMs: 1, conditions: m.digest(m.learningConditions(settings, schema)), ...(options.fail ? {failure: 'TARGET_FAILED'} : {})};
    };
    const run = async (job, fn = call()) => {await controller.bind(job.id, job.token, owner); await controller.execute(job.id, job.token, fn); return (await controller.read()).jobs.find(j => j.id === job.id);};
    await check({m, f, controller, id, suite, settings, history, enqueue, launches, prompts, call, run,
      setDay: value => {now = new Date(value);}, setAllowed: value => {allowed = value;}, setAuthority: value => {authority = value;},
      setConfig: fn => {configured = fn(configured);}, setLive: value => {live = value;}, setOwner: value => {owner = value;}});
  });
}
export const automationChecks = {
  'learning-evaluation-adoption': async () => {
    await automationFixture(async x => {
      const before = await readFile(x.history[0].provenance.receiptPath, 'utf8');
      const job = await x.controller.reconcile(), result = await x.run(job);
      assert.equal(result.status, 'adopted', result.reason); assert.equal(result.invocations, 7);
      assert.equal(x.prompts.length, 7); assert.equal(x.prompts.filter(p => p.startsWith('Compose')).length, 1);
      const trial = await x.controller.store.artifact('trials', result.trial);
      assert.equal(x.m.replayLearningTrial(trial).status, 'PASS');
      assert.equal(await readFile(x.history[0].provenance.receiptPath, 'utf8'), before);
      await x.controller.store.recover('retire', 'Fixture retirement');
      await x.controller.store.recover('rollback', 'Fixture rollback', result.adopted);
      assert.equal((await x.controller.store.read()).active, result.adopted);
    });
    await automationFixture(async x => {
      const job = await x.controller.reconcile(), result = await x.run(job, x.call({perfect: true}));
      assert.equal(result.status, 'retained'); assert.equal(result.reason, 'NO_HOLDOUT_HEADROOM');
      assert.equal(result.invocations, 2); assert.ok(x.prompts.every(p => p.startsWith('Evaluate')));
      assert.equal(x.m.replayLearningTrial(await x.controller.store.artifact('trials', result.trial)).reason, 'NO_HOLDOUT_HEADROOM');
    });
    for (const mode of ['noGain', 'unchanged', 'regression', 'uncertain']) await automationFixture(async x => {
      let n = 0;
      const ordinary = x.call({noGain: mode === 'noGain', ...(mode === 'unchanged' ? {composition: {...proposal, strategies: []}} : {})});
      const model = async (prompt, schema) => {
        const reply = await ordinary(prompt, schema);
        if (!prompt.startsWith('Evaluate')) return reply;
        n++;
        if (mode === 'regression' && n > 2) {
          const row = reply.value.results[1];
          row.advice.recommendations.push({criterionId: 'behavior', issue: 'Invented omission', recommendation: 'Add unnecessary behavior', reason: 'Fake false positive'});
        }
        if (mode === 'uncertain' && n === 2) {
          const perfect = await x.call({perfect: true})(prompt, schema); return perfect;
        }
        return reply;
      };
      const result = await x.run(await x.controller.reconcile(), model);
      assert.notEqual(result.status, 'adopted', mode); assert.equal((await x.controller.store.read()).active, null);
    });
  },
  'learning-automation-accounting': async () => {
    await automationFixture(async x => {
      const concurrent = await Promise.all(Array.from({length: 5}, () => x.controller.reconcile()));
      assert.equal(concurrent.filter(Boolean).length, 1); assert.equal(x.launches.length, 1);
      const first = concurrent.find(Boolean);
      const failed = await x.run(first, x.call({fail: true}));
      assert.equal(failed.status, 'failed'); assert.equal(failed.invocations, 1);
      await x.controller.retry(first.id);
      const second = await x.controller.reconcile(); await x.run(second, x.call({noGain: true}));
      assert.equal((await x.controller.status()).quota.attempts, 2);
      await x.controller.retry(second.id);
      assert.equal(await x.controller.reconcile(), null);
      assert.equal((await x.controller.status()).waiting[x.id], 'DAILY_QUOTA');
      x.setDay('2026-11-10T00:00:00Z');
      const third = await x.controller.reconcile(); assert.ok(third, 'Explicit retry survives until the next UTC quota day');
      assert.equal((await x.controller.status()).quota.attempts, 1);
      await x.run(third, x.call({fail: true}));
      assert.equal((await x.controller.read()).jobs.length, 3);
    });
    await automationFixture(async x => {
      const marker = join(x.f.root, 'launches.log');
      const configured = {...config, reviewRoles: [{role: 'independent-review', targets: ['codex']}], learning: {
        suitePath: 'evaluation.json', suiteDigest: x.m.digest(x.suite), humanConfirmed: true, independentlyLabelled: true, settings: x.settings}};
      const script = `const {LearningAutomation}=await import(process.argv[1]);
        const {git}=await import(process.argv[2]); const {appendFile}=await import('node:fs/promises');
        const [mainRoot, commonDir, marker, configJson, pid]=process.argv.slice(3);
        const controller=new LearningAutomation({mainRoot,commonDir,git,loadConfig:async()=>JSON.parse(configJson),
          authority:async()=>({allowed:true,fingerprint:'authority-a',reason:'READY'}),
          owner:async()=>({pid:Number(pid),identity:'fixture',group:false}), alive:async()=>true,
          now:()=>new Date('2026-11-09T23:59:59Z'), launch:async job=>{await appendFile(marker,job.id+'\\n');}});
        console.log(JSON.stringify(await controller.reconcile()));`;
      const runs = await Promise.all([1, 2, 3].map(() => execFile(process.execPath, ['--input-type=module', '-e', script,
        moduleUrl('runtime/src/learning/automation.js'), new URL('../followup/fixture.mjs', import.meta.url).href,
        x.f.root, x.f.commonDir, marker, JSON.stringify(configured), String(process.pid)])));
      const reserved = runs.map(r => JSON.parse(r.stdout)).filter(Boolean);
      assert.equal(reserved.length, 1, 'Real independent processes atomically reserve one job');
      assert.equal((await readFile(marker, 'utf8')).trim().split('\n').length, 1);
      const result = await x.run(reserved[0]);
      assert.equal(result.status, 'adopted', result.reason); assert.equal(x.prompts.length, 7);
      assert.equal((await x.controller.status()).quota.attempts, 1);
    });
    await automationFixture(async x => {
      const job = await x.controller.reconcile(); await x.controller.bind(job.id, job.token, {pid: process.pid, identity: 'fixture', group: false});
      await x.controller.change(async state => {state.jobs[0].invocations = 12;});
      await x.controller.execute(job.id, job.token, x.call());
      assert.equal(x.prompts.length, 0, 'Durable reservation prevents a thirteenth invocation');
      assert.equal((await x.controller.read()).jobs[0].invocations, 12);
    });
  },
  'learning-automation-recovery': async () => {
    await automationFixture(async x => {
      const first = await x.controller.reconcile(); await x.run(first, x.call({fail: true}));
      x.setDay('2026-11-10T00:00:00Z');
      assert.equal(await x.controller.reconcile(), null, 'Failure never retries on a new day');
      await x.enqueue({...proposal, strategies: [{...proposal.strategies[0], id: 'renamed'}]}, 'another-author');
      assert.equal(await x.controller.reconcile(), null, 'Canonical content ignores advisory author and strategy IDs');
      x.setAuthority('authority-b');
      assert.ok(await x.controller.reconcile(), 'Meaningful immutable conditions change permits a new attempt');
      x.setLive(false);
      assert.equal(await x.controller.reconcile(), null, 'Dead owner becomes terminal without automatic retry');
      assert.equal((await x.controller.read()).jobs.at(-1).reason, 'OWNER_EXITED_NO_RETRY');
    });
    await automationFixture(async x => {
      x.controller.options.launch = async () => {throw new Error('Launch refused');};
      const job = await x.controller.reconcile();
      assert.equal((await x.controller.read()).jobs[0].reason, 'LAUNCH_FAILED_NO_RETRY');
      assert.equal((await x.controller.status()).quota.attempts, 1);
      assert.equal(await x.controller.reconcile(), null); assert.equal(x.prompts.length, 0);
      await x.controller.retry(job.id); assert.ok(await x.controller.reconcile());
    });
    await automationFixture(async x => {
      await rm(join(x.controller.candidates.directory, 'index.json'));
      assert.equal(await x.controller.reconcile(), null); assert.equal(x.launches.length, 0);
      assert.equal((await x.controller.status()).quota.attempts, 0, 'Passive history import has no experiment spending');
    });
  },
  'learning-automation-authority': async () => {
    for (const drift of ['denial', 'policy', 'suite', 'model', 'library', 'source']) await automationFixture(async x => {
      const job = await x.controller.reconcile();
      const mutate = async () => {
        if (drift === 'denial') x.setAllowed(false);
        if (drift === 'policy') x.setAuthority('changed-policy');
        if (drift === 'model') x.setConfig(c => ({...c, learning: {...c.learning, settings: {...c.learning.settings, model: 'model-2027-01'}}}));
        if (drift === 'suite') await writeFile(join(x.f.root, 'evaluation.json'), '{}');
        if (drift === 'library') await x.controller.store.recover('retire', 'Concurrent library change');
        if (drift === 'source') await rm(x.history[0].provenance.receiptPath);
      };
      let changed = false;
      const model = x.call({hook: async () => {if (!changed) {changed = true; await mutate();}}});
      const result = await x.run(job, model);
      assert.equal(result.status, 'failed', drift); assert.equal(x.prompts.length, 1, 'Drift stops further spending');
      assert.equal((await x.controller.store.read()).active, null);
    });
    if (process.platform !== 'win32') await automationFixture(async x => {
      const bin = join(x.f.root, 'fake-models'), calls = join(x.f.root, 'model-calls.jsonl');
      await mkdir(bin);
      const executable = join(bin, 'codex');
      await writeFile(executable, `#!${process.execPath}
const fs=require('node:fs'); let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),prompt})+'\\n');
const data=JSON.parse(prompt.slice(prompt.lastIndexOf('BEGIN UNTRUSTED DATA\\n')+21,prompt.lastIndexOf('\\nEND UNTRUSTED DATA')));
const value=prompt.startsWith('Compose')?${JSON.stringify(proposal)}:{results:data.cases.map(c=>{
const detects=c.snapshot.experiences.length>0&&c.snapshot.originalGoal.includes('repeat');
return {caseId:c.caseId,advice:{summary:'Fixture',recommendations:detects?[{criterionId:'behavior',issue:'Repeated delivery',recommendation:'Specify repeat safety',reason:'Retry is possible'}]:[],limitations:[]},omissions:detects?[{dimension:'redo',recommendationIndex:0}]:[]};})};
process.stdout.write(JSON.stringify(value));});
`);
      await chmod(executable, 0o700);
      const configured = {...config, reviewRoles: [{role: 'independent-review', targets: ['codex']}], learning: {
        suitePath: 'evaluation.json', suiteDigest: x.m.digest(x.suite), humanConfirmed: true, independentlyLabelled: true, settings: x.settings}};
      await writeFile(join(x.f.root, '.agent-ops/config.json'), JSON.stringify(configured));
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^AGENT_OPS_(?:RUN|WORKER|SESSION|AGENT)_/u.test(key) && key !== 'CODEX_THREAD_ID'));
      Object.assign(env, {AGENT_OPS_HOME: join(x.f.root, 'test-home'), PATH: bin + ':' + process.env.PATH});
      const script = `const {productionLearningAutomation}=await import(process.argv[1]);
        const {worktreeDependencies}=await import(process.argv[2]);const root=process.argv[3];
        const deps=worktreeDependencies();await deps.trust.grant(root,await deps.loadConfig(root));
        const controller=await productionLearningAutomation(root); console.log(JSON.stringify(await controller.reconcile()));`;
      const launched = await execFile(process.execPath, ['--input-type=module', '-e', script,
        moduleUrl('packages/cli/src/learning-deps.js'), moduleUrl('packages/cli/src/parallel-deps.js'), x.f.root], {env});
      const job = JSON.parse(launched.stdout); assert.ok(job, 'Production scheduler starts an explicitly registered fixture');
      let result;
      for (let i = 0; i < 150; i++) {
        result = (await x.controller.read()).jobs.find(j => j.id === job.id);
        if (!['launching', 'running'].includes(result.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(result.status, 'adopted', JSON.stringify(result));
      const recorded = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(recorded.length, 7); assert.equal(result.invocations, 7);
      assert.ok(recorded.every(c => c.cwd !== x.f.root && c.args.includes('read-only') && c.args.includes(x.settings.model)));
      assert.ok(recorded.every(c => !c.prompt.startsWith('Propose')));
      const listed = await execFile(process.execPath, [new URL(moduleUrl('packages/cli/src/bin.js')).pathname, 'learn', 'list', '--json'], {cwd: x.f.root, env});
      const output = JSON.parse(listed.stdout);
      assert.equal(output.data.automation.jobs.length, 1, 'Normal CLI reconciliation cannot rerun an already adopted candidate');
      assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 7);
    });
    await automationFixture(async x => {
      x.setAllowed(false);
      assert.equal(await x.controller.reconcile(), null); assert.equal((await x.controller.status()).waiting[x.id], 'NATIVE_DENIED');
      x.setAllowed(true); x.setConfig(c => ({...c, learning: undefined}));
      assert.equal(await x.controller.reconcile(), null); assert.equal((await x.controller.status()).waiting[x.id], 'SETUP_MISSING');
      assert.equal((await x.controller.status()).quota.attempts, 0); assert.equal(x.launches.length, 0);
    });
    await automationFixture(async x => {
      const job = await x.controller.reconcile(), bytes = JSON.stringify(job.input);
      const original = x.call();
      const result = await x.run(job, async (prompt, schema) => {
        const reply = await original(prompt, schema);
        // Mutating the launcher's returned copy cannot alter the controller's pinned artifact.
        job.input.candidate.proposal.strategies[0].cue = 'mutated caller copy';
        return reply;
      });
      assert.equal(result.status, 'adopted', result.reason);
      assert.equal(JSON.stringify((await x.controller.read()).jobs[0].input), bytes);
      assert.equal((await x.controller.status()).jobs[0].invocations, x.prompts.length);
    });
  }
};

export const pipelineChecks = {
  ...automationChecks,
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
