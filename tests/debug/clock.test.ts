import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {calculateConfigHash} from "../../runtime/src/config/hash.js";
import type {AgentOpsConfig} from "../../runtime/src/contracts.js";
import {nativeProcessIdentity} from "../../runtime/src/run/transport.js";
import {createDebugState, debugRemainingMs, validDebugState} from "../../runtime/src/task/debug-state.js";
import {TaskService} from "../../runtime/src/task/service.js";
import {FileTaskStore} from "../../runtime/src/task/store.js";

async function fixture(): Promise<{root:string; tasks:TaskService; taskId:string; store:FileTaskStore; close:()=>Promise<void>}> {
  const root=await mkdtemp(join(tmpdir(),"agent-ops-debug-clock-"));
  const git=(...args:string[])=>execFileSync("git",args,{cwd:root,stdio:["ignore","pipe","pipe"]});
  git("init","-q");
  git("config","user.name","Debug clock fixture");
  git("config","user.email","fixture@example.invalid");
  execFileSync("node",["-e","require('node:fs').writeFileSync('product.mjs','export const value=0;\\n')"],{cwd:root});
  git("add",".");
  git("commit","-qm","baseline");
  const baseline=git("rev-parse","HEAD").toString().trim();
  const gitRunner={run:async(args:readonly string[])=>{try{return {exitCode:0,stdout:git(...args)}}catch{return {exitCode:1,stdout:Buffer.alloc(0)}}}};
  const config:AgentOpsConfig={schemaVersion:3,profiles:["core"],verification:{commands:[],acceptanceRunners:[]},features:{completionGate:{enabled:false},stopVerification:{enabled:false},debug:{enabled:true,budgetMs:3_600_000,maxRounds:5}},pathMappings:[],securityExceptions:[]};
  const store=new FileTaskStore(join(root,".agent-ops/tasks/state.json"),root);
  const tasks=new TaskService(store,{completion:{root,gitRunner,loadConfig:async()=>config}});
  const criteria=["issue","related"].map(id=>({id,description:id,verifierIds:[],acceptance:{mode:"review-only" as const,baselineCommit:baseline,bindings:[],reviewOnlyReason:"Clock fixture does not prove completion."}}));
  const record=await tasks.create({title:"Clock fixture",goal:"Investigate the original issue",criteria,debug:{facts:["reported"],unknowns:["root cause"]},sessionId:"native-session",policyConfigHash:calculateConfigHash(config)});
  return {root,tasks,taskId:record.task.id,store,close:()=>rm(root,{recursive:true,force:true})};
}

test("foreground clock measures one native turn and never double counts an overlapping operation",async()=>{
  const state=createDebugState("root","a".repeat(40));
  state.foreground={sessionId:"native",startedAt:100};
  assert.equal(debugRemainingMs(state,1_100),3_599_000);
  state.operation={id:"op",taskId:"root",kind:"investigate",startedAt:500,contractHash:"a".repeat(64),configHash:"a".repeat(64),sourceFingerprint:"a".repeat(64),productDigest:"a".repeat(64)};
  assert.equal(debugRemainingMs(state,1_100),3_599_000);
  const legacy=structuredClone(state) as unknown as Record<string,unknown>;
  delete legacy.foreground;
  assert.equal(validDebugState(legacy),true);
});

test("foreground lifecycle is session-bound and dead operations are sealed before resume",async()=>{
  const f=await fixture();
  try {
    const debug=f.tasks.debugService();
    await debug.foregroundStart(f.taskId,"native-session");
    const before=(await debug.root(f.taskId)).debug.foreground;
    await debug.foregroundStart(f.taskId,"native-session");
    assert.equal((await debug.root(f.taskId)).debug.foreground?.startedAt,before?.startedAt);
    await assert.rejects(debug.foregroundStart(f.taskId,"other-session"),e=>e instanceof Error && "code" in e && e.code === "TASK_DEBUG_CLOCK_CONTESTED");
    await assert.rejects(debug.foregroundStop(f.taskId,"other-session"),e=>e instanceof Error && "code" in e && e.code === "TASK_DEBUG_CLOCK_OWNER_MISMATCH");
    await debug.foregroundStop(f.taskId,"native-session");
    assert.equal((await debug.root(f.taskId)).debug.foreground,null);

    const identity=await nativeProcessIdentity(process.pid);
    assert.ok(identity);
    await f.store.mutate(state=>{
      const record=state.tasks.find(item=>item.task.id===f.taskId)!;
      record.debug!.operation={id:"live",taskId:f.taskId,kind:"investigate",startedAt:Date.now(),contractHash:"a".repeat(64),configHash:"b".repeat(64),sourceFingerprint:"c".repeat(64),productDigest:"d".repeat(64),processId:process.pid,processIdentity:identity};
    });
    await assert.rejects(debug.foregroundStart(f.taskId,"native-session"),e=>e instanceof Error && "code" in e && e.code === "TASK_DEBUG_OPERATION_RUNNING");
    await f.store.mutate(state=>{
      const record=state.tasks.find(item=>item.task.id===f.taskId)!;
      record.debug!.operation={id:"dead",taskId:f.taskId,kind:"investigate",startedAt:Date.now()-20,contractHash:"a".repeat(64),configHash:"b".repeat(64),sourceFingerprint:"c".repeat(64),productDigest:"d".repeat(64),processId:999_999_999,processIdentity:"dead-process"};
    });
    await debug.foregroundStart(f.taskId,"native-session");
    const recovered=(await debug.root(f.taskId)).debug;
    assert.equal(recovered.receipts.at(-1)?.outcome,"UNKNOWN");
    assert.equal(recovered.receipts.at(-1)?.cause,"environment");
    assert.equal(recovered.operation,null);
    await debug.foregroundStop(f.taskId,"native-session");
  } finally { await f.close(); }
});

test("a budget stop before the first receipt can create a valid checkpoint",async()=>{
  const f=await fixture();
  try {
    const debug=f.tasks.debugService();
    await f.store.mutate(state=>{
      const record=state.tasks.find(item=>item.task.id===f.taskId)!;
      record.debug!.consumedMs=record.debug!.budgetMs;
      record.debug!.foreground=null;
    });
    const checkpoint=await debug.checkpoint(f.taskId,"native-session");
    assert.equal(checkpoint.checkpoint?.cause,"budget");
    assert.equal(checkpoint.checkpoint?.receiptId,"intake:"+f.taskId);
    assert.equal(await debug.validCheckpoint(f.taskId,"native-session",checkpoint.checkpoint!.sourceFingerprint),true);
  } finally { await f.close(); }
});
