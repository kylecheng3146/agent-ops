import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const mod = path => import(pathToFileURL(join(build, path)).href);
const now = '2026-10-24T00:00:00.000Z';

async function fixture(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-handoff-recovery-')));
  const {createRunState, FileRunRepository, RunService} = await mod('runtime/src/run/service.js');
  const repository = new FileRunRepository(join(root, 'runs'), root);
  const initial = createRunState({root, commonDir: root, targetBranch: 'main', goal: 'Keep the original goal', host: 'codex', ownerSessionId: 'owner', now});
  const worker = {workerId:'child-writer', taskId:'task-child', host:'codex', ownerSessionId:'child-owner',
    nativeSessionId:'native-child', nativeJobId:'job-child', worktree:root, processId:12345, processIdentity:'old-process',
    generation:3, status:'blocked', leaseExpiresAt:null, heartbeatAt:now, nativeGoalState:'inactive',
    stopIntent:{runId:initial.runId,workerId:'child-writer',generation:3,nativeSessionId:'native-child',reason:'handoff',
      deliveryDigest:'a'.repeat(64),contractDigest:'b'.repeat(64),sourceCommit:'c'.repeat(40),expiresAt:now,confirmedDeadAt:now},
    lastFailure:{id:'failure-one',failureClass:'RUN_FINAL_PROOF_INTERRUPTED',checkId:'RUN_FINAL_PROOF_INTERRUPTED',pinId:null,
      fingerprint:'d'.repeat(64),diagnosticDigest:'e'.repeat(64),phase:'native',progressDigest:'f'.repeat(64),round:2,observedAt:now,usefulProgress:false}};
  const node = {taskId:'task-child',dependencies:['task-delivered'],status:'blocked',workerId:worker.workerId,deliveryDigest:null,sourceCommit:null,blockedReason:'RUN_FINAL_PROOF_INTERRUPTED'};
  const state = {...initial,status:'awaiting-input',rootTaskId:'task-root',coordinatorId:'coordinator',
    workers:[{...worker,workerId:'coordinator',taskId:'task-root',nativeSessionId:null,nativeJobId:null,processId:null,processIdentity:null,
      status:'stopped',stopIntent:null,lastFailure:null},worker],
    tasks:[{...node,taskId:'task-root',dependencies:[],workerId:'coordinator',status:'awaiting-delivery',blockedReason:null},
      {...node,taskId:'task-delivered',dependencies:[],workerId:null,status:'delivered',deliveryDigest:'1'.repeat(64),sourceCommit:'2'.repeat(40),blockedReason:null},node]};
  try {
    await repository.create(state);
    await repository.appendEvent(state.runId,{type:'diagnostic',code:'RUN_FAILURE_RECORDED',workerId:worker.workerId,taskId:worker.taskId,detail:'Original interrupted attempt'});
    await repository.appendEvent(state.runId,{type:'diagnostic',code:'RUN_NO_PROGRESS_REPEAT',workerId:worker.workerId,taskId:worker.taskId,detail:'Original fence'});
    await check({root,repository,state:await repository.read(state.runId),worker,node,service:new RunService(repository,()=>now)});
  } finally {await rm(root,{recursive:true,force:true});}
}

