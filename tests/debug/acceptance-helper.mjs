import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const build=resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
export const mod=path=>import(pathToFileURL(join(build,path)).href);
const {TaskService}=await mod('runtime/src/task/service.js');
const {FileTaskStore}=await mod('runtime/src/task/store.js');
const {calculateConfigHash}=await mod('runtime/src/config/hash.js');
export async function fixture(debug=true) {
  const root=await mkdtemp(join(tmpdir(),'agent-ops-debug-'));
  const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:['ignore','pipe','pipe']});
  git('init','-q');git('config','user.name','Debug fixture');git('config','user.email','fixture@example.invalid');
  await writeFile(join(root,'.gitignore'),'.agent-ops/\n');
  await writeFile(join(root,'product.mjs'),'export const value=0;\n');git('add','.');git('commit','-qm','baseline');
  const baseline=git('rev-parse','HEAD').toString().trim();
  const gitRunner={run:async args=>{try{return {exitCode:0,stdout:git(...args)}}catch{return {exitCode:1,stdout:Buffer.alloc(0)}}}};
  const config={schemaVersion:3,profiles:['core'],verification:{commands:[],acceptanceRunners:[{id:'regression',command:process.execPath,args:['tests/check.mjs'],cwd:'.',adapter:'generic'}]},features:{completionGate:{enabled:false},stopVerification:{enabled:false}},pathMappings:[],securityExceptions:[]};
  const store=new FileTaskStore(join(root,'.agent-ops/tasks/state.json'),root);
  const tasks=new TaskService(store,{completion:{root,gitRunner,base:baseline,loadConfig:async()=>config}});
  const materials=[{path:'tests/check.mjs',role:'test'}];
  const input={title:'Fix original error',goal:'Original value should equal one',sessionId:'native-session',policyConfigHash:calculateConfigHash(config),criteria:[{id:'issue',description:'Original issue reproduction',verifierIds:[],acceptance:{mode:'behavioral',baselineCommit:baseline,bindings:[{runnerId:'regression',materials,checkIds:['issue'],redCheckIds:['issue']}]}},{id:'related',description:'Related invariant',verifierIds:[],acceptance:{mode:'invariant',baselineCommit:baseline,bindings:[{runnerId:'regression',materials,checkIds:['related']}]}}],...(debug?{debug:{facts:['Reported value error'],unknowns:['Root cause']}}:{})};
  const record=await tasks.create(input);
  async function candidate(value=1) {
    await mkdir(join(root,'tests'),{recursive:true});
    await writeFile(join(root,'tests/check.mjs'),`import assert from 'node:assert/strict';import {value} from '../product.mjs';const executionId=process.env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID,phase=process.env.AGENT_OPS_ACCEPTANCE_PHASE;const results=[['issue',()=>assert.equal(value,1)],['related',()=>assert.equal(typeof value,'number')]].map(([checkId,check])=>{let status='PASS',failureClass='none';try{check()}catch(e){status='FAIL';failureClass=e.code==='ERR_ASSERTION'?'assertion-failed':'infrastructure-error'}return {executionId,phase,framework:'debug-fixture',frameworkVersion:'1',checkId,status,failureClass,attempts:1,evidence:['Executed assertion']}});console.log(JSON.stringify({protocolVersion:1,executionId,phase,framework:'debug-fixture',frameworkVersion:'1',results,completed:true,completionEvidence:['Completed assertions'],diagnostics:[]}));process.exitCode=results.some(r=>r.status==='FAIL')?1:0;`);
    await writeFile(join(root,'product.mjs'),`export const value=${value};\n`);git('add','.');git('commit','-qm','candidate');
  }
  async function verify(){const {VerificationService}=await mod('runtime/src/verify/service.js');const {FileEvidenceStore}=await mod('runtime/src/verify/evidence.js');const {NodeVerificationProcessRunner}=await mod('runtime/src/verify/spawn.js');return new VerificationService({root,scope:'project',config,gitRunner,processRunner:new NodeVerificationProcessRunner(),taskService:tasks,evidenceStore:new FileEvidenceStore(root,root),trusted:true,base:baseline}).verify(record.task.id);}
  return {root,git,baseline,gitRunner,config,store,tasks,record,input,candidate,verify,close:()=>rm(root,{recursive:true,force:true})};
}
