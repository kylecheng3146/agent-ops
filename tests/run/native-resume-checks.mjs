import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const mod = path => import(pathToFileURL(join(resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist'), path)).href);
const requestedAt = '2026-10-20T00:00:10.000Z', now = '2026-10-20T00:00:20.000Z';
const old = Date.parse(requestedAt) / 1000 - 10;
const server = `
const readline = require('node:readline');
const mode = JSON.parse(process.argv[1]);
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const goal = (status, updatedAt) => ({threadId:'thread-one',status,tokenBudget:null,tokensUsed:321,timeUsedSeconds:42,updatedAt});
const notify = (status, updatedAt) => send({...(mode.requestId ? {id:mode.requestId} : {}),method:'thread/goal/updated',params:{threadId:mode.foreign ? 'foreign' : 'thread-one',goal:goal(status,updatedAt)}});
readline.createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line); if (m.id === undefined) return;
  let result = {};
  if (m.method === 'thread/resume') {if (mode.failStart) process.exit(7); notify('budgetLimited', mode.updatedAt); result={thread:{id:'thread-one'}};}
  if (m.method === 'thread/goal/set') result={goal:goal(m.params.status === 'paused' ? 'paused' : (mode.ack ?? 'active'), mode.updatedAt)};
  if (m.method === 'turn/start') {
    if (mode.ack && mode.ack !== 'active') throw Error('An inactive goal must never start a turn');
    result={turn:{id:'turn-one'}};
    if (mode.fresh) notify('budgetLimited', mode.updatedAt);
  }
  send({id:m.id,result});
});`;

async function fixture(check) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-native-resume-'));
  const {createRunState, FileRunRepository, RunService} = await mod('runtime/src/run/service.js');
  const repository = new FileRunRepository(join(root, 'runs'), root, () => now);
  const state = createRunState({root, commonDir: root, targetBranch: 'main', host: 'codex', goal: 'Keep original work', ownerSessionId: 'owner', contractHash:'a'.repeat(64), now});
  const worker = {workerId: state.coordinatorId, taskId: 'task-one', host:'codex', ownerSessionId:'owner', nativeSessionId:'native-one',
    nativeJobId:'thread-one', worktree:root, processId:null, processIdentity:null, generation:1, status:'stopped', leaseExpiresAt:null,
    heartbeatAt:null, stopIntent:null, nativeGoalState:'inactive', lastFailure:null};
  const task = {taskId:'task-one', dependencies:[], status:'ready', workerId:worker.workerId, deliveryDigest:null, sourceCommit:null, blockedReason:null};
  await repository.create({...state, workers:[worker], tasks:[task], status:'budget-limited', disableRestart:true,
    budget:{...state.budget, accumulatedMs:100, activeIntervals:[{startMs:0,endMs:100}]}});
  await repository.appendEvent(state.runId, {type:'status', code:'RUN_SUPERVISOR_START', workerId:null, taskId:null, detail:null});
  // The previous supervisor precedes this explicit user control.
  await repository.mutate(state.runId, s => ({...s, events:s.events.map(e => ({...e,at:'2026-10-20T00:00:00.000Z'}))}));
  const service = new RunService(repository, () => requestedAt);
  try {await check({root, state, repository, service, worker, task});}
  finally {await rm(root, {recursive:true,force:true});}
}

async function replay(f, mode, manual = true) {
  const {RunSupervisor} = await mod('runtime/src/run/supervisor.js');
  const {NativeRunTransport} = await mod('runtime/src/run/transport.js');
  const {CodexGoalHost} = await mod('runtime/src/run/hosts/codex.js');
  const controls = await mod('runtime/src/run/controls.js');
  await f.service.resume(f.state.runId);
  const state = await f.repository.read(f.state.runId);
  const cutoff = manual ? (controls.nativeResumeTime ? controls.nativeResumeTime(state, Date.parse(now)) : requestedAt) : undefined;
  if (cutoff !== undefined) await new controls.RunControlService(f.repository, () => now).markApplied(f.state.runId,'resume',cutoff);
  let limits = 0, seen;
  const limitWrites = [];
  const host = new CodexGoalHost({command:process.execPath,args:['-e',server,JSON.stringify(mode)],now:() => new Date(mode.clock ?? now),requestTimeoutMs:2000});
  const open = host.resume.bind(host);
  host.resume = async (...args) => (seen = await open(...args));
  const bridge = new NativeRunTransport(host, f.repository, async event => {
    if (['budgetLimited','usageLimited'].includes(event.nativeStatus)) {
      limits++;
      const write = f.repository.mutate(f.state.runId, s => ({...s,status:'budget-limited',disableRestart:true}));
      limitWrites.push(write);
      await write;
    }
  }, async pid => {try {process.kill(pid,0); return 'owned:'+pid;} catch {return null;}});
  const supervisor = new RunSupervisor({repository:f.repository,host:bridge,now:() => now});
  let error;
  try {
    try {
      const assigned = await supervisor.reassignWorker(f.state.runId,f.worker.workerId,1);
      const running = await supervisor.startWorker(f.state.runId,assigned.workerId,assigned.generation,'Keep original work',cutoff);
      await bridge.activateRegistered(f.state.runId,running,'Keep original work');
    } catch (cause) {
      if (!['RUN_START_DISABLED','RUN_WORKER_STALE','NATIVE_GOAL_NOT_ACTIVE'].includes(cause.code)) throw cause;
      error = cause;
    }
    for (let i=0;i<10;i++) await delay(10);
    await Promise.all(limitWrites);
    return {saved:await f.repository.read(f.state.runId),limits,error,seen};
  }
  finally {if (seen) await host.stop(seen,seen);}
}

export const nativeResumeChecks = {
  'native-resume-snapshot': async () => {await fixture(async f => {
    const before = await f.repository.read(f.state.runId);
    const result = await replay(f,{updatedAt:old});
    assert.equal(result.error,undefined,`An older preactivation snapshot must allow the manually resumed writer to activate: ${result.error?.code}`);
    assert.equal(result.limits,0);
    assert.equal(result.saved.status,'active');
    assert.equal(result.saved.runId,before.runId);
    assert.equal(result.saved.goalHash,before.goalHash);
    assert.deepEqual(result.saved.budget,before.budget);
    assert.deepEqual(result.saved.events,before.events);
    assert.equal(result.seen.threadId,'thread-one');
    const {nativeResumeTime} = await mod('runtime/src/run/controls.js');
    assert.equal(nativeResumeTime?.({...result.saved,events:[]},Date.parse(now)),undefined,'Applied manual recovery cannot revive when bounded event history rolls over');
  });
    await fixture(async f => {
      const result = await replay(f,{updatedAt:old,fresh:true});
      assert.equal(result.limits,1,'A fresh postactivation limit is authoritative even with an older provider timestamp');
      assert.equal(result.saved.disableRestart,true);
    });
    await fixture(async f => {
      const result = await replay(f,{updatedAt:old,foreign:true});
      assert.equal(result.error,undefined);
      assert.equal(result.limits,0,'A foreign thread notification cannot change this writer');
    });
    for (const ack of ['paused','budgetLimited','unknown']) await fixture(async f => {
      const result = await replay(f,{updatedAt:old,ack});
      assert.equal(result.error?.code,'NATIVE_GOAL_NOT_ACTIVE','An inactive acknowledgement cannot start or steer a turn');
    });
  },
  'native-resume-policy-recovery': () => fixture(async f => {
    await f.repository.mutate(f.state.runId,s => ({...s,workers:[...s.workers.map(w => ({...w,status:'blocked'})),{...f.worker,workerId:'product-worker',taskId:'product',status:'blocked'}],
      tasks:[{...f.task,status:'blocked',blockedReason:'RUN_POLICY_DISABLED'},
        {...f.task,taskId:'task-two',dependencies:['task-one'],status:'blocked',blockedReason:'RUN_POLICY_DISABLED'},
        {...f.task,taskId:'product',status:'blocked',blockedReason:'RUN_NO_PROGRESS_REPEAT'}]}));
    await f.repository.appendEvent(f.state.runId,{type:'diagnostic',code:'RUN_POLICY_DISABLED',workerId:f.worker.workerId,taskId:'task-one',detail:'Recovery stopped after old native snapshot'});
    const before = await f.repository.read(f.state.runId), result = (await f.service.resume(f.state.runId)).state;
    assert.equal(result.workers[0].status,'stopped','Manual recovery must release the derivative inactive-policy worker block');
    assert.equal(result.workers[1].status,'blocked','A product-blocked writer cannot acquire recovery authority');
    assert.deepEqual(result.tasks.map(t => [t.taskId,t.status,t.blockedReason]),[
      ['task-one','ready',null],['task-two','ready',null],['product','blocked','RUN_NO_PROGRESS_REPEAT']]);
    assert.deepEqual(result.events,before.events);
    assert.deepEqual(result.budget,before.budget);
  }),
  'native-resume-boundary': async () => {
    await fixture(async f => {
      await assert.rejects(replay(f,{failStart:true}),{code:'RUN_NATIVE_START_FAILED'},'Infrastructure failures must propagate, never become a product regression assertion');
    });
    for (const [mode,manual] of [[{updatedAt:old},false],[{updatedAt:Date.parse(requestedAt)/1000},true],
      [{updatedAt:Date.parse(now)/1000},true],[{},true],[{updatedAt:'old'},true],
      [{updatedAt:old,clock:'2026-10-20T00:00:09.000Z'},true],[{updatedAt:old,fresh:true},false],
      [{updatedAt:old,requestId:2001},true],[{updatedAt:old,requestId:'server-request'},true]]) {
      await fixture(async f => {
        const result = await replay(f,mode,manual);
        assert.ok(result.limits > 0,'An unproven or nonmanual native limit remains observable');
        assert.equal(result.saved.disableRestart,true);
      });
    }
    await fixture(async f => {
      await f.repository.appendEvent(f.state.runId,{type:'control',code:'RUN_COMMAND_DENIED',workerId:f.worker.workerId,taskId:'task-one',detail:'Genuine denial'});
      await assert.rejects(f.service.resume(f.state.runId),{code:'RUN_NOT_RESUMABLE'});
    });
    const {nativeResumeTime} = await mod('runtime/src/run/controls.js');
    if (nativeResumeTime) await fixture(async f => {
      await f.service.resume(f.state.runId);
      const current = await f.repository.read(f.state.runId);
      assert.equal(nativeResumeTime(current,Date.parse(now)),requestedAt);
      for (const control of [{action:'pause',actor:'user',requestedAt},
        {action:'resume',actor:'supervisor',requestedAt},{action:'resume',actor:'user',requestedAt:'invalid'},
        {action:'resume',actor:'user',requestedAt:'2099-01-01T00:00:00Z'}])
        assert.equal(nativeResumeTime({...current,controls:[{...control,appliedAt:null}]},Date.parse(now)),undefined);
      assert.equal(nativeResumeTime(current,Date.parse(requestedAt)-1),undefined);
      assert.equal(nativeResumeTime({...current,events:[...current.events,{code:'RUN_SUPERVISOR_START',at:requestedAt}]},Date.parse(now)),undefined);
      assert.equal(nativeResumeTime({...current,events:[...current.events,{code:'RUN_SUPERVISOR_START',at:'invalid'}]},Date.parse(now)),undefined);
    });
    await fixture(async f => {
      await f.repository.mutate(f.state.runId,s => ({...s,workers:s.workers.map(w => ({...w,status:'blocked',lastFailure:{id:'failure',failureClass:'assertion',checkId:null,pinId:null,fingerprint:null,diagnosticDigest:null,round:2,observedAt:now,usefulProgress:false}}))}));
      await assert.rejects(f.service.resume(f.state.runId),{code:'RUN_NOT_RESUMABLE'});
    });
  }
};
