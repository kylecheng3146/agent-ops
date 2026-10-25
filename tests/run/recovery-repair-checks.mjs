import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm, access, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {heartbeatCleanupChecks} from '../worktree/heartbeat-cleanup-checks.mjs';

const load = path => import(pathToFileURL(join(resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist'), path)).href);
const session = 'cleanup-owner';
const config = {schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: []},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};

async function fixture(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-recovery-repair-')));
  const git = async (cwd, args) => {
    try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}), stderr: ''};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '')};}
  };
  const run = async (cwd, ...args) => {const r = await git(cwd, args); assert.equal(r.exitCode, 0, r.stderr); return r.stdout.trim();};
  try {
    await run(root, 'init', '-qb', 'main');
    await run(root, 'config', 'user.name', 'Recovery fixture');
    await run(root, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n.worktrees/\n');
    await run(root, 'add', '.'); await run(root, 'commit', '-qm', 'base');
    const target = await run(root, 'rev-parse', 'HEAD'), commonDir = join(root, '.git');
    const {createRunState, FileRunRepository, RunService} = await load('runtime/src/run/service.js');
    const repository = new FileRunRepository(join(commonDir, 'agent-ops/runs'), commonDir);
    const state = createRunState({root, commonDir, goal: 'Recover the original transaction', host: 'codex', targetBranch: 'main', ownerSessionId: session});
    await repository.create(state);
    await check({root, commonDir, target, state, repository, service: new RunService(repository), run, git});
  } finally {await rm(root, {recursive: true, force: true});}
}

async function sealed(f) {
  const {root, commonDir, target, state, repository, run} = f;
  const {sessionWorktreeName, writeWorktreeRecord} = await load('runtime/src/parallel/service.js');
  const {prepareRunIntegration, markRunIntegration, integrationReceiptBinding} = await load('runtime/src/run/integration.js');
  const {writePrivateFile} = await load('runtime/src/security/permissions.js');
  const {sha256} = await load('runtime/src/fs/hash.js');
  const name = sessionWorktreeName(session), path = join(root, '.worktrees', name), branch = 'agent-ops/' + name;
  await run(root, 'worktree', 'add', '-qb', branch, path);
  const record = {schemaVersion: 1, name, path, mainRoot: root, branch, targetBranch: 'main', base: target,
    sessionId: session, createdAt: state.createdAt, runId: state.runId, coordinatorId: state.coordinatorId,
    workerId: state.coordinatorId, ownerSessionId: session, workerGeneration: 1};
  await writeWorktreeRecord(record);
  const worker = {workerId: state.coordinatorId, taskId: 'root-task', host: 'codex', ownerSessionId: session,
    nativeSessionId: null, nativeJobId: null, worktree: path, processId: null, processIdentity: null, generation: 1,
    status: 'stopped', leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: 'inactive', lastFailure: null};
  await repository.mutate(state.runId, s => ({...s, workers: [worker]}));
  const proof = {target, head: target, sourceFingerprint: 'f'.repeat(64), children: []};
  await prepareRunIntegration(commonDir, record, proof);
  const receiptPath = join(commonDir, 'agent-ops/receipts/cleanup.json');
  const receipt = JSON.stringify({schemaVersion: 1, sessionId: session, candidateHead: target, targetCommit: target,
    integrationJournal: integrationReceiptBinding((await repository.read(state.runId)).integration), tasks: [], residualRisks: []});
  await writePrivateFile(receiptPath, receipt, commonDir);
  const receiptDigest = sha256(receipt);
  for (const [status, step] of [['target-moved', 'target'], ['tasks-completed', 'tasks'], ['receipt-written', 'receipt'], ['receipt-written', 'note'], ['receipt-written', 'gate'], ['receipt-written', 'trust']])
    await markRunIntegration(commonDir, record, status, step, step === 'receipt' ? {path: receiptPath, digest: receiptDigest} : undefined);
  await run(root, 'notes', '--ref=agent-ops', 'add', '-m', `session: ${session}\nreceipt: ${receiptPath}\nreceipt-sha256: ${receiptDigest}`, target);
  return {record, proof, receiptPath, receiptDigest, receipt};
}

