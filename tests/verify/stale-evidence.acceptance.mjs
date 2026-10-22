import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,mod} from '../debug/acceptance-helper.mjs';

const {taskContractHash,evidenceMatchesContract}=await mod('runtime/src/task/contract.js');
const {checkTaskVerificationEvidence}=await mod('runtime/src/task/completion.js');
const {FileEvidenceStore}=await mod('runtime/src/verify/evidence.js');
const {calculateSourceFingerprint}=await mod('runtime/src/verify/source-fingerprint.js');
const {resolveReviewScope}=await mod('runtime/src/review/scope.js');
const {VerificationService}=await mod('runtime/src/verify/service.js');
const {NodeVerificationProcessRunner}=await mod('runtime/src/verify/spawn.js');

const usable=async(f,id)=>{
 const sourceFingerprint=await calculateSourceFingerprint(f.root,await resolveReviewScope({root:f.root,runner:f.gitRunner,base:f.baseline}),f.gitRunner);
 return await checkTaskVerificationEvidence(await f.tasks.status({taskId:id}),{root:f.root,config:f.config,sourceFingerprint,evidenceStore:new FileEvidenceStore(f.root,f.root)});
};
const verifyTask=(f,id)=>new VerificationService({root:f.root,scope:'project',config:f.config,gitRunner:f.gitRunner,processRunner:new NodeVerificationProcessRunner(),
 taskService:f.tasks,evidenceStore:new FileEvidenceStore(f.root,f.root),trusted:true,base:f.baseline}).verify(id);

// A surface/origin revise keeps verification but still needs review; a criteria revise voids it.
{
 const f=await fixture(false);
 try {
  const id=f.record.task.id;
  await f.candidate();assert.equal((await f.verify()).status,'PASS');
  assert.equal(await usable(f,id),null,'fresh evidence counts');
  let current=await f.tasks.status({taskId:id});
  await f.tasks.revise(id,{expectedContractHash:taskContractHash(current.task),origin:{kind:'pre-existing',reason:'The zero default predates this fixture.'},reason:'Declare origin'});
  current=await f.tasks.status({taskId:id});
  assert.ok(Object.keys(current.evidence).length>0,'origin-only revise keeps evidence');
  assert.equal(await usable(f,id),null,'and it still counts for completion');
  await assert.rejects(f.tasks.complete(id,current.evidence),e=>e.code==='TASK_COMPLETION_REVIEW_REQUIRED','a new contract still needs review');
  assert.equal(evidenceMatchesContract(taskContractHash(current.task),current.task),true,'pre-0.11 evidence bound the full hash');
  assert.equal(evidenceMatchesContract('0'.repeat(64),current.task),false);
  const criteria=current.task.criteria.map(c=>c.id==='related'?{...c,description:'Related invariant, reworded'}:c);
  await f.tasks.revise(id,{expectedContractHash:taskContractHash(current.task),criteria,reason:'Reword a criterion'});
  assert.deepEqual((await f.tasks.status({taskId:id})).evidence,{},'a criteria revise voids verification');
  assert.notEqual(await usable(f,id),null);
 } finally {await f.close();}
}

// revise --baseline moves every typed baseline (a task opened on the wrong commit); without it baselines stay immutable.
{
 const f=await fixture(false);
 try {
  const id=f.record.task.id;
  await writeFile(join(f.root,'other.txt'),'moved\n');f.git('add','.');f.git('commit','-qm','new base');
  const moved=f.git('rev-parse','HEAD').toString().trim();
  let current=await f.tasks.status({taskId:id});
  const changed=current.task.criteria.map(c=>({...c,acceptance:{...c.acceptance,baselineCommit:moved}}));
  await assert.rejects(f.tasks.revise(id,{expectedContractHash:taskContractHash(current.task),criteria:changed,reason:'Sneak a new baseline'}),e=>e.code==='BASELINE_IMMUTABLE');
  await assert.rejects(f.tasks.revise(id,{expectedContractHash:taskContractHash(current.task),baseline:'0'.repeat(40),reason:'Unknown commit'}),e=>e.code==='TASK_BASELINE_INVALID');
  const revised=await f.tasks.revise(id,{expectedContractHash:taskContractHash(current.task),baseline:'HEAD',reason:'Opened on the wrong commit'});
  assert.ok(revised.task.criteria.every(c=>c.acceptance.baselineCommit===moved),'every typed criterion moved');
  assert.equal(revised.createdSourceCommit,moved);
  assert.deepEqual(revised.evidence,{});
 } finally {await f.close();}
}

// A binding may list only its red check: extra runner checks are ignored, but an unlisted failure still blocks the candidate.
{
 const f=await fixture(false);
 try {
  const materials=[{path:'tests/check.mjs',role:'test'}];
  const task=await f.tasks.create({title:'Red only',goal:'Value should equal one',policyConfigHash:f.input.policyConfigHash,criteria:[
   {id:'issue',description:'Original issue',verifierIds:[],acceptance:{mode:'behavioral',baselineCommit:f.baseline,bindings:[{runnerId:'regression',materials,checkIds:['issue'],redCheckIds:['issue']}]}},
   {id:'judgment',description:'Reads right',verifierIds:[],acceptance:{mode:'review-only',baselineCommit:f.baseline,bindings:[],reviewOnlyReason:'Needs judgment'}}]});
  await f.candidate();
  const passed=await verifyTask(f,task.task.id);
  assert.equal(passed.status,'PASS',JSON.stringify(passed.acceptance));
  const path=join(f.root,'tests/check.mjs');
  const source=await readFile(path,'utf8');
  await writeFile(path,source.replace("['related',()=>assert.equal(typeof value,'number')]","['related',()=>assert.equal(typeof value,'number')],['extra',()=>assert.fail('unlisted')]"));
  f.git('add','.');f.git('commit','-qm','unlisted failing check');
  const blocked=await verifyTask(f,task.task.id);
  assert.notEqual(blocked.status,'PASS','an unlisted failing check keeps the candidate red or unknown');
 } finally {await f.close();}
}
console.log('stale evidence passed: metadata revise keeps verify, baseline moves on request, red-only bindings.');
