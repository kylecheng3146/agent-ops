import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {createDebugState, DEBUG_DEFAULTS, DEBUG_EXTENSION_MS, debugRemainingMs, validDebugState} from '../../runtime/src/task/debug-state.js';
const exec=promisify(execFile);
test('sixty-minute defaults retain explicit budgets and twenty-minute grants',()=>{
 const current=createDebugState('root','a'.repeat(40));
 assert.deepEqual(DEBUG_DEFAULTS,{enabled:true,budgetMs:3600000,maxRounds:5});
 assert.equal(debugRemainingMs(current),3600000);
 const legacy=createDebugState('root','a'.repeat(40),{budgetMs:1200000,maxRounds:3});
 legacy.consumedMs=1200000;
 legacy.grants.push({eventId:'human-continue',sessionId:'session',sourceDigest:'b'.repeat(64),grantedMs:1200000});
 assert.equal(DEBUG_EXTENSION_MS,1200000);
 assert.equal(validDebugState(legacy),true);
 assert.equal(legacy.budgetMs,1200000);
 assert.equal(legacy.maxRounds,3);
 assert.equal(debugRemainingMs(legacy),1200000);
 legacy.grants[0]!.grantedMs=3600000;
 assert.equal(validDebugState(legacy),false);
});
for(const suite of ['state','proof','host','install','compatibility']) test(`debug ${suite} executes behavior in real Git/process fixtures`,async()=>{
 const result=await exec(process.execPath,[`tests/debug/${suite}.acceptance.mjs`],{cwd:process.cwd(),env:{...process.env,AGENT_OPS_DEBUG_TEST_BUILD:resolve('.tmp/test-dist')},timeout:240000,maxBuffer:1024*1024});
 const report=JSON.parse(result.stdout.trim());assert.ok(report.completed);assert.ok(report.results.every((r:{status:string})=>r.status==='PASS'),result.stdout);
});