export const recoveryRepairChecks = {
  'run-recovery-status': async () => {
    const {runRunCommand} = await load('packages/cli/src/commands/run.js');
    await fixture(async f => {
      await f.repository.mutate(f.state.runId, s => ({...s, status: 'blocked', phase: 'integrating', disableRestart: true}));
      await f.repository.appendEvent(f.state.runId, {type: 'diagnostic', code: 'WORKTREE_FINISH_PARTIAL', workerId: null, taskId: null,
        detail: 'remove: WORKTREE_REMOVE_FAILED: contains modified or untracked files'});
      const status = await runRunCommand({args: {runAction: 'status', runId: f.state.runId}, service: f.service,
        root: f.root, commonDir: f.commonDir, targetBranch: 'main', ownerSessionId: session});
      assert.equal(status.status, 'ok');
      assert.equal(status.data.recovery?.phase, 'integrating', 'Status must expose the recovery phase');
      assert.equal(status.data.recovery.cause.code, 'WORKTREE_FINISH_PARTIAL');
      assert.match(status.data.text, /WORKTREE_REMOVE_FAILED/);
      assert.match(status.data.text, /Remediation:/);
      assert.equal(status.data.recovery.resumable, false, 'Unsealed generic integration errors cannot restart writers');
      for (const [code, remedy] of [['RUN_REPO_UNTRUSTED', /trust/i], ['RUN_NATIVE_IDENTITY_MISMATCH', /identity/i],
        ['RUN_REQUEST_STALE', /generation/i], ['RUN_COMMAND_DENIED', /authorization|denial/i]]) {
        await f.repository.appendEvent(f.state.runId, {type: 'diagnostic', code, workerId: null, taskId: null, detail: 'Preserved original blocker'});
        const result = await runRunCommand({args: {runAction: 'status', runId: f.state.runId}, service: f.service,
          root: f.root, commonDir: f.commonDir, targetBranch: 'main', ownerSessionId: session});
        assert.match(result.data.recovery.remediation, remedy);
      }
      await f.repository.mutate(f.state.runId, s => ({...s, status: 'active', disableRestart: false}));
      const {receiptPath} = await sealed(f);
      assert.ok(receiptPath);
      await assert.rejects(f.service.resume(f.state.runId), {code: 'RUN_NOT_RESUMABLE'}, 'Sealed proof cannot erase command denial');
    });
    await heartbeatCleanupChecks['integration-recovery-original-error']();
  },
  'run-cleanup-proof': async () => {
    const {runAdvanceCommand} = await load('packages/cli/src/commands/advance.js');
    const {recoverRunIntegrationAfterCleanup} = await load('runtime/src/run/integration.js');
    for (const mode of ['valid', 'missing-note', 'later-target', 'receipt', 'proof', 'note', 'target', 'owner', 'generation', 'writer', 'paused', 'stopping', 'disabled', 'dirty']) await fixture(async f => {
      const s = await sealed(f);
      const deps = {git: f.git, loadConfig: async () => config,
        tasks: () => assert.fail('Cleanup must not recompute task/proof state'),
        gate: () => assert.fail('Completed gate step must not repeat'),
        trust: {revoke: () => assert.fail('Completed trust step must not repeat')}};
      if (mode === 'receipt') await writeFile(s.receiptPath, s.receipt + ' ');
      if (mode === 'proof') await writeFile(join(f.commonDir, 'agent-ops/runs', f.state.runId, 'integration-proof.json'), '{}');
      if (mode === 'note') await f.run(f.root, 'notes', '--ref=agent-ops', 'remove', f.target);
      if (mode === 'missing-note') {
        await f.run(f.root, 'notes', '--ref=agent-ops', 'remove', f.target);
        await f.repository.mutate(f.state.runId, state => ({...state, integration: {...state.integration,
          completedSteps: state.integration.completedSteps.filter(step => step !== 'note')}}));
      }
      if (mode === 'later-target') await f.run(f.root, 'commit', '--allow-empty', '-qm', 'later target');
      if (mode === 'target') {
        const unrelated = await f.run(f.root, 'commit-tree', await f.run(f.root, 'rev-parse', 'HEAD^{tree}'), '-m', 'unrelated target');
        await f.run(f.root, 'update-ref', 'refs/heads/main', unrelated);
      }
      if (mode === 'owner' || mode === 'generation') {
        const {writeWorktreeRecord} = await load('runtime/src/parallel/service.js');
        await writeWorktreeRecord({...s.record, ...(mode === 'owner' ? {workerId: 'foreign'} : {workerGeneration: 2})});
      }
      if (mode === 'writer') await f.repository.mutate(f.state.runId, state => ({...state, workers: state.workers.map(w => ({...w, status: 'running'}))}));
      if (mode === 'paused' || mode === 'stopping') await f.repository.mutate(f.state.runId, state => ({...state, status: mode}));
      if (mode === 'disabled') await f.repository.mutate(f.state.runId, state => ({...state, disableRestart: true}));
      if (mode === 'dirty') await writeFile(join(s.record.path, 'user.txt'), 'preserve');
      const advance = () => runAdvanceCommand({cwd: f.root, sessionId: session, parentTaskId: 'root-task', deps,
        step: () => assert.fail('Cleanup cannot execute verify/review')});
      if (['valid', 'missing-note', 'later-target'].includes(mode)) {
        const targetBefore = await f.run(f.root, 'rev-parse', 'main');
        if (mode === 'valid') await assert.rejects(recoverRunIntegrationAfterCleanup(f.commonDir, f.state.runId, f.git),
          {code: 'RUN_INTEGRATION_CLEANUP_PENDING'}, 'Existing owned checkouts cannot be declared cleaned');
        const result = await advance();
        assert.equal(result.status, 'ok');
        assert.equal(result.data.receipt, s.receiptPath);
        assert.equal(await readFile(s.receiptPath, 'utf8'), s.receipt, 'Existing receipt bytes must survive');
        assert.equal((await f.repository.read(f.state.runId)).integration.status, 'cleaned');
        assert.equal(await f.run(f.root, 'rev-parse', 'main'), targetBefore, 'Cleanup cannot rewrite the target');
        await assert.rejects(access(s.record.path), {code: 'ENOENT'});
        await recoverRunIntegrationAfterCleanup(f.commonDir, f.state.runId, f.git);
      } else {
        const code = {receipt: 'RUN_INTEGRATION_RECEIPT_INVALID', proof: 'RUN_INTEGRATION_PROOF_CHANGED',
          note: 'RUN_INTEGRATION_RECOVERY_REQUIRED', target: 'RUN_INTEGRATION_RECOVERY_REQUIRED',
          owner: 'RUN_INTEGRATION_OWNERSHIP', generation: 'RUN_INTEGRATION_OWNERSHIP',
          writer: 'RUN_INTEGRATION_RECOVERY_REQUIRED', paused: 'RUN_RESUME_DISABLED', stopping: 'RUN_RESUME_DISABLED',
          disabled: 'RUN_RESUME_DISABLED', dirty: 'WORKTREE_REMOVE_FAILED'}[mode];
        await assert.rejects(advance(), {code});
        await access(s.record.path);
        assert.equal((await f.repository.read(f.state.runId)).integration.status, 'receipt-written');
        if (mode === 'dirty') {
          await assert.rejects(advance(), {code: 'RUN_CLEANUP_UNCHANGED'}, 'Same inputs must not repeat the failed cleanup');
          assert.equal(await readFile(join(s.record.path, 'user.txt'), 'utf8'), 'preserve');
          await rm(join(s.record.path, 'user.txt'));
          assert.equal((await advance()).status, 'ok', 'A remediation delta permits one fresh cleanup attempt');
        }
      }
    });
    await heartbeatCleanupChecks['dead-heartbeat-final-proof-cleanup']();
    await heartbeatCleanupChecks['foreign-heartbeat-preserved']();
  },
  'repair-resets-stopped-native-thread': () => fixture(async f => {
    const runEntry = await load('packages/cli/src/run-entry.js');
    assert.equal(typeof runEntry.resetStoppedRepairThread, 'function', 'resetStoppedRepairThread must be exported from run-entry');
    const lastFailure = {
      id: 'fail-1',
      failureClass: 'assertion-failed',
      checkId: 'unit-test',
      pinId: null,
      fingerprint: 'a'.repeat(64),
      diagnosticDigest: 'b'.repeat(64),
      phase: 'verify',
      progressDigest: 'c'.repeat(64),
      round: 1,
      observedAt: f.state.createdAt,
      usefulProgress: false
    };
    const workerId = f.state.coordinatorId;
    const baseWorker = {
      workerId,
      taskId: 'root-task',
      host: 'codex',
      ownerSessionId: 'owner-fixed',
      nativeSessionId: 'owner-fixed',
      nativeJobId: 'thread-gen-2',
      worktree: f.root,
      processId: null,
      processIdentity: null,
      generation: 2,
      status: 'stopped',
      leaseExpiresAt: null,
      heartbeatAt: null,
      stopIntent: null,
      nativeGoalState: 'inactive',
      lastFailure
    };
    await f.repository.mutate(f.state.runId, s => ({
      ...s,
      workers: [baseWorker]
    }));

    // Dirty checkout must preserve native thread identity.
    const dirty = await runEntry.resetStoppedRepairThread(f.repository, f.state.runId, workerId, 2, false);
    assert.equal(dirty.nativeSessionId, 'owner-fixed', 'Dirty checkout must not reset nativeSessionId');
    assert.equal(dirty.nativeJobId, 'thread-gen-2', 'Dirty checkout must not reset nativeJobId');

    // Active running worker must preserve native thread identity.
    await f.repository.mutate(f.state.runId, s => ({
      ...s,
      workers: s.workers.map(w => w.workerId === workerId ? {...w, status: 'running'} : w)
    }));
    const activeWorker = await runEntry.resetStoppedRepairThread(f.repository, f.state.runId, workerId, 2, true);
    assert.equal(activeWorker.nativeSessionId, 'owner-fixed', 'Active running worker must not reset nativeSessionId');
    assert.equal(activeWorker.nativeJobId, 'thread-gen-2', 'Active running worker must not reset nativeJobId');

    // Stopped and fenced workers on a clean checkout must reset nativeSessionId and nativeJobId while keeping failure history.
    for (const status of ['stopped', 'fenced']) {
      await f.repository.mutate(f.state.runId, s => ({
        ...s,
        workers: s.workers.map(w => w.workerId === workerId ? {
          ...w,
          status,
          nativeSessionId: 'owner-fixed',
          nativeJobId: 'thread-gen-2'
        } : w)
      }));
      const reset = await runEntry.resetStoppedRepairThread(f.repository, f.state.runId, workerId, 2, true);
      assert.equal(reset.nativeSessionId, null, `${status} clean worker must reset nativeSessionId to null`);
      assert.equal(reset.nativeJobId, null, `${status} clean worker must reset nativeJobId to null`);
      assert.equal(reset.ownerSessionId, 'owner-fixed', 'ownerSessionId must remain intact');
      assert.equal(reset.generation, 2, 'generation must remain intact until reassignWorker increments it');
      assert.deepEqual(reset.lastFailure, lastFailure, 'lastFailure history must remain intact across thread reset');
    }
  }),
  'codex-usage-epoch-by-native-job-id': () => fixture(async f => {
    const {recordNativeRunUsage} = await load('runtime/src/run/usage.js');
    const workerId = f.state.coordinatorId;
    const baseWorker = {
      workerId,
      taskId: 'root-task',
      host: 'codex',
      ownerSessionId: 'owner-shared',
      nativeSessionId: 'owner-shared',
      nativeJobId: 'job-1',
      worktree: f.root,
      processId: null,
      processIdentity: null,
      generation: 1,
      status: 'running',
      leaseExpiresAt: null,
      heartbeatAt: null,
      stopIntent: null,
      nativeGoalState: 'active',
      lastFailure: null
    };
    const makeEvent = (total, generation) => ({
      runId: f.state.runId,
      workerId,
      generation,
      contractHash: f.state.goalHash,
      host: 'codex',
      type: 'usage',
      at: '2026-10-25T00:00:00Z',
      nativeStatus: 'active',
      proof: false,
      payload: {tokenUsage: {total: {inputTokens: total - 2, outputTokens: 2, totalTokens: total}}}
    });
    await f.repository.mutate(f.state.runId, s => ({...s, workers: [baseWorker]}));
    await recordNativeRunUsage(f.repository, makeEvent(13, 1));

    await f.repository.mutate(f.state.runId, s => ({
      ...s,
      workers: s.workers.map(w => w.workerId === workerId ? {
        ...w,
        generation: 2,
        ownerSessionId: 'owner-shared',
        nativeSessionId: 'owner-shared',
        nativeJobId: 'job-2'
      } : w)
    }));
    await recordNativeRunUsage(f.repository, makeEvent(9, 2));
    const afterGen2 = await f.repository.read(f.state.runId);
    assert.equal(afterGen2.usage.length, 2, 'Distinct nativeJobId threads under the same nativeSessionId must record separate usage epochs');
    assert.equal(afterGen2.budget.usage.tokens, 22, 'Cumulative tokens must sum across distinct nativeJobId threads without overwriting');

    // Fallback when nativeJobId is null must still record usage keyed by nativeSessionId.
    await f.repository.mutate(f.state.runId, s => ({
      ...s,
      workers: s.workers.map(w => w.workerId === workerId ? {
        ...w,
        generation: 3,
        ownerSessionId: 'owner-fallback',
        nativeSessionId: 'owner-fallback',
        nativeJobId: null
      } : w)
    }));
    await recordNativeRunUsage(f.repository, makeEvent(6, 3));
    const afterFallback = await f.repository.read(f.state.runId);
    assert.equal(afterFallback.usage.length, 3, 'Fallback when nativeJobId is null must record its own usage epoch');
    assert.equal(afterFallback.budget.usage.tokens, 28);
  })
};
