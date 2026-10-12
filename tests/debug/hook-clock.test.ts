import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { runHookProcess, type HookProcessIo } from "../../packages/cli/src/hook-process.js";
import { debugStopGate } from "../../packages/cli/src/debug-intake.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { debugUserControl, readDebugUserEvent } from "../../runtime/src/task/debug-user-event.js";
import { writeWorktreeRecord } from "../../runtime/src/parallel/service.js";

const SESSION = "native-session";

function io(input: unknown): { readonly io: HookProcessIo; readonly stdout: string[] } {
  const stdout: string[] = [];
  return {
    stdout,
    io: {
      stdin: Readable.from([JSON.stringify(input)]),
      writeStdout: value => stdout.push(value),
      writeStderr: () => undefined
    }
  };
}

async function fixture(options: {readonly gate?: boolean; readonly budgetMs?: number; readonly sessionId?:string; readonly debug?:boolean} = {}): Promise<{
  readonly root: string;
  readonly config: AgentOpsConfig;
  readonly tasks: TaskService;
  readonly taskId: string;
  readonly close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-hook-clock-"));
  const git = (...args: string[]) => execFileSync("git", args, {cwd: root, stdio: ["ignore", "pipe", "pipe"]});
  git("init", "-q");
  git("config", "user.name", "Hook clock fixture");
  git("config", "user.email", "fixture@example.invalid");
  await mkdir(join(root, ".agent-ops"), {recursive: true});
  const config: AgentOpsConfig = {
    schemaVersion: 3,
    profiles: ["core"],
    verification: {commands: [], acceptanceRunners: []},
    features: {
      completionGate: {enabled: options.gate ?? true},
      stopVerification: {enabled: false},
      debug: {enabled: true, budgetMs: options.budgetMs ?? 3_600_000, maxRounds: 5}
    },
    pathMappings: [],
    securityExceptions: []
  };
  await writeFile(join(root, ".agent-ops", "config.json"), JSON.stringify(config));
  await writeFile(join(root, "product.mjs"), "export const value=0;\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
  const baseline = git("rev-parse", "HEAD").toString().trim();
  const gitRunner = {run: async (args: readonly string[]) => {
    try { return {exitCode: 0, stdout: git(...args)}; }
    catch { return {exitCode: 1, stdout: Buffer.alloc(0)}; }
  }};
  const tasks = new TaskService(new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root), {
    completion: {root, gitRunner, loadConfig: async () => config}
  });
  const record = await tasks.create({
    title: "Hook clock fixture",
    goal: "Investigate the original issue",
    criteria: [
      {id: "issue", description: "Issue", verifierIds: [], acceptance: {mode: "review-only", baselineCommit: baseline, bindings: [], reviewOnlyReason: "Fixture"}},
      {id: "related", description: "Related", verifierIds: [], acceptance: {mode: "review-only", baselineCommit: baseline, bindings: [], reviewOnlyReason: "Fixture"}}
    ],
    ...(options.debug === false ? {} : {debug: {facts: ["reported"], unknowns: ["root cause"]}}),
    sessionId: options.sessionId ?? SESSION,
    policyConfigHash: calculateConfigHash(config)
  });
  return {root, config, tasks, taskId: record.task.id, close: async () => await rm(root, {recursive: true, force: true})};
}

test("without the completion gate an active DEBUG Stop is blocked until a valid stop checkpoint", async () => {
  const f = await fixture({gate: false, budgetMs: 50});
  try {
    const debug = f.tasks.debugService();
    const run = async (session: string) => {
      const streams = io({hook_event_name: "Stop", session_id: session, cwd: f.root, stop_hook_active: false});
      await runHookProcess(["claude", "Stop"], streams.io, "0.8.1", {
        root: f.root,
        loadConfig: async () => f.config,
        trust: async () => "TRUSTED"
      });
      return streams.stdout.join("");
    };
    const blocked = (stdout: string) => stdout.length > 0 && JSON.parse(stdout).decision === "block";

    const first = await run(SESSION);
    assert.ok(blocked(first), first);
    assert.match(first, /TASK_DEBUG_ACTIVE|checkpoint/u);
    assert.equal(blocked(await run("unrelated-session")), false);

    await debug.foregroundStart(f.taskId, SESSION);
    await new Promise(resolve => setTimeout(resolve, 80));
    await debug.foregroundStop(f.taskId, SESSION);
    await debug.checkpoint(f.taskId, SESSION);
    assert.equal((await debug.root(f.taskId)).debug.checkpoint?.cause, "budget");
    assert.equal(blocked(await run(SESSION)), false);
    assert.equal((await f.tasks.status({taskId: f.taskId})).status, "active");
  } finally {
    await f.close();
  }
});

