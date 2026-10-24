import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {load, checkedGit, config, reviewedCandidate, sealNativeCandidate, runner} from './fixture.mjs';
import {withAssessment, reviewer, report} from './assessment-checks.mjs';

async function repairModule() {
  try {return await load('runtime/src/followup/process.js');}
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') assert.fail('Selected followups need production repair and evidence closure');
    throw error;
  }
}

async function startFixture(f) {
  const {FileRunRepository, createRunState} = await load('runtime/src/run/service.js');
  const repository = new FileRunRepository(join(f.commonDir, 'agent-ops/runs'), f.commonDir);
  const calls = [];
  const start = async input => {
    calls.push(input);
    const state = createRunState({...input, root: f.root, commonDir: f.commonDir, targetBranch: 'main', ownerSessionId: 'repair-owner'});
    await repository.create(state);
    return state;
  };
  return {repository, calls, start};
}

const launchd = supported => ({supported, writeDescriptor: async () => {}, bootstrap: async () => {}, enableRestart: async () => {},
  wake: async () => {}, disableRestart: async () => {}, bootout: async () => {}});

export const repairChecks = {
  'followup-repair-production-refusals': async () => {
    const api = await repairModule();
    await withAssessment(async ({f, item, options, store}) => {
      const receiptBytes = await readFile(item.provenance.receiptPath, 'utf8');
      const memory = await startFixture(f);
      for (const conclusion of ['UNKNOWN', 'ABSENT']) {
        const mock = await reviewer(f, [report(conclusion), report(conclusion)]);
        const result = await api.processFollowup({...options(mock.options), host: 'codex', start: memory.start});
        assert.equal(result.status, 'unresolved'); assert.equal(memory.calls.length, 0);
      }
      const {productionRunContext} = await load('packages/cli/src/run-deps.js');
      const {AgentOpsError} = await load('runtime/src/fs/paths.js');
      const checkRefusal = async (code, start) => {
        const mock = await reviewer(f);
        const result = await api.processFollowup({...options(mock.options), host: 'codex', start});
        assert.equal(result.status, 'unresolved'); assert.equal(result.code, code);
        assert.equal(result.attempts.at(-1).status, 'refused');
        assert.equal((await store.get(item.id)).disposition, 'pending');
      };
      await checkRefusal('RUN_BACKGROUND_UNSUPPORTED', async input => {
        const run = await productionRunContext(f.root, {launchd: launchd(false)});
        return (await run.service.start({...input, root: f.root, commonDir: f.commonDir, targetBranch: 'main', ownerSessionId: 'fixture'})).state;
      });
      await checkedGit(f.root, ['worktree', 'add', '-qb', 'linked', '.worktrees/linked']);
      await checkRefusal('WORKTREE_NESTED', async input => {
        const run = await productionRunContext(join(f.root, '.worktrees/linked'), {launchd: launchd(true)});
        return (await run.service.start({...input, root: f.root, commonDir: f.commonDir, targetBranch: 'main', ownerSessionId: 'fixture'})).state;
      });
      await checkedGit(f.root, ['worktree', 'remove', '.worktrees/linked']);
      await checkRefusal('RUN_TARGET_DIRTY', async input => {
        await writeFile(join(f.root, 'source.txt'), 'dirty\n');
        try {
          const run = await productionRunContext(f.root, {launchd: launchd(true)});
          return (await run.service.start({...input, root: f.root, commonDir: f.commonDir, targetBranch: 'main', ownerSessionId: 'fixture'})).state;
        } finally {await writeFile(join(f.root, 'source.txt'), 'candidate candidate\n');}
      });
      const originalHome = process.env.AGENT_OPS_HOME;
      try {
        process.env.AGENT_OPS_HOME = f.root;
        await checkRefusal('RUN_REPO_UNTRUSTED', async input => {
          const run = await productionRunContext(f.root, {launchd: launchd(true)});
          return (await run.service.start({...input, root: f.root, commonDir: f.commonDir, targetBranch: 'main', ownerSessionId: 'fixture'})).state;
        });
        const {loadEffectiveConfig, repositoryTrustBinding} = await load('packages/cli/src/context.js');
        const {trustStore} = await load('packages/cli/src/parallel-deps.js');
        const {CLI_VERSION} = await load('packages/cli/src/version.js');
        const trusted = (await loadEffectiveConfig(f.root, 'project')).config;
        await trustStore().grant(await repositoryTrustBinding(f.root, trusted, CLI_VERSION));
        const fresh = await reviewer(f);
        const started = await api.processFollowup({...options(fresh.options), host: 'codex', start: async input => {
          const run = await productionRunContext(f.root, {launchd: launchd(true)});
          return (await run.service.start({...input, root: f.root, commonDir: f.commonDir, targetBranch: 'main', ownerSessionId: 'fixture'})).state;
        }});
        assert.equal(started.code, 'FOLLOWUP_RUN_STARTED');
        const {FileRunRepository} = await load('runtime/src/run/service.js');
        const repository = new FileRunRepository(join(f.commonDir, 'agent-ops/runs'), f.commonDir);
        const production = await repository.read(started.attempts.at(-1).runId);
        assert.ok(production.policyBinding); assert.equal(production.workers[0].status, 'assigned');
        assert.equal(production.goal, started.attempts.at(-1).goal);
        await repository.mutate(production.runId, state => ({...state, status: 'failed', disableRestart: true}));
      } finally {if (originalHome === undefined) delete process.env.AGENT_OPS_HOME; else process.env.AGENT_OPS_HOME = originalHome;}
      for (const code of ['RUN_POLICY_STALE', 'RUN_NATIVE_APPROVAL_DENIED'])
        await checkRefusal(code, async () => {throw new AgentOpsError(code, 'Exact native refusal');});
      const mock = await reviewer(f, [{...report(), before: async () => writeFile(join(f.root, 'source.txt'), 'drift\n')}]);
      const drift = await api.processFollowup({...options(mock.options), host: 'codex', start: memory.start});
      assert.equal(drift.status, 'unresolved'); assert.equal(memory.calls.length, 0);
      assert.equal(await readFile(item.provenance.receiptPath, 'utf8'), receiptBytes, 'Source completion remains immutable');
    });
  },
  'followup-repair-concurrency-recovery': async () => {
    const api = await repairModule();
    await withAssessment(async ({f, item, options}) => {
      const memory = await startFixture(f), mock = await reviewer(f);
      const opts = {...options(mock.options), host: 'codex', start: memory.start};
      const results = await Promise.all([api.processFollowup(opts), api.processFollowup(opts)]);
      assert.ok(results.every(r => r.status === 'linked')); assert.equal(memory.calls.length, 1);
      assert.equal(mock.calls.length, 2, 'A competing selection reuses the linked run without more model calls');
      const first = results[0].attempts[0];
      assert.match(first.goal, new RegExp(item.id)); assert.match(first.goal, /finding-sha256/);
      assert.match(first.goal, /behavioral acceptance/);
      assert.equal((await memory.repository.read(first.runId)).goal, first.goal);
      const path = join(f.commonDir, 'agent-ops/followup/progress', `${item.id}.json`);
      const saved = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({...saved, status: 'starting', attempts: [{...first, status: 'starting'}]}));
      const recovered = await api.processFollowup(opts);
      assert.equal(recovered.status, 'linked'); assert.equal(memory.calls.length, 1, 'Crash after creation recovers the reserved run identity');
      await memory.repository.mutate(first.runId, state => ({...state, status: 'failed', disableRestart: true}));
      const denied = await reviewer(f);
      const partial = await api.processFollowup({...options(denied.options), host: 'codex', start: async input => {
        await memory.start(input); throw new Error('Crash after run record creation');
      }});
      assert.equal(partial.status, 'linked'); assert.equal(partial.code, 'FOLLOWUP_START_FAILED');
      assert.equal(partial.attempts.length, 2);
      assert.equal((await api.processFollowup(opts)).attempts.length, 2);
      assert.equal(memory.calls.length, 2);
      await rm(join(f.commonDir, 'agent-ops/runs', partial.attempts[1].runId + '.json'));
      await writeFile(path, JSON.stringify({...partial, status: 'starting', attempts: [...partial.attempts.slice(0, -1), {...partial.attempts[1], status: 'starting'}]}));
      assert.equal((await api.processFollowup(opts)).code, 'FOLLOWUP_START_PENDING');
      assert.equal(memory.calls.length, 2, 'Ambiguous interrupted start never launches a duplicate');
    });
    await withAssessment(async ({f, item}) => {
      const script = `
        import {appendFile} from 'node:fs/promises';
        import {join} from 'node:path';
        import {load,config,runner} from ${JSON.stringify(new URL('./fixture.mjs', import.meta.url).href)};
        import {reviewer} from ${JSON.stringify(new URL('./assessment-checks.mjs', import.meta.url).href)};
        const root=${JSON.stringify(f.root)},commonDir=${JSON.stringify(f.commonDir)},itemId=${JSON.stringify(item.id)};
        const api=await load('runtime/src/followup/process.js');
        const {FileRunRepository,createRunState}=await load('runtime/src/run/service.js');
        const repo=new FileRunRepository(join(commonDir,'agent-ops/runs'),commonDir);
        const mock=await reviewer({root});
        const result=await api.processFollowup({root,commonDir,itemId,targetBranch:'main',gitRunner:runner(root),loadConfig:async()=>config,
          review:mock.options,host:'codex',start:async input=>{
            const state=createRunState({...input,root,commonDir,targetBranch:'main',ownerSessionId:'race-owner'});
            await repo.create(state);await appendFile(join(commonDir,'starts.txt'),state.runId+'\\n');return state;
          }});
        console.log(result.attempts.at(-1).runId);
      `;
      const results = await Promise.all([0, 1].map(() => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
        {env: process.env, timeout: 60000})));
      assert.equal(results[0].stdout, results[1].stdout);
      assert.equal((await readFile(join(f.commonDir, 'starts.txt'), 'utf8')).trim().split('\n').length, 1,
        'Two real CLI processes cannot start duplicate repair runs');
    });
  },
  'followup-closure-specific-proof': async () => {
    const api = await repairModule();
    await withAssessment(async ({f, item, options, modules}) => {
      const memory = await startFixture(f), mock = await reviewer(f, [report('ABSENT'), report('ABSENT')]);
      let result = await api.processFollowup({...options(mock.options), reviewOnlyReason: 'No executable check can decide this source-review-only claim.',
        host: 'codex', start: memory.start});
      assert.equal(result.status, 'resolved'); assert.equal(memory.calls.length, 0);
      assert.equal(result.resolutions[0].commit, await checkedGit(f.root, ['rev-parse', 'HEAD']));
      assert.equal(result.resolutions[0].proofDigests.length, 3);
      await modules.setFollowupDisposition(new modules.FileFollowupStore(f.commonDir), item.id, 'accept', 'Retain explicit accepted-risk history.');
      assert.equal(result.resolutions[0].proofKind, 'review-only');
      const present = await reviewer(f);
      result = await api.processFollowup({...options(present.options), host: 'codex', start: memory.start});
      assert.equal(result.status, 'linked'); assert.equal(result.resolutions.length, 1, 'Reprocessing preserves earlier proof history');
      await memory.repository.mutate(result.attempts.at(-1).runId, state => ({...state, status: 'complete', disableRestart: true}));
      assert.deepEqual(await api.reconcileFollowupRepairs({...f.source, config}), []);
      assert.equal((await api.readFollowupProgress(f.commonDir, item.id)).status, 'linked', 'Completed run alone cannot close a finding');
    });
    for (const specific of [false, true, 'recovery']) await withAssessment(async ({f, item, options}) => {
      const memory = await startFixture(f), mock = await reviewer(f);
      const reason = 'The original claim concerns an independently reviewed source invariant with no executable oracle.';
      const linked = await api.processFollowup({...options(mock.options), reviewOnlyReason: reason, host: 'codex', start: memory.start});
      const attempt = linked.attempts.at(-1), run = await memory.repository.read(attempt.runId);
      const baseline = await checkedGit(f.root, ['rev-parse', 'HEAD']);
      const criteria = specific ? [{id: 'followup-resolution', description: api.followupResolutionDescription(item.id, attempt.findingDigest),
        verifierIds: ['node-test'], acceptance: {mode: 'review-only', baselineCommit: baseline, bindings: [], reviewOnlyReason: reason}},
        {id: 'regression', description: 'Preserve normal behavior.', verifierIds: ['node-test']}] : undefined;
      const candidate = await reviewedCandidate(f, {name: 'repair', modern: true, goal: attempt.goal, criteria, sessionId: run.ownerSessionId});
      const native = await sealNativeCandidate(f, candidate, run);
      const {finishWorktree} = await load('runtime/src/parallel/finish.js');
      let finished;
      if (specific === 'recovery') {
        const blocked = {...f.deps, git: async (cwd, args) => args[0] === 'worktree' && args[1] === 'remove'
          ? {exitCode: 1, stdout: '', stderr: 'Interrupted cleanup fixture'} : f.git(cwd, args)};
        await assert.rejects(finishWorktree(blocked, {cwd: f.root, name: native.record.name, finalProof: candidate.finalProof}), {code: 'WORKTREE_FINISH_PARTIAL'});
        finished = await finishWorktree(f.deps, {cwd: f.root, name: native.record.name, finalProof: {...candidate.finalProof, recovery: true}});
      } else finished = await finishWorktree(f.deps, {cwd: f.root, name: native.record.name, finalProof: candidate.finalProof});
      const progress = await api.readFollowupProgress(f.commonDir, item.id);
      assert.equal(progress.status, specific ? 'resolved' : 'linked', JSON.stringify(finished.warnings));
      if (specific) {
        const resolution = progress.resolutions.at(-1);
        assert.equal(resolution.commit, finished.mergedHead); assert.equal(resolution.receipt.runId, attempt.runId);
        assert.equal(resolution.receipt.path, finished.receipt); assert.ok(resolution.proofDigests.length >= 5);
        assert.equal((await api.reconcileFollowupRepairs({...f.source, config})).length, 0);
        assert.deepEqual(await api.readFollowupProgress(f.commonDir, item.id), progress, 'Cleanup reconciliation is idempotent');
        await writeFile(join(f.root, 'source.txt'), 'later source drift\n');
        assert.deepEqual(await api.reconcileFollowupRepairs({...f.source, config}), []);
        assert.deepEqual(await api.readFollowupProgress(f.commonDir, item.id), progress, 'Later drift cannot rewrite historical resolution proof');
        const {FileFollowupStore, setFollowupDisposition} = await load('runtime/src/followup/store.js');
        await setFollowupDisposition(new FileFollowupStore(f.commonDir), item.id, 'reopen');
        assert.equal((await api.readFollowupProgress(f.commonDir, item.id)).status, 'unresolved', 'Reopen retains proof without continuing to claim resolution');
      }
    });
    const originalRunners = config.verification.acceptanceRunners;
    try {
      config.verification.acceptanceRunners = [{id: 'specific-branch', command: 'node', args: ['check.mjs'], cwd: '.', adapter: 'generic'}];
      await withAssessment(async ({f, item, options}) => {
        const memory = await startFixture(f), mock = await reviewer(f);
        const linked = await api.processFollowup({...options(mock.options), host: 'codex', start: memory.start});
        const attempt = linked.attempts.at(-1), run = await memory.repository.read(attempt.runId);
        const baseline = await checkedGit(f.root, ['rev-parse', 'HEAD']);
        const criteria = [{id: 'followup-resolution', description: api.followupResolutionDescription(item.id, attempt.findingDigest), verifierIds: ['node-test'],
          acceptance: {mode: 'behavioral', baselineCommit: baseline, bindings: [{runnerId: 'specific-branch', checkIds: ['original-branch'], redCheckIds: ['original-branch'],
            materials: [{path: 'check.mjs', role: 'test'}]}]}}, {id: 'regression', description: 'Preserve normal behavior.', verifierIds: ['node-test']}];
        const script = `import {readFileSync} from 'node:fs';
          const pass=readFileSync('source.txt','utf8')==='repair candidate\\n';
          const executionId=process.env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID,phase=process.env.AGENT_OPS_ACCEPTANCE_PHASE;
          console.log(JSON.stringify({protocolVersion:1,executionId,phase,framework:'node-assert',frameworkVersion:'1',completed:true,
            completionEvidence:['The original source branch was asserted'],diagnostics:[],results:[{executionId,phase,framework:'node-assert',frameworkVersion:'1',
              checkId:'original-branch',status:pass?'PASS':'FAIL',failureClass:pass?'none':'assertion-failed',attempts:1,evidence:['source.txt branch behavior']}]}));
          if(!pass)process.exitCode=1;`;
        const candidate = await reviewedCandidate(f, {name: 'repair', modern: true, goal: attempt.goal, criteria,
          sessionId: run.ownerSessionId, extraFiles: {'check.mjs': script}});
        const {replayAcceptance} = await load('runtime/src/verify/acceptance-replay.js');
        const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js');
        const {NodeVerificationProcessRunner} = await load('runtime/src/verify/spawn.js');
        const results = await replayAcceptance({root: candidate.record.path, task: candidate.records[0].task, config, gitRunner: runner(candidate.record.path),
          processRunner: new NodeVerificationProcessRunner(), evidenceStore: new FileEvidenceStore(candidate.record.path, candidate.record.path),
          sourceFingerprint: candidate.fingerprint, trusted: true, scope: 'project'});
        assert.ok(results.every(r => r.status === 'PASS'), JSON.stringify(results));
        await f.deps.tasks(candidate.record.path).recordEvidence(candidate.records[0].task.id,
          {'followup-resolution': results.map(r => r.reference)}, candidate.record.base);
        const native = await sealNativeCandidate(f, candidate, run);
        const {finishWorktree} = await load('runtime/src/parallel/finish.js');
        const finished = await finishWorktree(f.deps, {cwd: f.root, name: native.record.name, finalProof: candidate.finalProof});
        const progress = await api.readFollowupProgress(f.commonDir, item.id);
        assert.equal(progress.status, 'resolved', JSON.stringify(finished.warnings));
        assert.equal(progress.resolutions.at(-1).proofKind, 'behavioral');
        assert.ok(progress.resolutions.at(-1).proofDigests.length >= 8, 'Exact paired execution artifacts survive checkout cleanup');
      });
    } finally {
      if (originalRunners === undefined) delete config.verification.acceptanceRunners;
      else config.verification.acceptanceRunners = originalRunners;
    }
  }
};
