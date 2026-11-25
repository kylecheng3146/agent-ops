// Independent QA: automatic learning accepts an exact Codex catalog id (gpt-<version>-<name>) under target codex only,
// and a registration switched from a failed agy run to codex gpt-6.2-sol reserves a new job.
// Run by tests/qa/acceptance.mjs from a built checkout (dist/, or AGENT_OPS_DEBUG_TEST_BUILD).
// Runtime and fixture modules load lazily so a baseline without the change fails by assertion, never at collection.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const fixtures = () => import(pathToFileURL(resolve('tests/followup/fixture.mjs')).href);
async function modules() {
  const {load} = await fixtures();
  return {...await load('runtime/src/review/criteria.js'), ...await load('runtime/src/learning/intake.js'),
    ...await load('runtime/src/learning/history.js'), ...await load('runtime/src/learning/store.js'),
    ...await load('runtime/src/learning/setup.js'), ...await load('runtime/src/learning/data.js'),
    ...await load('runtime/src/learning/automation.js'), ...await load('runtime/src/parallel/finish.js')};
}

const surface = {included: [{id: 'source', path: 'source.txt', behavior: 'Source behavior'}]};
const advice = {summary: 'Bounded advice', recommendations: [], limitations: []};
const proposal = {strategies: [{id: 'source-boundary', paths: ['source.txt'], cue: 'Check reentry', check: 'Require a repeat delivery assertion'}],
  expectedImprovement: 'Catch omitted repeat behavior', failureCondition: 'Any regression'};
const suite = {schemaVersion: 1, cases: Array.from({length: 4}, (_, i) => ({id: `independent-${i}`, split: i < 2 ? 'probe' : 'holdout',
  snapshot: {originalGoal: `Independent labelled behavior ${i}`, criteria: [{id: 'behavior', description: `Required behavior ${i}`},
    {id: 'regression', description: 'Boundaries'}], surface: {included: [{path: 'source.txt'}]}}, expected: i % 2 ? [] : ['redo']}))};

/** Disposable repository: one delivered task, an authored candidate citing it, and a committed confirmed suite. */
async function withLearningFixture(check) {
  const m = await modules(), fx = await fixtures();
  await fx.withRepository(async f => {
    const c = await fx.reviewedCandidate(f, {name: 'history', modern: true, goal: 'Preserve traceable delivery behavior'});
    await m.finishWorktree(f.deps, {cwd: f.root, name: c.record.name, finalProof: c.finalProof});
    const history = await m.matchingCompletedCases(f.source, ['source.txt']);
    const requests = [];
    async function* stream(v = '') {yield Buffer.from(v);}
    const runner = {start: request => {
      requests.push(request);
      const reply = {...advice, candidates: [{sourceCaseIds: [history[0].id], proposal}]};
      return {pid: 123, stdout: stream(JSON.stringify(reply)), stderr: stream(),
        completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => {}};
    }};
    const review = await m.runCriteriaReview({root: f.root, commonDir: f.commonDir, learningSource: f.source,
      task: {...c.records[0].task, id: 'task-author', goal: 'A related follow-up task', surface}, target: 'codex', runner, rerun: true});
    assert.equal(review.report.status, 'COMPLETED', 'Fixture candidate authoring completes');
    const store = new m.CandidateStore(f.commonDir), id = (await store.ids()).at(-1), candidate = await store.read(id);
    await writeFile(join(f.root, 'evaluation.json'), JSON.stringify(suite));
    await fx.checkedGit(f.root, ['add', 'evaluation.json']);
    await fx.checkedGit(f.root, ['commit', '-qm', 'Register independent evaluation suite']);
    const registration = settings => ({suitePath: 'evaluation.json', suiteDigest: m.digest(suite), humanConfirmed: true, independentlyLabelled: true, settings});
    const configFor = (settings, targets = [settings.target]) => ({...fx.config,
      reviewRoles: [{role: 'independent-review', targets}], learning: registration(settings)});
    const resolveFor = (settings, targets) => m.resolveLearningSetup({...f.source, config: configFor(settings, targets), candidate});
    await check({m, f, fx, id, candidate, registration, configFor, resolveFor});
  });
}