test("Codex refuses repeated DEBUG Stop and arbitrary checkpoints; unrelated tasks pass", async () => {
  const f=await fixture({gate:false});
  try {
    const debug=f.tasks.debugService();
    await debug.foregroundStart(f.taskId,SESSION);
    await debug.checkpoint(f.taskId,SESSION);
    for (const repeated of [false,true,true]) {
      const streams=io({hook_event_name:"Stop",session_id:SESSION,cwd:f.root,stop_hook_active:repeated});
      await runHookProcess(["codex","Stop"],streams.io,"0.8.2",{root:f.root,loadConfig:async()=>f.config,trust:async()=>"TRUSTED"});
      const output=JSON.parse(streams.stdout.join(""));
      assert.equal(output.decision,"block");
      assert.equal(output.continue,undefined);
      assert.match(output.reason,/Failure to reproduce/u);
      assert.equal((await debug.root(f.taskId)).debug.foreground?.sessionId,SESSION);
    }
    const other=io({hook_event_name:"Stop",session_id:"unattached",cwd:f.root,stop_hook_active:true});
    await runHookProcess(["codex","Stop"],other.io,"0.8.2",{root:f.root,loadConfig:async()=>f.config,trust:async()=>"TRUSTED"});
    assert.notEqual(other.stdout.length ? JSON.parse(other.stdout.join("")).decision : undefined,"block");
  } finally {await f.close();}
  const normal=await fixture({debug:false});
  try {
    const streams=io({hook_event_name:"Stop",session_id:SESSION,cwd:normal.root,stop_hook_active:true});
    await runHookProcess(["codex","Stop"],streams.io,"0.8.2",{root:normal.root,loadConfig:async()=>normal.config,trust:async()=>"TRUSTED"});
    assert.notEqual(streams.stdout.length ? JSON.parse(streams.stdout.join("")).decision : undefined,"block");
  } finally {await normal.close();}
});

test("Codex Interrupt seals a human pause and preserves the original task and budget", async () => {
  const f=await fixture({gate:false});
  try {
    const debug=f.tasks.debugService();
    await debug.foregroundStart(f.taskId,SESSION);
    const streams=io({hook_event_name:"Interrupt",session_id:SESSION,cwd:f.root});
    await runHookProcess(["codex","Interrupt"],streams.io,"0.8.2",{root:f.root});
    assert.deepEqual(streams.stdout,[]);
    const before=(await debug.root(f.taskId)).debug;
    assert.equal(before.control?.paused,true);
    assert.equal(before.foreground,null);
    assert.equal(before.checkpoint?.cause,"user-pause");
    await new Promise(resolve=>setTimeout(resolve,25));
    const stop=io({hook_event_name:"Stop",session_id:SESSION,cwd:f.root,stop_hook_active:true});
    await runHookProcess(["codex","Stop"],stop.io,"0.8.2",{root:f.root,loadConfig:async()=>f.config,trust:async()=>"TRUSTED"});
    assert.notEqual(JSON.parse(stop.stdout.join("")).decision,"block");
    const after=await debug.root(f.taskId);
    assert.equal(after.status,"active");
    assert.equal(after.task.id,f.taskId);
    assert.equal(after.debug.consumedMs,before.consumedMs);
    assert.equal(after.debug.budgetMs,before.budgetMs);
    assert.deepEqual(after.debug.receipts,before.receipts);
    assert.ok(await debug.validCheckpoint(f.taskId,SESSION,after.debug.checkpoint!.sourceFingerprint));
    await assert.rejects(debug.foregroundStart(f.taskId,SESSION),(e:unknown)=>e instanceof AgentOpsError && e.code === "TASK_DEBUG_STOP_REQUIRED");
  } finally {await f.close();}
});

test("DEBUG gate reloads once on a fault and reports non-success without rewriting state", async t => {
  const f=await fixture({gate:false});
  try {
    const path=join(f.root,".agent-ops/tasks/state.json"),before=await readFile(path,"utf8");
    let reads=0;
    t.mock.method(FileTaskStore.prototype,"read",async()=>{reads++;throw new AgentOpsError("TASK_STORE_INVALID","unreadable");});
    const result=await debugStopGate(f.root,f.config).handle({event:"stop",projectRoot:f.root,sessionId:SESSION,terminationReason:"model_stop",fullyIdle:true});
    assert.equal(reads,2);
    assert.equal(result?.code,"TASK_DEBUG_GATE_UNAVAILABLE");
    assert.equal(result?.action,"continue");
    assert.equal(result?.status,"UNKNOWN");
    assert.match(result?.remedy ?? "",/one targeted reload.*doctor/u);
    assert.equal(await readFile(path,"utf8"),before);
  } finally {t.mock.restoreAll();await f.close();}
});

