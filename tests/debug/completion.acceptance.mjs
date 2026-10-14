import assert from 'node:assert/strict';
import {fixture,mod} from './acceptance-helper.mjs';

const {fixtureReviewResult}=await mod('tests/review/attestation-fixture.js');
const {saveReviewReportArtifact,saveReviewAttestation,invalidateReviewAttestation,reviewReportDigest}=await mod('runtime/src/review/attestation.js');
const {acceptanceCoverage,coverageDigest}=await mod('runtime/src/verify/acceptance-coverage.js');
const {FileEvidenceStore}=await mod('runtime/src/verify/evidence.js');
const {taskContractHash,goalHash}=await mod('runtime/src/task/contract.js');
const {debugProofDigest}=await mod('runtime/src/task/debug-state.js');
const hypothesis={id:'cause',statement:'Original value is zero',method:'Execute original issue assertion',expected:'Baseline assertion fails',checkId:'issue',expectedStatus:'FAIL'};

async function reviewed(f,report) {
 const stored=await f.tasks.status({taskId:f.record.task.id}), id=stored.task.id;
 const fingerprint=report.sourceFingerprint;
 const coverage=await acceptanceCoverage(stored,f.config,fingerprint,new FileEvidenceStore(f.root,f.root));
 assert.ok(coverage.every(c=>c.status==='proven'));
 const binding={taskContractHash:taskContractHash(stored.task),taskContracts:{[id]:taskContractHash(stored.task)},
  goalHash:goalHash(stored.task),candidateCommit:f.git('rev-parse','HEAD').toString().trim(),coverageDigest:coverageDigest(coverage),
  debugProofs:{[id]:debugProofDigest((await f.tasks.debugService().root(id)).debug)}};
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

const f=await fixture();
try {
 const id=f.record.task.id,d=f.tasks.debugService();
 await f.candidate();let report=await f.verify();assert.equal(report.status,'PASS');
 let reference=report.acceptance.find(r=>r.criterionId==='issue' && r.phase==='baseline').reference;
 await d.hypothesis(id,{...hypothesis,reference});
 let stored=await reviewed(f,report);
 await invalidateReviewAttestation(f.root,report.sourceFingerprint,id);
 await d.review(id,async()=>({status:'FAIL'}));
 await assert.rejects(f.tasks.complete(id,stored.evidence),e=>e.code==='TASK_COMPLETION_TASK_DEBUG_PROOF_REQUIRED');
 assert.equal((await f.tasks.status({taskId:id})).status,'active');
 await f.candidate(2);assert.equal((await f.verify()).status,'FAIL');
 await assert.rejects(f.tasks.complete(id,(await f.tasks.status({taskId:id})).evidence));
 await f.candidate();
 f.config.verification.acceptanceRunners[0].build=[{command:process.execPath,args:['-e','process.exit(2)']}];
 assert.equal((await f.verify()).status,'UNKNOWN');
 await assert.rejects(f.tasks.complete(id,(await f.tasks.status({taskId:id})).evidence));
 assert.equal((await f.tasks.status({taskId:id})).status,'active');
 delete f.config.verification.acceptanceRunners[0].build;
 report=await f.verify();assert.equal(report.status,'PASS');
 reference=report.acceptance.find(r=>r.criterionId==='issue' && r.phase==='baseline').reference;
 await d.hypothesis(id,{...hypothesis,reference});
 stored=await reviewed(f,report);
 // Editing the debug proof after review voids that review, even with unchanged source.
 await d.hypothesis(id,{...hypothesis,id:'late-cause',statement:'Original value is undefined'});
 await assert.rejects(f.tasks.complete(id,stored.evidence),e=>e.code==='TASK_COMPLETION_TASK_DEBUG_PROOF_REQUIRED');
 assert.equal((await f.tasks.status({taskId:id})).status,'active');
 stored=await reviewed(f,report);
 // Escape Loop: a DEBUG fix cannot complete until it declares where the bug came from.
 await assert.rejects(f.tasks.complete(id,stored.evidence),e=>e.code==='TASK_COMPLETION_ESCAPE_ORIGIN_MISSING');
 await d.origin(id,{kind:'pre-existing',reason:'The zero default predates every gated change in this fixture.'});
 report=await f.verify();assert.equal(report.status,'PASS');
 reference=report.acceptance.find(r=>r.criterionId==='issue' && r.phase==='baseline').reference;
 await d.hypothesis(id,{...hypothesis,reference});
 stored=await reviewed(f,report);
 assert.equal((await f.tasks.complete(id,stored.evidence)).status,'complete');
 console.log('Actual regression, review bindings, retry, UNKNOWN rejection and debug completion passed.');
} finally {await f.close();}