export const checks = {
  'codex-catalog-id-eligible': async () => {
    await withLearningFixture(async x => {
      for (const model of ['gpt-6.2-sol', 'gpt-6-luna', 'gpt-5.6-terra']) {
        const settings = {target: 'codex', model, effort: 'medium'};
        const setup = await x.resolveFor(settings);
        assert.equal(setup.status, 'eligible', `codex ${model} is an exact catalog pin`);
        assert.equal(setup.reason, 'READY', `codex ${model} is READY`);
        assert.deepEqual(setup.settings, settings, `codex ${model} keeps the requested settings`);
        assert.equal(setup.settings.model, model);
        const registration = x.registration(settings);
        assert.equal(setup.fingerprint, x.m.digest({registration, suite, settings}), `codex ${model} fingerprint is deterministic`);
        assert.equal((await x.resolveFor(settings)).fingerprint, setup.fingerprint, `codex ${model} fingerprint is stable across calls`);
      }
    });
  },
  'codex-catalog-id-rejections-and-scope': async () => {
    await withLearningFixture(async x => {
      for (const model of ['gpt-5.4', 'gpt-5.4-high', 'gpt-6.2-auto', 'gpt-6.2-latest', 'gpt-6.2-default', 'gpt-6.2-minimal', 'gpt-6.2-low',
        'gpt-6.2-medium', 'gpt-6.2-xhigh', 'codex-auto-review', 'gpt-reserve', 'gpt-6.2-sol-preview', 'GPT-6.2-SOL', 'latest', 'default',
        'model-1-latest', 'opus', 'gpt-4o']) {
        const setup = await x.resolveFor({target: 'codex', model, effort: 'medium'});
        assert.equal(setup.status, 'waiting', `codex ${model} must wait`);
        assert.equal(setup.reason, 'MODEL_NOT_FIXED', `codex ${model} is not a fixed model`);
      }
      for (const target of ['agy', 'claude']) {
        const setup = await x.resolveFor({target, model: 'gpt-6.2-sol', effort: 'medium'});
        assert.equal(setup.status, 'waiting', `gpt-6.2-sol under ${target} must wait`);
        assert.equal(setup.reason, 'MODEL_NOT_FIXED', `The Codex catalog shape is accepted only under codex, not ${target}`);
      }
      const dated = {target: 'codex', model: 'model-2026-01', effort: 'high'};
      const datedSetup = await x.resolveFor(dated);
      assert.equal(datedSetup.status, 'eligible', 'A dated codex model stays eligible');
      assert.equal(datedSetup.fingerprint, x.m.digest({registration: x.registration(dated), suite, settings: dated}),
        'A previously accepted dated codex registration keeps its fingerprint');
      const agy = {target: 'agy', model: 'gemini-3.8-flash-high', effort: 'high'};
      const agySetup = await x.resolveFor(agy);
      assert.equal(agySetup.status, 'eligible', 'The agy catalog id stays eligible');
      assert.equal(agySetup.fingerprint, x.m.digest({registration: x.registration(agy), suite, settings: agy}),
        'A previously accepted agy registration keeps its fingerprint');
    });
  },
  'codex-migration-after-failed-agy-jobs': async () => {
    await withLearningFixture(async x => {
      const agy = {target: 'agy', model: 'gemini-3.8-flash-high', effort: 'high'};
      const codex = {target: 'codex', model: 'gpt-6.2-sol', effort: 'medium'};
      let configured = x.configFor(agy);
      const owner = {pid: process.pid, identity: 'fixture', group: false}, launches = [];
      const controller = new x.m.LearningAutomation({...x.f.source, loadConfig: async () => configured,
        authority: async () => ({allowed: true, fingerprint: 'authority-a', reason: 'NATIVE_DENIED'}),
        owner: async () => owner, alive: async () => true, now: () => new Date('2026-11-25T08:00:00Z'), launch: async job => {launches.push(job);}});
      const failing = async () => ({value: null, durationMs: 1, failure: 'TARGET_FAILED'});

      const first = await controller.reconcile();
      assert.ok(first, 'The agy registration reserves a job');
      assert.equal(first.input.setup.settings.target, 'agy');
      await controller.bind(first.id, first.token, owner);
      await controller.execute(first.id, first.token, failing);
      const failed = (await controller.read()).jobs.find(j => j.id === first.id);
      assert.equal(failed.status, 'failed', 'The TARGET_FAILED agy job is recorded as failed');
      assert.equal(await controller.reconcile(), null, 'An unchanged registration does not reserve another job');

      configured = x.configFor(codex);
      const second = await controller.reconcile();
      assert.ok(second, 'Switching to codex gpt-6.2-sol reserves a new job');
      assert.equal(second.input.setup.settings.target, 'codex');
      assert.equal(second.input.setup.settings.model, 'gpt-6.2-sol');
      assert.equal(second.input.setup.settings.effort, 'medium');
      assert.notEqual(second.id, first.id);
      assert.notEqual(second.key, first.key, 'The codex job has a different deduplication key');
      assert.equal(second.candidateId, x.id);
      assert.equal((await controller.status()).waiting[x.id], undefined, 'The candidate is no longer waiting');
      assert.equal(launches.length, 2);
      assert.equal((await controller.read()).jobs.length, 2);
    });
  }
};