test("Codex invalid config has one reload, explicit UNKNOWN and a closed foreground clock", async () => {
  const f=await fixture({gate:false});
  try {
    const debug=f.tasks.debugService();
    await debug.foregroundStart(f.taskId,SESSION);
    let loads=0;
    const streams=io({hook_event_name:"Stop",session_id:SESSION,cwd:f.root});
    await runHookProcess(["codex","Stop"],streams.io,"0.8.2",{root:f.root,loadConfig:async()=>{loads++;throw new Error("invalid config");}});
    assert.equal(loads,2);
    const output=JSON.parse(streams.stdout.join(""));
    assert.equal(output.decision,undefined);
    assert.match(output.systemMessage,/TASK_DEBUG_GATE_UNAVAILABLE.*incomplete.*one targeted reload/u);
    assert.equal((await debug.root(f.taskId)).debug.foreground,null);
    assert.equal((await f.tasks.status({taskId:f.taskId})).status,"active");
  } finally {await f.close();}
});

test("native human controls distinguish diagnosis, pause and repair; synthetic text has no authority", async () => {
  const session="12345678-1234-1234-1234-123456789abc";
  const f=await fixture({gate:false,sessionId:session}),home=await mkdtemp(join(tmpdir(),"agent-ops-native-control-"));
  try {
    const directory=join(home,".codex/sessions/2026/10/11");
    await mkdir(directory,{recursive:true});
    const path=join(directory,"rollout-"+session+".jsonl");
    const rows:unknown[]=[{type:"session_meta",payload:{id:session,cwd:f.root}}];
    let timestamp=Date.now();
    const append=async (text:string,kind="user.text",role="user")=>{
      timestamp=Math.max(Date.now(),timestamp+1);
      rows.push({type:"response_item",timestamp:new Date(timestamp).toISOString(),payload:{type:"message",role,
        internal_chat_message_metadata_passthrough:{content_item_kinds:[kind]},content:[{type:"input_text",text}]}});
      await writeFile(path,rows.map(row=>JSON.stringify(row)).join("\n")+"\n");
    };
    const debug=f.tasks.debugService();
    await append("<send_user_message_question_reply>"+JSON.stringify([{question:"scope",answer:"先只診斷，等我補失敗時證據"}])+"</send_user_message_question_reply>");
    assert.equal((await readDebugUserEvent(f.root,session,home)).text,"先只診斷，等我補失敗時證據");
    // A native session may begin in the owned worktree, rather than main.
    await writeWorktreeRecord({schemaVersion:1,name:"debug-control",branch:"agent-ops/debug-control",path:f.root,mainRoot:join(home,"main"),targetBranch:"main",base:"a".repeat(40),sessionId:session,createdAt:new Date().toISOString()});
    await debug.syncNativeControl(f.taskId,session,home);
    assert.equal((await debug.root(f.taskId)).debug.control?.mode,"diagnose");
    assert.equal(await debug.diagnosisProven(f.taskId),false);
    await append("繼續修復","agents_md.instructions");
    await append("繼續修復","user.text","assistant");
    await debug.syncNativeControl(f.taskId,session,home);
    assert.equal((await debug.root(f.taskId)).debug.control?.mode,"diagnose");
    await debug.foregroundStart(f.taskId,session);
    await append("暫停");
    await debug.syncNativeControl(f.taskId,session,home);
    const paused=await debug.root(f.taskId);
    assert.equal(paused.debug.control?.paused,true);
    assert.equal(paused.debug.control?.mode,"diagnose");
    assert.equal(paused.debug.checkpoint?.cause,"user-pause");
    await new Promise(resolve=>setTimeout(resolve,25));
    await debug.syncNativeControl(f.taskId,session,home);
    assert.equal((await debug.root(f.taskId)).debug.consumedMs,paused.debug.consumedMs);
    await append("繼續");
    await debug.syncNativeControl(f.taskId,session,home);
    const resumed=await debug.root(f.taskId);
    assert.equal(resumed.debug.control?.paused,false);
    assert.equal(resumed.debug.control?.mode,"diagnose");
    assert.equal(resumed.debug.consumedMs,paused.debug.consumedMs);
    assert.equal(resumed.debug.budgetMs,paused.debug.budgetMs);
    assert.deepEqual(resumed.debug.receipts,paused.debug.receipts);
    assert.deepEqual(resumed.evidence,paused.evidence);
    await append("繼續修復");
    await debug.syncNativeControl(f.taskId,session,home);
    assert.equal((await debug.root(f.taskId)).debug.control?.mode,"full");
    assert.equal((await debug.root(f.taskId)).task.id,f.taskId);
    for (const text of ['「暫停」是什麼意思？','Do not pause','{"answer":"pause"}','還沒重現']) assert.equal(debugUserControl(text),null);
    await writeFile(path,JSON.stringify({type:"session_meta",payload:{id:session,cwd:f.root}})+"\n"+
      JSON.stringify({type:"event_msg",timestamp:new Date().toISOString(),payload:{type:"user_message",message:"繼續"}})+"\n");
    assert.equal((await readDebugUserEvent(f.root,session,home)).text,"繼續");
    await writeFile(path,JSON.stringify({type:"session_meta",payload:{id:session,cwd:"/different"}})+"\n");
    await assert.rejects(readDebugUserEvent(f.root,session,home));
  } finally {await f.close();await rm(home,{recursive:true,force:true});}
});

