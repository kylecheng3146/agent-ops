import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

test('hypothesis lifecycle uses actual UNKNOWN evidence and deduplicates confirmed evidence',async()=>{
 const result=await promisify(execFile)(process.execPath,['tests/debug/hypothesis.acceptance.mjs'],{
  cwd:process.cwd(),env:{...process.env,AGENT_OPS_DEBUG_TEST_BUILD:resolve('.tmp/test-dist')},timeout:120000,maxBuffer:1024*1024
 });
 const report=JSON.parse(result.stdout.trim());
 assert.equal(report.completed,true);
 assert.equal(report.results.length,1);
 assert.equal(report.results[0].status,'PASS',result.stdout);
});
