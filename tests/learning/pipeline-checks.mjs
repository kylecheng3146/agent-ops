import assert from 'node:assert/strict';
import {execFile as execute} from 'node:child_process';
import {chmod, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {withRepository, reviewedCandidate, rewriteReceipt, sealNativeCandidate, load, moduleUrl} from '../followup/fixture.mjs';
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

export const pipelineChecks = {
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
