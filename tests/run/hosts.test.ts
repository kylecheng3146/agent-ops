import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {nativeProcessIdentity} from "../../runtime/src/run/transport.js";
import {stopNativeProcess} from "../../runtime/src/run/hosts/util.js";
import type {ChildProcessWithoutNullStreams} from "node:child_process";

import { ClaudeGoalHost } from "../../runtime/src/run/hosts/claude.js";
import { CodexGoalHost } from "../../runtime/src/run/hosts/codex.js";
import type { NativeGoalRequestContext, NativeGoalStartInput } from "../../runtime/src/run/hosts/types.js";

const contractHash = "a".repeat(64);
const context: NativeGoalRequestContext = {
  runId: "run-1",
  workerId: "worker-1",
  generation: 1,
  contractHash
};

function childArgs(script: string): readonly string[] {
  return ["-e", script];
}

function startInput(): NativeGoalStartInput {
  return { ...context, cwd: process.cwd(), sessionId: "session-1" };
}

test("Codex host performs app-server JSON-RPC correlation and stale-writer fencing", async () => {
  const script = [
    "const readline=require('node:readline');",
    "const rl=readline.createInterface({input:process.stdin});",
    "let n=0;",
    "rl.on('line',line=>{const m=JSON.parse(line);",
    "if(m.id!==undefined){let result={};",
    "if(m.method==='initialize') result={};",
    "else if(m.method==='thread/start') result={thread:{id:'thread-1'}};",
    "else if(m.method==='thread/resume') result={thread:{id:'thread-1'}};",
    "else if(m.method==='thread/goal/set') {result={goal:{status:m.params.status||'active',objective:m.params.objective||'goal'}}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'thread/goal/updated',params:{goal:result.goal,threadId:'thread-1'}})+'\\n');}",
    "else if(m.method==='turn/start') result={turn:{id:'turn-'+(++n)}};",
    "else if(m.method==='turn/interrupt') result={};",
    "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});"
  ].join("\n");
  const host = new CodexGoalHost({ command: process.execPath, args: childArgs(script), requestTimeoutMs: 3_000 });
  const handle = await host.start(startInput());
  assert.equal(handle.threadId, "thread-1");
  const activated = await host.activate(handle, "finish with evidence", context);
  assert.equal(activated.accepted, true);
  const events = [];
  for await (const item of host.observe(handle)) {
    events.push(item);
    if (events.length >= 1) break;
  }
  assert.equal(events[0]?.type, "goal-updated");
  await assert.rejects(
    host.update(handle, { ...context, generation: 2, objective: "stale" }),
    { code: "NATIVE_STALE_WRITER" }
  );
  await host.stop(handle, context);
});

test("Claude host uses stream-json input, native /goal, and signal lifecycle", async () => {
  const script = [
    "const readline=require('node:readline');",
    "process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'session-1'})+'\\n');",
    "const rl=readline.createInterface({input:process.stdin});",
    "rl.on('line',line=>{const m=JSON.parse(line); process.stdout.write(JSON.stringify({type:'assistant',message:m})+'\\n'); process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:'session-1',total_cost_usd:0.01})+'\\n');});"
  ].join("\n");
  const host = new ClaudeGoalHost({ command: process.execPath, args: childArgs(script) });
  const handle = await host.start(startInput());
  assert.equal(handle.sessionId, "session-1");
  const activated = await host.activate(handle, "finish with evidence", context, 100);
  assert.equal(activated.accepted, true);
  const observed = [];
  for await (const item of host.observe(handle)) {
    observed.push(item);
    if (item.type === "completed") break;
  }
  assert.equal(observed.some((item) => item.type === "completed"), true);
  await host.stop(handle, context);
});

test("Codex initialization timeout cancels the unopened detached process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-native-timeout-"));
  try {
    const marker = join(root, "native-pids.json");
    const script = "const fs=require('node:fs'),cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);";
    const host = new CodexGoalHost({command: process.execPath, args: ["-e", script, marker], requestTimeoutMs: 1000});
    await assert.rejects(host.start(startInput()), {code: "NATIVE_REQUEST_TIMEOUT"});
    for (const pid of JSON.parse(await readFile(marker, "utf8")) as number[])
      assert.equal(await nativeProcessIdentity(pid), null, "failed startup must not leave an unregistered native process or descendant");
  } finally {await rm(root, {recursive: true, force: true});}
});

test("transient signal EPERM requires confirmed process group disappearance", {skip: process.platform === "win32"}, async t => {
  let probes = 0;
  t.mock.method(process, "kill", (pid: number, signal: NodeJS.Signals | number) => {
    assert.equal(pid, -123);
    if (signal === 0 && ++probes > 1) throw Object.assign(new Error("gone"), {code: "ESRCH"});
    throw Object.assign(new Error("permission"), {code: "EPERM"});
  });
  await stopNativeProcess({pid: 123, exitCode: 0, signalCode: null} as ChildProcessWithoutNullStreams, "SIGKILL");
  assert.ok(probes > 1);
});

test("persistent group permission failure is never confirmed death", {skip: process.platform === "win32"}, async t => {
  t.mock.method(process, "kill", () => {throw Object.assign(new Error("permission"), {code: "EPERM"});});
  await assert.rejects(stopNativeProcess({pid: 123, exitCode: 0, signalCode: null} as ChildProcessWithoutNullStreams, "SIGKILL"), {code: "EPERM"});
});
