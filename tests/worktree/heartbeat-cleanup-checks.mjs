import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const load = path => import(pathToFileURL(join(build, path)).href);
const uuid = '5c2aac6e-984e-4920-9d1c-6f5ddf66e8d1';
const marker = pid => `.codex/.agent-ops-process-${pid}-${uuid}`;
const body = `runtime:${uuid}\n`;
async function fixture(check) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-cleanup-check-'));
  const worker = join(root, 'worker');
  const git = async (cwd, args) => {
    try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe']}), stderr: ''};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '')};}
  };
  try {
    for (const args of [['init','-q'], ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','base'], ['worktree','add','-qb','worker',worker]]) assert.equal((await git(root,args)).exitCode,0);
    await mkdir(join(worker,'.codex'));
    const record = {mainRoot: root, path: worker, branch: 'worker'};
    const head = (await git(root,['rev-parse','HEAD'])).stdout.trim();
    await check({root,worker,git,record,head});
  } finally {await rm(root,{recursive:true,force:true});}
}
const checks = {
  'dead-heartbeat-final-proof-cleanup': async () => {
    const {removeCheckout} = await load('runtime/src/parallel/service.js');
    const dead = Number(execFileSync(process.execPath,['-p','process.pid'],{encoding:'utf8'}).trim());
    await fixture(async ({worker,git,record,head}) => {
      await writeFile(join(worker,marker(dead)),body);
      await removeCheckout({git},record,false,head);
      await assert.rejects(access(worker),{code:'ENOENT'});
    });
    await fixture(async ({worker,git,record,head}) => {
      await writeFile(join(worker,marker(dead)),body);
      await writeFile(join(worker,'user.txt'),'preserve me');
      await assert.rejects(removeCheckout({git},record,false,head),{code:'WORKTREE_REMOVE_FAILED'});
      assert.equal(await readFile(join(worker,'user.txt'),'utf8'),'preserve me');
    });
    const {withPrivateFileLock} = await load('runtime/src/security/permissions.js');
    await fixture(async ({worker,git,record,head}) => {
      await withPrivateFileLock(join(worker,'.codex','record.json'),worker,async()=>{});
      await removeCheckout({git},record,false,head);
      await assert.rejects(access(worker),{code:'ENOENT'});
    });
  },
  'foreign-heartbeat-preserved': async () => {
    const {cleanupWorktreeHeartbeats} = await load('runtime/src/security/permissions.js');
    assert.equal(typeof cleanupWorktreeHeartbeats,'function','A safe heartbeat cleanup operation must exist');
    const live = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    try {
      await new Promise((resolve,reject)=>{live.once('spawn',resolve);live.once('error',reject);});
      await fixture(async ({worker}) => {
        const path = marker(live.pid); await writeFile(join(worker,path),body);
        await assert.rejects(cleanupWorktreeHeartbeats(worker,[path]),e=>e.code==='WORKTREE_HEARTBEAT_ACTIVE' && e.message.includes(String(live.pid)) && e.message.includes(path));
        assert.equal(await readFile(join(worker,path),'utf8'),body);
      });
      const dead = Number(execFileSync(process.execPath,['-p','process.pid'],{encoding:'utf8'}).trim());
      await fixture(async ({worker}) => {
        const path=marker(dead); await writeFile(join(worker,path),'user data');
        await assert.rejects(cleanupWorktreeHeartbeats(worker,[path]),{code:'WORKTREE_HEARTBEAT_UNSAFE'});
        assert.equal(await readFile(join(worker,path),'utf8'),'user data');
      });
      await fixture(async ({root,worker}) => {
        const path=marker(dead), outside=join(root,'outside.txt'); await writeFile(outside,body); await symlink(outside,join(worker,path));
        await assert.rejects(cleanupWorktreeHeartbeats(worker,[path]),{code:'WORKTREE_HEARTBEAT_UNSAFE'});
        assert.equal(await readFile(outside,'utf8'),body);
      });
      await fixture(async ({worker}) => {
        const path=marker(dead); await writeFile(join(worker,path),body);
        const kill=process.kill;
        process.kill=function(pid,signal){if(pid===dead){const e=new Error('identity unavailable');e.code='EPERM';throw e;}return kill.call(process,pid,signal);};
        try {await assert.rejects(cleanupWorktreeHeartbeats(worker,[path]),{code:'WORKTREE_HEARTBEAT_ACTIVE'});}
        finally {process.kill=kill;}
        assert.equal(await readFile(join(worker,path),'utf8'),body);
      });
    } finally {live.kill(); await new Promise(resolve=>{if(live.exitCode!==null||live.signalCode!==null)resolve();else live.once('close',resolve);});}
  },
  'integration-recovery-original-error': async () => {
    const {runStepError} = await load('packages/cli/src/run-entry.js');
    assert.equal(typeof runStepError,'function','Recovery must retain structured original step diagnostics');
    const error=runStepError({code:'WORKTREE_FINISH_PARTIAL',errors:[{code:'WORKTREE_FINISH_PARTIAL',message:'remove: WORKTREE_REMOVE_FAILED: contains modified or untracked files'}]},'Recover sealed transaction');
    assert.equal(error.code,'WORKTREE_FINISH_PARTIAL');
    assert.match(error.message,/WORKTREE_REMOVE_FAILED/);
    assert.match(error.message,/contains modified or untracked files/);
  }
};
export const heartbeatCleanupChecks=Object.fromEntries(Object.entries(checks).map(([id,check])=>[id,async()=>{
  try {await check();} catch(e) {if(e?.code==='ERR_ASSERTION')throw e;throw new assert.AssertionError({message:`${id}: ${e?.code ?? ''} ${e?.message ?? e}`});}
}]));