async function diagnostic(program, check) {
  await fixture(async f => {
    const {runControlledStep} = await mod('packages/cli/src/run-entry.js');
    const preload = join(f.root,'preload.cjs');
    await writeFile(preload, `if (process.argv[1]?.endsWith('/bin.js')) {${program}}`);
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${previous ?? ''} --require ${JSON.stringify(preload)}`;
    const saved = await f.repository.mutate(f.state.runId,s=>({...s,status:'active',workers:[]}));
    try {
      let value, error;
      try {value = await runControlledStep(f.repository,join(build,'packages/cli/src/bin.js'),f.root,['verify'],saved);}
      catch (cause) {error=cause;}
      await check({value,error,saved:await f.repository.read(f.state.runId)});
    } finally {if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS=previous;}
  });
}

async function productionBoundary() {
  if (process.platform !== 'darwin') return;
  for (const mode of ['valid','dirty','source','owner','trust']) await fixture(async f=>{
    const prior={home:process.env.AGENT_OPS_HOME,path:process.env.PATH};
    const git=(cwd,args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    try {
      process.env.AGENT_OPS_HOME=join(f.root,'home');
      await mkdir(process.env.AGENT_OPS_HOME,{mode:0o700});
      git(f.root,['init','-qb','main']); git(f.root,['config','user.name','Recovery fixture']); git(f.root,['config','user.email','fixture@example.invalid']);
      await writeFile(join(f.root,'.gitignore'),'.agent-ops/\n.worktrees/\nruns/\nbin/\nhome/\n');
      await writeFile(join(f.root,'source.txt'),'original\n'); git(f.root,['add','.']); git(f.root,['commit','-qm','baseline']);
      const head=git(f.root,['rev-parse','HEAD']), child=join(f.root,'.worktrees','child');
      git(f.root,['worktree','add','-qb','child',child]);
      await mkdir(join(f.root,'.agent-ops'),{recursive:true}); await mkdir(join(f.root,'bin'));
      const config={schemaVersion:3,profiles:['core'],verification:{commands:[]},features:{completionGate:{enabled:false},stopVerification:{enabled:false}},pathMappings:[],securityExceptions:[],worktree:{mode:'auto',setup:[]}};
      await writeFile(join(f.root,'.agent-ops/config.json'),JSON.stringify(config));
      await writeFile(join(f.root,'bin/codex'),"#!/bin/sh\nprintf 'fixture-codex-version\\n'\n",{mode:0o700});
      process.env.PATH=join(f.root,'bin')+':'+prior.path;
      const {loadEffectiveConfig,repositoryTrustBinding}=await mod('packages/cli/src/context.js');
      const {CLI_VERSION}=await mod('packages/cli/src/version.js');
      const {trustStore}=await mod('packages/cli/src/parallel-deps.js');
      const {productionRunContext}=await mod('packages/cli/src/run-deps.js');
      const {bindRunPolicy,runRuntimeHash}=await mod('runtime/src/run/policy.js');
      const {writeWorktreeRecord}=await mod('runtime/src/parallel/service.js');
      const effective=(await loadEffectiveConfig(f.root,'project')).config;
      const binding=await repositoryTrustBinding(f.root,effective,CLI_VERSION);
      await trustStore().grant(binding);
      let wakes=0;
      const launchd={supported:true,writeDescriptor:async()=>{},bootstrap:async()=>{},enableRestart:async()=>{},wake:async()=>{wakes++;},disableRestart:async()=>{},bootout:async()=>{}};
      const context=await productionRunContext(f.root,{launchd});
      await context.repository.create({...f.state,status:'active',commonDir:context.commonDir,workers:f.state.workers.map((w,i)=>({...w,
        nativeSessionId:null,nativeJobId:null,processId:null,processIdentity:null,worktree:i===1?child:f.root,
        stopIntent:i===1?{...w.stopIntent,nativeSessionId:null,sourceCommit:head}:null}))});
      const record={schemaVersion:1,name:'child',path:child,mainRoot:f.root,branch:'child',targetBranch:'main',base:head,sessionId:'child-owner',createdAt:now,
        runId:f.state.runId,coordinatorId:'coordinator',workerId:'child-writer',ownerSessionId:'child-owner',workerGeneration:3};
      await writeWorktreeRecord(record);
      await bindRunPolicy(context.repository,f.state.runId,{config:effective,runtimeHash:await runRuntimeHash(),baseTrustBinding:binding});
      await context.repository.mutate(f.state.runId,s=>({...s,status:'awaiting-input'}));
      if (mode==='dirty') await writeFile(join(child,'uncommitted.txt'),'preserve this');
      if (mode==='source') {await writeFile(join(child,'source.txt'),'changed\n'); git(child,['commit','-qam','unacknowledged source']);}
      if (mode==='owner') await writeWorktreeRecord({...record,ownerSessionId:'foreign-owner'});
      if (mode==='trust') await trustStore().revoke(binding);
      const retry=()=>context.service.resume(f.state.runId,[],true,'task-child');
      if (mode==='valid') {assert.equal((await retry()).state.tasks.at(-1).status,'ready'); assert.equal(wakes,1);}
      else {
        await assert.rejects(retry(),{code:{dirty:'RUN_RECOVERY_DIRTY',source:'RUN_DELIVERY_RETRY_INVALID',owner:'RUN_DELIVERY_RETRY_INVALID',trust:'RUN_REPO_UNTRUSTED'}[mode]});
        assert.equal((await context.repository.read(f.state.runId)).tasks.at(-1).status,'blocked'); assert.equal(wakes,0);
      }
    } finally {
      if (prior.home===undefined) delete process.env.AGENT_OPS_HOME; else process.env.AGENT_OPS_HOME=prior.home;
      if (prior.path===undefined) delete process.env.PATH; else process.env.PATH=prior.path;
    }
  });
}

export const handoffRecoveryChecks = {
  'controlled-step-failure-diagnostics': async () => {
    await diagnostic(`process.stderr.write('handoff-marker token=private-fixture-secret\\n'); process.exit(23);`,async ({error,saved}) => {
      assert.equal(error?.code,'RUN_FINAL_PROOF_INTERRUPTED');
      assert.match(error.message,/handoff-marker/,'An interrupted proof must retain the actual subprocess diagnostic');
      assert.match(error.message,/"exitCode":23/);
      assert.match(error.message,/REDACTED/);
      assert.doesNotMatch(error.message,/private-fixture-secret/);
      assert.equal(saved.proofProcess,null);
      const event=saved.events.find(e=>e.code==='RUN_CONTROLLED_STEP_FAILED');
      assert.ok(event,'Failure context must survive in run logs');
      assert.ok(event.detail.length<=10000);
      assert.doesNotMatch(event.detail,/private-fixture-secret/);
    });
    await diagnostic(`console.log(JSON.stringify({status:'ok',code:'FIXTURE_OK'})); process.exit(0);`,async ({value,error}) => {
      assert.equal(error,undefined); assert.equal(value.code,'FIXTURE_OK');
    });
    await diagnostic(`console.log(JSON.stringify({status:'error',code:'FIXTURE_REFUSED'})); process.exit(1);`,async ({value,error}) => {
      assert.equal(error,undefined); assert.equal(value.code,'FIXTURE_REFUSED');
    });
    await diagnostic(`console.log(JSON.stringify({status:'ok',code:'FALSE_SUCCESS'})); process.exit(23);`,async ({error}) => {
      assert.equal(error?.code,'RUN_FINAL_PROOF_INTERRUPTED','Nonzero exit must not become a successful gate');
    });
    if (process.platform !== 'win32') await diagnostic(`process.kill(-Number(process.env.AGENT_OPS_RUN_PROOF_PID),'SIGKILL');`,async ({error}) => {
      assert.equal(error?.code,'RUN_FINAL_PROOF_INTERRUPTED'); assert.match(error.message,/"signal":"SIGKILL"/);
    });
    await diagnostic(`process.stdout.write('x'.repeat(5*1024*1024)); process.stderr.write('bounded-output'); process.exit(23);`,async ({error,saved}) => {
      assert.equal(error?.code,'RUN_FINAL_PROOF_INTERRUPTED'); assert.ok(error.message.length<11000);
      assert.equal(saved.proofProcess,null);
    });
  },
  'explicit-delivery-retry': () => fixture(async f => {
    const ordinary=(await f.service.resume(f.state.runId)).state;
    assert.equal(ordinary.tasks.at(-1).status,'blocked','Ordinary resume must preserve the no-progress fence');
    const before=await f.repository.read(f.state.runId);
    const result=(await f.service.resume(f.state.runId,[],true,'task-child')).state;
    assert.equal(result.tasks.at(-1).status,'ready','Explicit recovery must requeue the selected interrupted child');
    assert.equal(result.workers[1].status,'stopped');
    assert.equal(result.workers[1].lastFailure,null,'A deliberate new attempt must not inherit the old repeat counter');
    assert.deepEqual(result.tasks.slice(0,-1),before.tasks.slice(0,-1));
    for (const key of ['runId','goal','goalHash','rootTaskId','currentContractHash','createdAt','budget','integration']) assert.deepEqual(result[key],before[key],key);
    assert.deepEqual(result.events.slice(0,before.events.length),before.events,'Historical failures must survive');
    assert.match(result.controls.at(-1).reason,/failure-one/);
    assert.equal(result.tasks.at(-1).deliveryDigest,null);
    assert.equal(result.tasks.at(-1).sourceCommit,null);
    await assert.rejects(f.service.resume(f.state.runId,[],true,'task-child'),{code:'RUN_DELIVERY_RETRY_INVALID'},'Repeated stale recovery must fail');
    const {RunSupervisor}=await mod('runtime/src/run/supervisor.js');
    const supervisor=new RunSupervisor({repository:f.repository,host:{host:'codex',inspect:async()=>({processAlive:false}),start:async()=>{throw Error('No writer needed');}}});
    const reassigned=await supervisor.reassignWorker(f.state.runId,f.worker.workerId,3);
    assert.equal(reassigned.generation,4,'The old native generation cannot restart');
    assert.equal(reassigned.status,'assigned');
  }),
  'delivery-retry-authority-boundaries': async () => {
    const {parseArgs}=await mod('packages/cli/src/args.js');
    let parsed;
    try {parsed=parseArgs(['run','resume','run-fixture','--retry-delivery','task-child']);}
    catch (error) {assert.equal(error.code,'CLI_UNKNOWN_OPTION'); return; /* Baseline has no delivery retry authority. */}
    assert.equal(parsed.retryDeliveryTaskId,'task-child');
    for (const args of [['run','status','run-fixture','--retry-delivery','task-child'],
      ['run','resume','run-fixture','--retry-delivery','task-child','--retry-delivery','task-other'],
      ['run','resume','run-fixture','--retry-delivery','task-child','--retry-approval','auth-'+'a'.repeat(64)]]) assert.throws(()=>parseArgs(args));
    const cases=[
      s=>({...s,status:'complete'}),s=>({...s,status:'failed'}),s=>({...s,proofProcess:{processId:123,processIdentity:'live'}}),
      s=>({...s,workers:s.workers.map((w,i)=>i===1?{...w,status:'running'}:w)}),
      s=>({...s,workers:s.workers.map((w,i)=>i===1?{...w,stopIntent:null}:w)}),
      s=>({...s,workers:s.workers.map((w,i)=>i===1?{...w,stopIntent:{...w.stopIntent,generation:2}}:w)}),
      s=>({...s,workers:s.workers.map((w,i)=>i===1?{...w,lastFailure:{...w.lastFailure,failureClass:'assertion-failed'}}:w)}),
      s=>({...s,tasks:s.tasks.map(t=>t.taskId==='task-child'?{...t,status:'delivered'}:t)}),
      s=>({...s,tasks:s.tasks.map(t=>t.taskId==='task-child'?{...t,blockedReason:'RUN_COMMAND_DENIED'}:t)}),
      s=>({...s,workers:s.workers.map((w,i)=>i===1?{...w,stopIntent:{...w.stopIntent,confirmedDeadAt:'2099-01-01T00:00:00Z'}}:w)}),
      s=>({...s,events:[...s.events,{id:'denial',at:now,type:'diagnostic',code:'RUN_COMMAND_DENIED',workerId:'child-writer',taskId:'task-child',detail:'Independent refusal'}]})
    ];
    for (const mutate of cases) await fixture(async f=>{
      await f.repository.mutate(f.state.runId,mutate);
      const before=await f.repository.read(f.state.runId);
      await assert.rejects(f.service.resume(f.state.runId,[],true,'task-child'));
      assert.deepEqual(await f.repository.read(f.state.runId),before,'Refusal must not mutate authority');
    });
    for (const task of ['task-root','task-foreign','task-delivered']) await fixture(async f=>{
      await assert.rejects(f.service.resume(f.state.runId,[],true,task),{code:'RUN_DELIVERY_RETRY_INVALID'});
    });
    await fixture(async f=>{
      await assert.rejects(f.service.resume(f.state.runId,[],true,'task-child','stale-failure'),{code:'RUN_DELIVERY_RETRY_INVALID'});
      await assert.rejects(f.service.resume(f.state.runId,['auth-'+'a'.repeat(64)],true,'task-child'),{code:'RUN_DELIVERY_RETRY_INVALID'});
      await f.repository.mutate(f.state.runId,s=>({...s,status:'blocked',disableRestart:true}));
      assert.equal((await f.service.resume(f.state.runId,[],true,'task-child')).state.tasks.at(-1).status,'ready');
    });
    await fixture(async f=>{
      const {runRunCommand}=await mod('packages/cli/src/commands/run.js');
      const args=parseArgs(['run','resume',f.state.runId,'--retry-delivery','task-child']);
      const result=await runRunCommand({args,service:f.service,root:f.root,commonDir:f.root,targetBranch:'main',ownerSessionId:'owner'});
      assert.equal(result.status,'ok');
      assert.equal((await f.repository.read(f.state.runId)).tasks.at(-1).status,'ready','CLI must forward explicit retry');
    });
    await productionBoundary();
  }
};
