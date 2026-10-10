import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {resolve} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

test('debug completion requires current regression and review proof after failure recovery',async()=>{
 const result=await promisify(execFile)(process.execPath,['tests/debug/completion.acceptance.mjs'],{
  cwd:process.cwd(),env:{...process.env,AGENT_OPS_DEBUG_TEST_BUILD:resolve('.tmp/test-dist')},timeout:120000,maxBuffer:1024*1024
 });
 assert.match(result.stdout,/debug completion passed/);
});
