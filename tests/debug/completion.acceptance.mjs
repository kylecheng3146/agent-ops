import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,mod} from './acceptance-helper.mjs';

const {fixtureReviewResult}=await mod('tests/review/attestation-fixture.js');
const {saveReviewReportArtifact,saveReviewAttestation,reviewReportDigest}=await mod('runtime/src/review/attestation.js');
const {acceptanceCoverage,coverageDigest}=await mod('runtime/src/verify/acceptance-coverage.js');
const {FileEvidenceStore}=await mod('runtime/src/verify/evidence.js');
const {taskContractHash,goalHash}=await mod('runtime/src/task/contract.js');

async function reviewed(f,report,legacy={}) {
 const stored=await f.tasks.status({taskId:f.record.task.id}), id=stored.task.id;
 const fingerprint=report.sourceFingerprint;
 const coverage=await acceptanceCoverage(stored,f.config,fingerprint,new FileEvidenceStore(f.root,f.root));
 assert.ok(coverage.every(c=>c.status==='proven'));
 const binding={taskContractHash:taskContractHash(stored.task),taskContracts:{[id]:taskContractHash(stored.task)},
  goalHash:goalHash(stored.task),candidateCommit:f.git('rev-parse','HEAD').toString().trim(),coverageDigest:coverageDigest(coverage),...legacy};
 const result=fixtureReviewResult(fingerprint);
 const conclusions=stored.task.criteria.map(c=>({criterionId:c.id,status:'PASS',summary:'Regression and related check inspected',evidence:['Actual paired acceptance references']}));
 result.report.results=conclusions;result.adversarial.report.results=conclusions;
 const artifact=await saveReviewReportArtifact(f.root,result,fingerprint,id,undefined,binding,coverage);
 await saveReviewAttestation(f.root,{schemaVersion:3,taskId:id,harness:result.harness,status:'PASS',sourceFingerprint:fingerprint,
  reviewTargets:result.plannedTargets,reviewSessionIds:result.attempts.map(a=>a.sessionId),sessionIsolation:'fresh',
  primaryReportDigest:reviewReportDigest(result.report),adversarialReportDigest:reviewReportDigest(result.adversarial.report),
  reportArtifact:artifact,createdAt:new Date().toISOString(),...binding});
 return stored;
}

// A DEBUG task is an ordinary task: red-to-green proof and review complete it, with no hypothesis or origin.
{
 const f=await fixture();
 try {
  const id=f.record.task.id;
  assert.equal(f.record.task.originRequired,undefined,'a new DEBUG task does not require an origin');
  await f.candidate(2);assert.equal((await f.verify()).status,'FAIL','a candidate that keeps the regression red cannot pass');
  await f.candidate();const report=await f.verify();assert.equal(report.status,'PASS',JSON.stringify(report));
  const stored=await reviewed(f,report);
  assert.equal((await f.tasks.complete(id,stored.evidence)).status,'complete');
 } finally {await f.close();}
}

// Pre-0.11 state (budget, hypotheses, checkpoint, originRequired, debugProofs) loads, is ignored, and completes.
{
 const f=await fixture();
 try {
  const id=f.record.task.id, path=join(f.root,'.agent-ops/tasks/state.json');
  const state=JSON.parse(await readFile(path,'utf8'));
  state.tasks[0].task.originRequired=true;
  state.tasks[0].debug={rootTaskId:id,budgetMs:3600000,maxRounds:5,consumedMs:3600000,hypotheses:[{id:'cause',status:'proposed'}],
   receipts:[],grants:[],checkpoint:{cause:'budget'},control:{paused:true,mode:'diagnose'}};
  await writeFile(path,JSON.stringify(state));
  const loaded=await f.tasks.status({taskId:id});
  assert.equal(loaded.debug,undefined,'legacy budget state is dropped on load');
  assert.equal(loaded.task.originRequired,true);
  await f.candidate();const report=await f.verify();assert.equal(report.status,'PASS',JSON.stringify(report));
  const stored=await reviewed(f,report,{debugProofs:{[id]:'a'.repeat(64)}});
  assert.equal((await f.tasks.complete(id,stored.evidence)).status,'complete');
 } finally {await f.close();}
}

// The origin stays declarable on a DEBUG task, through the same revise path as any task.
{
 const f=await fixture();
 try {
  const id=f.record.task.id;
  const revised=await f.tasks.revise(id,{expectedContractHash:taskContractHash(f.record.task),
   origin:{kind:'pre-existing',reason:'The zero default predates every gated change in this fixture.'},reason:'Declare origin'});
  assert.equal(revised.task.origin.kind,'pre-existing');
 } finally {await f.close();}
}
console.log('debug completion passed: red-to-green plus review completes; legacy state ignored; origin advisory.');
