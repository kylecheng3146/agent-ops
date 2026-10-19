import assert from 'node:assert/strict';
import {mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,mod} from './acceptance-helper.mjs';
const session='12345678-1234-1234-1234-123456789abc';
const meta=root=>({type:'session_meta',payload:{id:session,cwd:root}});
const user=(text,kind='user.text')=>({type:'response_item',timestamp:new Date().toISOString(),payload:{type:'message',role:'user',internal_chat_message_metadata_passthrough:{content_item_kinds:[kind]},content:[{type:'input_text',text}]}});
async function nativeFile(f,rows){const home=join(f.root,'.agent-ops/native-home');const dir=join(home,'.codex/sessions/2026/10/19');await mkdir(dir,{recursive:true});const path=join(dir,'rollout-'+session+'.jsonl');await writeFile(path,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');return {home,path};}
const raw={
 'native-grant-large-transcript':async()=>{
  const f=await fixture();try{
   const {readDebugUserEvent}=await mod('runtime/src/task/debug-user-event.js');
   const rows=[meta(f.root),user('暫停'),{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'x'.repeat(17*1024*1024)}]}},user('繼續修復')];
   const {home,path}=await nativeFile(f,rows);const event=await readDebugUserEvent(f.root,session,home);assert.equal(event.text,'繼續修復');assert.equal((await readDebugUserEvent(f.root,session,home)).id,event.id);
   rows.push(user('暫停','agents_md.instructions'));await writeFile(path,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');assert.equal((await readDebugUserEvent(f.root,session,home)).id,event.id,'injected metadata cannot replace the native human event');
   const link=path+'.original';await writeFile(link,JSON.stringify(meta(f.root))+'\n'+JSON.stringify(user('繼續'))+'\n');await rm(path);await symlink(link,path);await assert.rejects(readDebugUserEvent(f.root,session,home));
  }finally{await f.close();}
 },
 'native-grant-owned-root':async()=>{
  const f=await fixture();const previous=process.env.CODEX_THREAD_ID;try{
   const {readDebugUserEvent}=await mod('runtime/src/task/debug-user-event.js');const {writeWorktreeRecord}=await mod('runtime/src/parallel/service.js');
   const worktree=join(f.root,'.worktrees/native');f.git('worktree','add','-qb','agent-ops/native',worktree,'HEAD');
   const record={schemaVersion:1,name:'native',branch:'agent-ops/native',path:worktree,mainRoot:f.root,targetBranch:'main',base:f.baseline,sessionId:session,createdAt:new Date().toISOString()};await writeWorktreeRecord(record);
   const {home,path}=await nativeFile(f,[meta(join(f.root,'original-launch-project')),user('繼續修復')]);
   // Isolated test home and task only; this never writes a production transcript or grant.
   process.env.CODEX_THREAD_ID=session;
   assert.equal((await readDebugUserEvent(f.root,session,home,'latest',worktree)).text,'繼續修復');
   process.env.CODEX_THREAD_ID='ffffffff-ffff-ffff-ffff-ffffffffffff';await assert.rejects(readDebugUserEvent(f.root,session,home,'latest',worktree));
   process.env.CODEX_THREAD_ID=session;await writeWorktreeRecord({...record,sessionId:'ffffffff-ffff-ffff-ffff-ffffffffffff'});await assert.rejects(readDebugUserEvent(f.root,session,home,'latest',worktree));
   await writeWorktreeRecord(record);await writeFile(path,JSON.stringify({type:'session_meta',payload:{id:'ffffffff-ffff-ffff-ffff-ffffffffffff',cwd:f.root}})+'\n'+JSON.stringify(user('繼續'))+'\n');await assert.rejects(readDebugUserEvent(f.root,session,home,'latest',worktree));
   await writeFile(path,JSON.stringify(meta(f.root))+'\n'+JSON.stringify(user('繼續','agents_md.instructions'))+'\n');await assert.rejects(readDebugUserEvent(f.root,session,home));
  }finally{if(previous===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=previous;await f.close();}
 },
 'native-grant-renews-window':async()=>{
  const f=await fixture();try{
   const id=f.record.task.id;await f.tasks.attach(session,id);const {home}=await nativeFile(f,[meta(f.root),user('繼續修復')]);
   await f.store.mutate(state=>{const r=state.tasks.find(x=>x.task.id===id);r.debug.consumedMs=12345;r.debug.foreground={sessionId:session,startedAt:Date.now()-12*60*60*1000};});
   const debug=f.tasks.debugService();const before=structuredClone((await debug.root(id)).debug);await debug.extend(id,session,'latest',home);
   const after=(await debug.root(id)).debug;const {debugRemainingMs,validDebugState}=await mod('runtime/src/task/debug-state.js');assert.ok(validDebugState(after));assert.equal(after.grants.length,1);assert.equal(after.budgetMs,before.budgetMs);assert.equal(after.consumedMs,before.consumedMs);assert.deepEqual(after.receipts,before.receipts);assert.ok(after.grants[0].spentAtGrantMs>before.budgetMs,'overrun remains auditable');
   const remaining=debugRemainingMs(after);assert.ok(remaining>20*60000-2000 && remaining<=20*60000,`fresh authorization must grant a complete window, got ${remaining}`);
   await debug.extend(id,session,'latest',home);assert.equal((await debug.root(id)).debug.grants.length,1,'the same native event is never spent twice');
   const legacy={...after,foreground:null,consumedMs:0,grants:after.grants.map(({spentAtGrantMs,...grant})=>grant)};assert.ok(validDebugState(legacy));assert.equal(debugRemainingMs(legacy),legacy.budgetMs+20*60000,'legacy grant records remain readable');
  }finally{await f.close();}
 }
};
export const nativeGrantChecks=Object.fromEntries(Object.entries(raw).map(([id,check])=>[id,async()=>{try{await check();}catch(e){if(e?.code==='ERR_ASSERTION')throw e;throw new assert.AssertionError({message:`${id}: ${e?.code ?? ''} ${e?.message ?? e}`});}}]));