test("a blocked or errored Stop keeps foreground timing active until an accepted idle Stop", async () => {
  const f = await fixture();
  try {
    const debug = f.tasks.debugService();
    await debug.foregroundStart(f.taskId, SESSION);
    let allow = false;
    const stop = () => ({hook_event_name: "Stop", session_id: SESSION, cwd: f.root, stop_hook_active: false});
    const run = async (input: unknown) => {
      const streams = io(input);
      await runHookProcess(["claude", "Stop", "--completion-gate"], streams.io, "0.8.1", {
        root: f.root,
        loadConfig: async () => f.config,
        trust: async () => "TRUSTED",
        completionGate: {
          handle: async () => allow
            ? {action: "continue", status: "PASS", code: "COMPLETION_GATE_ALLOWED"}
            : {action: "block", status: "FAIL", code: "COMPLETION_GATE_TASK_DEBUG_ACTIVE"}
        }
      });
      return streams.stdout;
    };

    await run(stop());
    assert.equal((await debug.root(f.taskId)).debug.foreground?.sessionId, SESSION);
    allow = true;
    await run(stop());
    assert.equal((await debug.root(f.taskId)).debug.foreground, null);

    await debug.foregroundStart(f.taskId, SESSION);
    await run({...stop(), stop_hook_active: true});
    assert.equal((await debug.root(f.taskId)).debug.foreground?.sessionId, SESSION);
    await run(stop());
    assert.equal((await debug.root(f.taskId)).debug.foreground, null);

    await debug.foregroundStart(f.taskId, SESSION);
    const errorStreams = io(stop());
    await runHookProcess(["claude", "Stop", "--completion-gate"], errorStreams.io, "0.8.1", {
      root: f.root,
      loadConfig: async () => f.config,
      trust: async () => "TRUSTED",
      completionGate: {handle: async () => { throw new Error("gate unavailable"); }}
    });
    assert.equal((await debug.root(f.taskId)).debug.foreground?.sessionId, SESSION);

    await debug.foregroundStop(f.taskId, SESSION);
    await debug.foregroundStart(f.taskId, SESSION);
    const codexStreams = io({hook_event_name: "Stop", session_id: SESSION, cwd: f.root, stop_hook_active: false});
    await runHookProcess(["codex", "Stop"], codexStreams.io, "0.8.1", {
      root: f.root,
      loadConfig: async () => f.config,
      trust: async () => "TRUSTED"
    });
    assert.equal(JSON.parse(codexStreams.stdout.join("")).decision,"block");
    assert.equal((await debug.root(f.taskId)).debug.foreground?.sessionId,SESSION);
    await debug.foregroundStop(f.taskId,SESSION);

    await debug.foregroundStart(f.taskId, SESSION);
    const agyStart = io({invocationNum: 1, conversationId: SESSION, workspacePaths: [f.root]});
    await runHookProcess(["agy", "SessionStart"], agyStart.io, "0.8.1", {
      root: f.root,
      loadConfig: async () => f.config,
      trust: async () => "TRUSTED"
    });
    assert.equal((await debug.root(f.taskId)).debug.foreground?.sessionId, SESSION);
    const agyStop = io({terminationReason: "model_stop", fullyIdle: true, conversationId: SESSION, workspacePaths: [f.root]});
    await runHookProcess(["agy", "Stop", "--completion-gate"], agyStop.io, "0.8.1", {
      root: f.root,
      loadConfig: async () => f.config,
      trust: async () => "TRUSTED",
      completionGate: {handle: async () => ({action: "continue", status: "PASS", code: "COMPLETION_GATE_ALLOWED"})}
    });
    assert.equal((await debug.root(f.taskId)).debug.foreground, null);
  } finally {
    await f.close();
  }
});
