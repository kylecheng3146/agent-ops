import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
const exec=promisify(execFile);
for(const suite of ['state','proof','host','install','compatibility']) test(`debug ${suite} executes behavior in real Git/process fixtures`,async()=>{
 const result=await exec(process.execPath,[`tests/debug/${suite}.acceptance.mjs`],{cwd:process.cwd(),env:{...process.env,AGENT_OPS_DEBUG_TEST_BUILD:resolve('.tmp/test-dist')},timeout:120000,maxBuffer:1024*1024});
 const report=JSON.parse(result.stdout.trim());assert.ok(report.completed);assert.ok(report.results.every((r:{status:string})=>r.status==='PASS'),result.stdout);
});
