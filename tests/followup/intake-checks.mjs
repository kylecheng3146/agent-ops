import assert from 'node:assert/strict';
import {execFile as execute} from 'node:child_process';
import {lstat, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {followupModules, withRepository, reviewedCandidate, rewriteReceipt, sealNativeCandidate, load, moduleUrl, checkedGit, finding} from './fixture.mjs';

const execFile = promisify(execute);
export const intakeChecks = {
  'followup-intake-valid-delivery': async () => {
    const {collectFollowupReceipt, FileFollowupStore} = await followupModules();
    const {finishWorktree} = await load('runtime/src/parallel/finish.js');
    for (const mode of ['plain', 'final', 'tree']) await withRepository(async f => {
      const candidate = await reviewedCandidate(f, {modern: mode !== 'plain', tree: mode === 'tree'});
      const preliminary = await candidate.prepare();
      assert.equal((await collectFollowupReceipt({...f.source, path: preliminary.path})).added, 0, 'Undelivered receipt cannot create followups');
      assert.equal((await new FileFollowupStore(f.commonDir).read()).items.length, 0);
      const result = await finishWorktree(f.deps, {cwd: f.root, name: candidate.record.name,
        ...(mode === 'plain' ? {} : {finalProof: candidate.finalProof})});
      assert.deepEqual(result.warnings, []);
      assert.equal(result.followup.added, 3, `${mode} finish automatically collects final evidence`);
      const {items} = await new FileFollowupStore(f.commonDir).read();
      assert.equal(items.length, 3, 'Tree aliases must not duplicate the review');
      const concrete = items.find(item => item.kind === 'candidate');
      assert.deepEqual(concrete.original.locations, [{path: 'source.txt', line: 1}]);
      assert.deepEqual(concrete.original.evidence, finding.evidence);
      assert.equal(concrete.original.recommendation, finding.recommendation);
      assert.equal(concrete.provenance.candidateHead, result.mergedHead);
      assert.equal(concrete.provenance.provenanceLimit, mode === 'plain' ? 'legacy-unbound-contract' : 'contract-bound');
      const source = JSON.parse(await readFile(result.receipt, 'utf8'));
      assert.ok(source.tasks.every(task => task.status === 'complete'));
      assert.equal((await collectFollowupReceipt({...f.source, path: result.receipt})).added, 0);
    });
    // Advisory state failure does not turn a valid finish into a failure; import can retry later.
    await withRepository(async f => {
      const candidate = await reviewedCandidate(f);
      const store = new FileFollowupStore(f.commonDir);
      await mkdir(store.path, {recursive: true});
      const result = await finishWorktree(f.deps, {cwd: f.root, name: candidate.record.name});
      assert.equal(result.mergedHead, candidate.head);
      assert.ok(result.warnings.some(warning => warning.includes('PRIVATE_STATE_PATH_INVALID')));
      await rm(store.path, {recursive: true});
      const retry = await collectFollowupReceipt({...f.source, path: result.receipt});
      assert.equal(retry.added, 3, JSON.stringify(retry));
    });
    await withRepository(async f => {
      const candidate = await reviewedCandidate(f, {modern: true});
      const native = await sealNativeCandidate(f, candidate);
      const store = new FileFollowupStore(f.commonDir);
      await mkdir(store.path, {recursive: true});
      const blocked = {...f.deps, git: async (cwd, args) => args[0] === 'worktree' && args[1] === 'remove'
        ? {exitCode: 1, stdout: '', stderr: 'Fixture interruption before coordinator cleanup'} : f.git(cwd, args)};
      await assert.rejects(finishWorktree(blocked, {cwd: f.root, name: native.record.name, finalProof: candidate.finalProof}), {code: 'WORKTREE_FINISH_PARTIAL'});
      assert.equal((await native.repository.read(native.state.runId)).integration.status, 'receipt-written');
      await rm(store.path, {recursive: true});
      const recovered = await finishWorktree(f.deps, {cwd: f.root, name: native.record.name, finalProof: {...candidate.finalProof, recovery: true}});
      assert.deepEqual(recovered.warnings, []);
      assert.equal(recovered.followup.added, 3, 'Native cleanup recovery retries advisory intake from the sealed final receipt');
      assert.equal((await store.read()).items.length, 3);
      assert.equal((await native.repository.read(native.state.runId)).integration.status, 'cleaned');
    });
  },
  'followup-intake-rejects-tampering': async () => {
    const {collectFollowupReceipt, FileFollowupStore} = await followupModules();
    const {finishWorktree} = await load('runtime/src/parallel/finish.js');
    const {sha256} = await load('runtime/src/fs/hash.js');
    await withRepository(async f => {
      const candidate = await reviewedCandidate(f, {modern: true});
      const result = await finishWorktree(f.deps, {cwd: f.root, name: candidate.record.name, finalProof: candidate.finalProof});
      assert.equal(result.followup.added, 3);
      const original = await readFile(result.receipt, 'utf8');
      const store = new FileFollowupStore(f.commonDir);
      const seal = value => ({digest: sha256(JSON.stringify(value)), value});
      const variants = [
        r => {r.tasks[0].status = 'active';},
        r => {r.tasks[0].evidence = {};},
        r => {r.tasks[0].task.title = 'Different contract';},
        r => {delete r.reviews[r.tasks[0].task.id].attestation;},
        r => {r.reviews[r.tasks[0].task.id].report.digest = '0'.repeat(64);},
        r => {const pair = r.reviews[r.tasks[0].task.id]; pair.report.value.status = 'FAIL'; pair.report = seal(pair.report.value);},
        r => {const pair = r.reviews[r.tasks[0].task.id]; pair.attestation.value.reviewSessionIds = ['same', 'same']; pair.attestation = seal(pair.attestation.value);},
        r => {const pair = r.reviews[r.tasks[0].task.id]; pair.report.value.report.findings[0].locations[0].path = '../secret'; pair.report = seal(pair.report.value);},
        r => {r.verification[Object.keys(r.verification)[0]].digest = '0'.repeat(64);},
        r => {delete r.reviews[r.tasks[0].task.id].report.value.adversarial;},
        r => {r.sourceFingerprint = '0'.repeat(64);}
      ];
      for (const change of variants) {
        await writeFile(result.receipt, original); await rm(store.path, {force: true});
        await rewriteReceipt(result.receipt, f, change);
        const collection = await collectFollowupReceipt({...f.source, path: result.receipt});
        assert.equal(collection.added, 0);
        assert.equal(collection.warnings.length, 1);
        assert.equal((await store.read()).items.length, 0);
      }
      await writeFile(result.receipt, original);
      await rewriteReceipt(result.receipt, f, () => {}, {rebind: false});
      assert.equal((await collectFollowupReceipt({...f.source, path: result.receipt})).added, 0, 'Exact bytes must match note');
      await writeFile(result.receipt, '{broken receipt');
      assert.equal((await collectFollowupReceipt({...f.source, path: result.receipt})).added, 0);
      await rm(result.receipt);
      await symlink(join(f.root, 'source.txt'), result.receipt);
      assert.equal((await collectFollowupReceipt({...f.source, path: result.receipt})).added, 0);
      assert.equal((await collectFollowupReceipt({...f.source, path: join(f.root, 'source.txt')})).added, 0);
    });
  },
  'followup-history-shared-idempotent': async () => {
    const {reconcileFollowups, FileFollowupStore, setFollowupDisposition} = await followupModules();
    const {finishWorktree} = await load('runtime/src/parallel/finish.js');
    const {resolveCheckouts} = await load('runtime/src/parallel/service.js');
    await withRepository(async f => {
      const candidate = await reviewedCandidate(f);
      const result = await finishWorktree(f.deps, {cwd: f.root, name: candidate.record.name});
      await rewriteReceipt(result.receipt, f, r => {r.schemaVersion = 1; delete r.commits; delete r.fileFingerprints;});
      const original = await readFile(result.receipt, 'utf8');
      const store = new FileFollowupStore(f.commonDir);
      await rm(store.path);
      const concurrent = await Promise.all([reconcileFollowups(f.source), reconcileFollowups(f.source)]);
      assert.equal(concurrent.reduce((sum, r) => sum + r.added, 0), 3);
      assert.ok(concurrent.every(r => r.warnings.length === 0));
      const item = (await store.read()).items[0];
      await setFollowupDisposition(store, item.id, 'accept', 'Documented acceptable tradeoff');
      await store.mutate(items => {const index = items.findIndex(i => i.id === item.id); items[index] = {...items[index], assessmentLink: 'preserved-evidence-link'};});
      const before = await readFile(store.path, 'utf8');
      const linked = join(f.root, 'linked');
      await checkedGit(f.root, ['worktree', 'add', '-qb', 'other', linked]);
      const checkouts = await resolveCheckouts(f.deps, linked);
      assert.equal(checkouts.commonDir, f.commonDir);
      assert.equal((await new FileFollowupStore(checkouts.commonDir).get(item.id)).disposition, 'accepted');
      assert.equal((await reconcileFollowups({...f.source, mainRoot: checkouts.mainRoot})).added, 0);
      assert.equal(await readFile(store.path, 'utf8'), before, 'History/disposition/link metadata must survive repeated import exactly');
      assert.equal(await readFile(result.receipt, 'utf8'), original, 'History sources remain immutable');
      if (process.platform !== 'win32') {
        assert.equal((await lstat(store.path)).mode & 0o777, 0o600);
        assert.equal((await lstat(join(f.commonDir, 'agent-ops/followup'))).mode & 0o777, 0o700);
      }
    });
  },
  'followup-ledger-dispositions-recovery': async () => {
    const {FileFollowupStore, setFollowupDisposition, clarifyFollowup, reconcileFollowups} = await followupModules();
    const {finishWorktree} = await load('runtime/src/parallel/finish.js');
    await withRepository(async f => {
      const candidate = await reviewedCandidate(f);
      await finishWorktree(f.deps, {cwd: f.root, name: candidate.record.name});
      const store = new FileFollowupStore(f.commonDir);
      const original = (await store.read()).items.find(item => item.kind === 'observation');
      await assert.rejects(setFollowupDisposition(store, original.id, 'accept', ' '), {code: 'FOLLOWUP_REASON_REQUIRED'});
      await assert.rejects(setFollowupDisposition(store, original.id, 'defer', ''), {code: 'FOLLOWUP_REASON_REQUIRED'});
      const clarified = await clarifyFollowup(store, original.id, finding, 'Located the exact affected branch');
      assert.equal(clarified.kind, 'candidate');
      assert.equal(clarified.original, original.original);
      assert.deepEqual(clarified.provenance, original.provenance);
      const deferred = await setFollowupDisposition(store, original.id, 'defer', 'Schedule separately');
      assert.equal(deferred.disposition, 'deferred');
      const reopened = await setFollowupDisposition(store, original.id, 'reopen');
      assert.equal(reopened.disposition, 'pending');
      assert.deepEqual(reopened.history.map(e => e.action), ['collected', 'clarified', 'deferred', 'reopened']);
      // Concurrent processes exercise the shared file lock, not only the in-process queue.
      const path = moduleUrl('runtime/src/followup/store.js');
      const script = 'const {FileFollowupStore,setFollowupDisposition}=await import(process.argv[1]); await setFollowupDisposition(new FileFollowupStore(process.argv[2]),process.argv[3],"accept",process.argv[4]);';
      await Promise.all(['process A', 'process B'].map(reason => execFile(process.execPath,
        ['--input-type=module', '-e', script, path, f.commonDir, original.id, reason])));
      assert.equal((await store.get(original.id)).history.length, reopened.history.length + 2);
      const bytes = await readFile(store.path, 'utf8');
      await writeFile(store.path, '{interrupted/corrupt');
      await assert.rejects(store.read(), {code: 'FOLLOWUP_STATE_INVALID'});
      assert.ok((await reconcileFollowups(f.source)).warnings.length);
      assert.equal(await readFile(store.path, 'utf8'), '{interrupted/corrupt', 'Malformed state is preserved, never reset');
      await writeFile(store.path, bytes);
      const privateCopy = join(f.root, 'preserved.json');
      await writeFile(privateCopy, bytes);
      await rm(store.path); await symlink(privateCopy, store.path);
      await assert.rejects(store.read(), {code: 'PRIVATE_STATE_PATH_INVALID'});
      assert.ok((await reconcileFollowups(f.source)).warnings.length);
      assert.equal(await readFile(privateCopy, 'utf8'), bytes);
    });
  }
};
