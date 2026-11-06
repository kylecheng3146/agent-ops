import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const load = async path => {
  try {return await import(pathToFileURL(join(resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist'), path)).href);}
  catch (e) {assert.fail(`${path} unavailable: ${e.code ?? e.message}`);}
};
async function fixture(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-resilience-')));
  try {
    const {FileRunRepository, createRunState} = await load('runtime/src/run/service.js');
    const repository = new FileRunRepository(join(root, 'runs'), root);
    const state = createRunState({root, commonDir: root, targetBranch: 'main', goal: 'Repair without losing work', host: 'claude', ownerSessionId: 'owner-fixed', contractHash: 'a'.repeat(64)});
    const worker = {workerId: state.coordinatorId, taskId: 'task-one', host: 'claude', ownerSessionId: 'owner-fixed',
      nativeSessionId: 'native-one', nativeJobId: null, worktree: root, processId: null, processIdentity: null,
      generation: 1, status: 'running', leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: 'active', lastFailure: null};
    await repository.create({...state, workers: [worker], rootTaskId: worker.taskId,
      tasks: [{taskId: worker.taskId, dependencies: [], status: 'running', workerId: worker.workerId, deliveryDigest: null, sourceCommit: null, blockedReason: null}]});
    const now = Date.now();
    const event = {type: 'error', host: 'claude', runId: state.runId, workerId: worker.workerId, generation: 1,
      contractHash: state.currentContractHash, at: new Date(now).toISOString(), nativeStatus: 'usageLimited', proof: false,
      payload: {type: 'assistant', apiError: 'usage_limit_reached', apiErrorStatus: 429, quotaLimits: {resetsAt: Math.ceil(now / 1000) + 60}}};
    const sent = [];
    const host = {host: 'claude', inspect: async () => ({processAlive: true, processIdentity: null, nativeGoalState: 'paused', stateDigest: null}),
      send: async input => {assert.ok((await repository.read(state.runId)).providerWait, "Resume intent must survive a crash until all sends finish"); sent.push(input);}, stop: async () => {}, start: async () => assert.fail('Wait must not start another writer'), resume: async () => assert.fail('Wait must not replace native session')};
    await check({root, repository, state: await repository.read(state.runId), worker, event, host, sent, now});
  } finally {await rm(root, {recursive: true, force: true});}
}
export const runResilienceChecks = {
  'run-unlimited-work': async () => {
    const {executeConfiguredCommand} = await load('runtime/src/verify/command-executor.js');
    const command = {id: 'slow-work', command: process.execPath, args: ['-e', 'setTimeout(()=>{},30)'], cwd: '.', required: true, evidence: {kind: 'exit-code'}, timeoutMs: 1};
    const result = await executeConfiguredCommand(command, {cwd: process.cwd(), trusted: true, unlimitedWork: true});
    assert.equal(result.status, 'PASS', 'Run work must survive a configured hard deadline');
    const normal = await executeConfiguredCommand(command, {cwd: process.cwd(), trusted: true});
    assert.equal(normal.timedOut, true, 'Standalone work retains its configured deadline');
    const {runVerificationCommand} = await load('runtime/src/verify/spawn.js');
    const controller = new AbortController(); controller.abort();
    const cancelled = await runVerificationCommand(command, {cwd: process.cwd(), timeoutMs: null, signal: controller.signal});
    assert.equal(cancelled.failureClass, 'aborted');
  },
  'run-provider-wait': () => fixture(async ({repository, state, worker, event, host, sent, now}) => {
    const {nativeProviderLimit, recordProviderWait, resumeProviderWait} = await load('runtime/src/run/provider-wait.js');
    assert.equal(nativeProviderLimit({error: {codexErrorInfo: {code: 'usage_limit_reached'}}}).reason, 'usage_limit_reached');
    assert.equal(nativeProviderLimit({message: 'usage_limit_reached resets tomorrow'}), null, 'Model prose cannot schedule execution');
    await recordProviderWait(repository, event);
    const waiting = await repository.read(state.runId);
    assert.equal(waiting.status, 'budget-limited'); assert.equal(waiting.disableRestart, false);
    assert.equal(waiting.workers[0].generation, worker.generation);
    assert.equal(waiting.workers[0].nativeSessionId, worker.nativeSessionId);
    let validated = 0;
    assert.equal(await resumeProviderWait(repository, host, state.runId, async () => {validated++;}, now), false);
    const due = Date.parse(waiting.providerWait.resetAt);
    assert.equal(await resumeProviderWait(repository, host, state.runId, async () => {validated++;}, due), true);
    assert.ok((await repository.read(state.runId)).events.some(e => e.code === 'RUN_REPAIR_SENT'));
    assert.equal(sent.length, 1); assert.equal(sent[0].nativeSessionId, worker.nativeSessionId); assert.equal(validated, 2);
    assert.equal(await resumeProviderWait(repository, host, state.runId, async () => {}, due + 1), false);
    await recordProviderWait(repository, event);
    assert.equal((await repository.read(state.runId)).status, "active", "Replayed notification cannot re-arm a consumed wait");
    await recordProviderWait(repository, {...event, payload: {apiError: "usage_limit_reached", quotaLimits: {resetsAt: Math.ceil(now/1000)+300}, goal: {updatedAt: Math.floor(now/1000)}}});
    assert.equal((await repository.read(state.runId)).status, "active", "Pre-resume quota snapshots cannot suspend the resumed writer");
    await recordProviderWait(repository, {...event, payload: {apiError: 'usage_limit_reached'}});
    const unknown = await repository.read(state.runId);
    assert.equal(unknown.status, 'paused'); assert.equal(unknown.awaitingResume, true); assert.equal(unknown.disableRestart, true);
    await fixture(async f => {
      const first = f.worker, second = {...first, workerId: 'writer-second', taskId: 'task-second',
        ownerSessionId: 'owner-second', nativeSessionId: 'native-second', worktree: join(f.root, 'second')};
      await f.repository.mutate(f.state.runId, s => ({...s, workers: [first, second], tasks: [...s.tasks,
        {...s.tasks[0], taskId: second.taskId, workerId: second.workerId}]}));
      await recordProviderWait(f.repository, f.event);
      const known = (await f.repository.read(f.state.runId)).providerWait.resetAt;
      await recordProviderWait(f.repository, {...f.event, workerId: second.workerId, payload: {status: 'usageLimited'}});
      assert.equal((await f.repository.read(f.state.runId)).providerWait.resetAt, known, 'Incomplete companion status retains the known reset');
      assert.equal(await resumeProviderWait(f.repository, f.host, f.state.runId, async () => {}, Date.parse(known)), true);
      assert.deepEqual(f.sent.map(s => s.nativeSessionId), ['native-one', 'native-second']);
      await recordProviderWait(f.repository, f.event);
      assert.equal((await f.repository.read(f.state.runId)).status, 'active', 'Each writer has a scoped consumed notification');
    });
  }),
  'run-native-repair-stream': async () => {
    const {ClaudeGoalHost} = await load('runtime/src/run/hosts/claude.js');
    const {nativeProcessDiagnostic} = await load('runtime/src/run/hosts/util.js');
    const context = {runId: 'run-stream', workerId: 'writer', generation: 1, contractHash: 'a'.repeat(64)};
    const script = "const rl=require('node:readline').createInterface({input:process.stdin});process.stderr.write('startup diagnostic');let n=0;rl.on('line',()=>{if(++n===1)process.stdout.write(JSON.stringify({type:'assistant',apiError:'usage_limit_reached',apiErrorStatus:429})+'\\n');process.stdout.write(JSON.stringify({type:'result',subtype:'success',n})+'\\n');});";
    const host = new ClaudeGoalHost({command: process.execPath, args: ['-e', script]});
    const handle = await host.start({...context, cwd: process.cwd()});
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await host.activate(handle, 'first turn', context);
      const results = []; let quotaSeen = false;
      for await (const e of host.observe(handle, {signal: controller.signal})) {
        if (e.nativeStatus === 'usageLimited') quotaSeen = true;
        if (e.type === 'completed') {results.push(e); if (results.length === 1) await host.update(handle, {...context, objective: 'repair turn'}); else break;}
      }
      assert.equal(quotaSeen, true, 'Structured Claude 429 must be a quota event');
      assert.equal(results.length, 2, 'A repair turn must still have an event consumer');
      assert.match(nativeProcessDiagnostic(handle.process), /startup diagnostic/);
    } finally {clearTimeout(timer); await host.stop(handle, context);}
    await fixture(async ({repository, state, worker}) => {
      const {NativeRunTransport} = await load('runtime/src/run/transport.js');
      const {spawn} = await import('node:child_process');
      const ids = [], children = [];
      const native = {kind: 'claude', start: async input => {
        ids.push(input.sessionId); const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'pipe'}); children.push(child);
        await input.registerProcess(child.pid);
        return {...input, kind: 'claude', sessionId: input.sessionId, threadId: null, nativeVersion: 'fake', processId: child.pid, process: child, startedAt: new Date().toISOString(), goalStatus: 'unknown'};
      }, observe: async function* () {}, stop: async () => {}};
      const bridge = new NativeRunTransport(native, repository, async () => {}, async () => 'owned-process');
      try {
        for (const generation of [1,2]) {
          await repository.mutate(state.runId, s => ({...s, workers: [{...worker, generation, status: 'starting', nativeSessionId: null, nativeJobId: null}]}));
          await bridge.start({runId: state.runId, workerId: worker.workerId, taskId: worker.taskId, ownerSessionId: worker.ownerSessionId,
            generation, worktree: worker.worktree, contractHash: state.currentContractHash, goal: 'repair'});
        }
        assert.notEqual(ids[0], ids[1], 'Fresh Claude sessions need distinct native IDs');
        assert.notEqual(ids[0], worker.ownerSessionId);
      } finally {for (const child of children) {const closed = new Promise(r => child.once('close', r)); child.kill('SIGKILL'); await closed;}}
    });
  },
  'run-fresh-failure-attempt': () => fixture(async ({repository, state, worker, root, host}) => {
    const {recordRunVerification, observeRunFailure} = await load('runtime/src/run/verification.js');
    const {RunSupervisor} = await load('runtime/src/run/supervisor.js');
    const task = {task: {id: worker.taskId, title: 'Test repair', goal: state.goal, criteria: []}, status: 'active'};
    await repository.mutate(state.runId, s => ({...s, policyBinding: {artifactDigest: 'a'.repeat(64), configHash: 'b'.repeat(64), runtimeHash: 'c'.repeat(64), expiresAt: new Date(Date.now()+60000).toISOString()}}));
    await recordRunVerification(repository, await repository.read(state.runId), worker.workerId, task,
      {taskId: worker.taskId, results: [{commandId: 'node-test', required: true, status: 'FAIL', failureClass: 'nonzero-exit'}], acceptance: []});
    const observed = await repository.read(state.runId);
    const verify = await observeRunFailure(observed, root, [task], worker.taskId, 'VERIFICATION_FAILED', []);
    const exit = await observeRunFailure(observed, root, [task], worker.taskId, 'RUN_NATIVE_EXITED', []);
    assert.notEqual(verify.failureKey, exit.failureKey, 'A native exit is not another execution of old failing tests');
    assert.equal(exit.checks[0].failureClass, 'RUN_NATIVE_EXITED');
    const supervisor = new RunSupervisor({repository, host});
    const input = {checkId: 'node-test', pinId: null, failureClass: 'assertion', fingerprint: 'a'.repeat(64), diagnosticDigest: 'b'.repeat(64), usefulProgress: false, attemptId: 'verify-1', round: 1};
    assert.equal((await supervisor.recordFailure(state.runId, worker.workerId, 1, input)).noProgress, false);
    assert.equal((await supervisor.recordFailure(state.runId, worker.workerId, 1, {...input, round: 2})).noProgress, false, 'Re-observing an attempt cannot count as a repair round');
  }),
  'run-recovery-controls': () => fixture(async ({repository, state, event, host, sent, now}) => {
    const {recordProviderWait, resumeProviderWait} = await load('runtime/src/run/provider-wait.js');
    const {RunService, assertRunState} = await load('runtime/src/run/service.js');
    await recordProviderWait(repository, event);
    const wait = (await repository.read(state.runId)).providerWait;
    assert.throws(() => assertRunState({...state, providerWait: {...wait, generation: -1}}));
    await new RunService(repository).stop(state.runId);
    assert.equal(await resumeProviderWait(repository, host, state.runId, async () => assert.fail('Stop forbids resume'), now+120000), false);
    assert.equal(sent.length, 0);
    await fixture(async f => {
      await f.repository.mutate(f.state.runId, s => ({...s, budget: {...s.budget, limitMs: 1,
        activeIntervals: [{startMs: f.now-100, endMs: null}]}}));
      await recordProviderWait(f.repository, f.event);
      assert.equal(await resumeProviderWait(f.repository, f.host, f.state.runId, async () => assert.fail('Legacy budget needs manual resume'), f.now+120000), false);
      assert.equal((await f.repository.read(f.state.runId)).status, 'paused'); assert.equal(f.sent.length, 0);
    });
    for (const mode of ['trust', 'dead', 'stop-race']) await fixture(async f => {
      await recordProviderWait(f.repository, f.event);
      const observer = {...f.host, inspect: async input => {
        if (mode === 'stop-race') await new RunService(f.repository).stop(f.state.runId);
        return {...await f.host.inspect(input), processAlive: mode !== 'dead'};
      }};
      assert.equal(await resumeProviderWait(f.repository, observer, f.state.runId, async () => {
        if (mode === 'trust') throw new Error('Trust revoked');
        assert.fail('Dead writer or Stop must forbid resume');
      }, f.now+120000), false, mode);
      assert.equal((await f.repository.read(f.state.runId)).status, mode === 'stop-race' ? 'stopping' : 'paused', mode);
      assert.equal(f.sent.length, 0, mode);
    });
  })
};
