import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, realpath, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const load = path => import(pathToFileURL(join(resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist'), path)).href);

async function probe(mode) {
  // The detached fixture owns its proof group; never reuse the supervising run's environment.
  for (const key of ['AGENT_OPS_RUN_ID', 'AGENT_OPS_WORKER_ID', 'AGENT_OPS_WORKER_GENERATION', 'AGENT_OPS_RUN_PROOF_PID']) delete process.env[key];
  const {FileRunRepository, createRunState} = await load('runtime/src/run/service.js');
  const {bindRunPolicy, runRuntimeHash} = await load('runtime/src/run/policy.js');
  const {calculateConfigHash} = await load('runtime/src/config/hash.js');
  const {runPolicyContext, loadEffectiveConfig} = await load('packages/cli/src/context.js');
  const {worktreeDependencies} = await load('packages/cli/src/parallel-deps.js');
  const {writeWorktreeRecord} = await load('runtime/src/parallel/service.js');
  const {writePrivateFile, localStatePaths} = await load('runtime/src/security/permissions.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-proof-policy-')));
  process.env.AGENT_OPS_HOME = root;
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const ps = (field, pid) => execFileSync('ps', ['-o', field + '=', '-p', String(pid)], {encoding: 'utf8'}).trim();
  try {
    assert.equal(ps('pgid', process.pid), String(process.pid), 'Fixture must own an isolated process group');
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Proof policy fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n.worktrees/\n');
    await writeFile(join(root, 'source.txt'), 'fixture\n'); git(['add', '.']); git(['commit', '-qm', 'fixture']);
    const paths = {};
    for (const name of ['coordinator', 'child-a', 'child-b', 'foreign']) {
      paths[name] = join(root, '.worktrees', name);
      git(['worktree', 'add', '-qb', name, paths[name]]);
    }
    const common = join(root, '.git'), repository = new FileRunRepository(join(common, 'agent-ops/runs'), common);
    const initial = createRunState({root, commonDir: common, targetBranch: 'main', goal: 'Prove coordinator policy scope', host: 'codex', ownerSessionId: 'owner'});
    const worker = (workerId, path, generation, status) => ({workerId, taskId: workerId, host: 'codex', ownerSessionId: 'owner-' + workerId,
      nativeSessionId: 'native-' + workerId, nativeJobId: 'thread-' + workerId, worktree: path, processId: null, processIdentity: null,
      generation, status, leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: 'inactive', lastFailure: null});
    const coordinator = worker(initial.coordinatorId, paths.coordinator, 4, 'fenced');
    const child = worker('child-a', paths['child-a'], 2, 'delivered');
    const sibling = worker('child-b', paths['child-b'], 7, 'delivered');
    await repository.create({...initial, workers: [coordinator, child, sibling]});
    const config = {schemaVersion: 3, profiles: ['core'], verification: {commands: []},
      features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [], worktree: {mode: 'auto', setup: []}};
    await writePrivateFile(join(root, '.agent-ops/config.json'), JSON.stringify(config), root);
    const bound = await bindRunPolicy(repository, initial.runId, {config, runtimeHash: await runRuntimeHash(),
      baseTrustBinding: {canonicalPath: root, remoteIdentity: 'local:fixture', configHash: calculateConfigHash(config), runtimeHash: 'a'.repeat(64)}});
    const records = new Map();
    for (const w of [coordinator, child, sibling]) {
      const record = {schemaVersion: 1, name: w === coordinator ? 'coordinator' : w.workerId, branch: w === coordinator ? 'coordinator' : w.workerId,
        path: w.worktree, mainRoot: root, targetBranch: 'main', base: git(['rev-parse', 'HEAD']), sessionId: 'owner', createdAt: initial.createdAt,
        runId: initial.runId, coordinatorId: coordinator.workerId, workerId: w.workerId, ownerSessionId: w.ownerSessionId, workerGeneration: w.generation};
      records.set(w.workerId, record); await writeWorktreeRecord(record);
    }
    const proof = {processId: process.pid, processIdentity: ps('lstart', process.pid)};
    const read = () => repository.read(initial.runId);
    const update = change => repository.mutate(initial.runId, change);
    const actor = w => Object.assign(process.env, {AGENT_OPS_RUN_ID: initial.runId, AGENT_OPS_WORKER_ID: w.workerId,
      AGENT_OPS_WORKER_GENERATION: String(w.generation), AGENT_OPS_RUN_PROOF_PID: String(proof.processId)});
    const capturedFiles = [join(root, '.agent-ops/config.json'), join(common, 'agent-ops/runs', initial.runId, 'policies', bound.policyBinding.artifactDigest + '.json'),
      ...[...records.values()].map(r => join(r.path, '.agent-ops/tasks/worktree.json')), localStatePaths(root).trustStore];
    const snapshot = async () => ({state: await read(), files: await Promise.all(capturedFiles.map(async p =>
      await readFile(p, 'utf8').catch(e => {if (e.code === 'ENOENT') return null; throw e;})))});
    const unchanged = async action => {const before = await snapshot(); await action(); assert.deepEqual(await snapshot(), before, 'Policy reads must not mutate authority or checkout state');};
    const denied = (path, code = 'RUN_WORKER_STALE') => unchanged(() => assert.rejects(runPolicyContext(path), {code}));
    await update(s => ({...s, proofProcess: proof})); actor(coordinator);

    if (mode === 'policy') {
      const environment = {...process.env};
      await unchanged(async () => {
        for (const path of [root, coordinator.worktree, child.worktree, sibling.worktree]) {
          const context = await runPolicyContext(path);
          assert.equal(context.state.runId, initial.runId);
          assert.equal(calculateConfigHash(context.policy.config), bound.policyBinding.configHash);
          assert.equal(calculateConfigHash((await loadEffectiveConfig(path, 'project')).config), bound.policyBinding.configHash);
          assert.equal(calculateConfigHash(await worktreeDependencies().loadConfig(path)), bound.policyBinding.configHash);
        }
      });
      await update(s => ({...s, workers: s.workers.map(w => w.workerId === child.workerId
        ? {...w, proofProcess: {...proof, processId: process.pid + 1}} : w)}));
      await unchanged(async () => assert.ok(await runPolicyContext(child.worktree), 'Child-local record must not mask authenticated global proof'));
      assert.deepEqual({...process.env}, environment, 'Reading different targets must not rewrite the coordinator actor');
    } else if (mode === 'actor') {
      actor(child);
      await denied(child.worktree);
      actor(coordinator); delete process.env.AGENT_OPS_WORKER_ID;
      await denied(child.worktree);
      delete process.env.AGENT_OPS_WORKER_GENERATION;
      await denied(root);
    } else if (mode === 'boundaries') {
      for (const w of [{...coordinator, workerId: 'forged'}, {...coordinator, generation: 3}]) {actor(w); await denied(root);}
      actor(coordinator); process.env.AGENT_OPS_RUN_PROOF_PID = String(process.pid + 1);
      await denied(root);
      actor(coordinator);
      await update(s => ({...s, proofProcess: {...proof, processIdentity: 'wrong process start'}}));
      await denied(root);
      const otherGroup = {processId: process.ppid, processIdentity: ps('lstart', process.ppid)};
      await update(s => ({...s, proofProcess: otherGroup})); process.env.AGENT_OPS_RUN_PROOF_PID = String(otherGroup.processId);
      await denied(root);
      await update(s => ({...s, proofProcess: proof})); actor(coordinator);
      await denied(paths.foreign);
      await update(s => ({...s, workers: s.workers.filter(w => w.workerId !== coordinator.workerId)}));
      await denied(root);
      await update(s => ({...s, workers: [coordinator, child, sibling]}));
      for (const changes of [{status: 'paused'}, {status: 'awaiting-input'}, {status: 'blocked'}, {status: 'stopping'},
        {status: 'budget-limited'}, {disableRestart: true}, {awaitingResume: true}, {status: 'complete'}]) {
        await update(s => ({...s, status: 'active', disableRestart: false, awaitingResume: false, ...changes}));
        await denied(root, 'RUN_POLICY_DISABLED');
      }
    } else if (mode === 'worker') {
      await update(s => ({...s, proofProcess: null, workers: s.workers.map(w => w.workerId === child.workerId ? {...w, proofProcess: proof} : w)}));
      actor(child);
      await unchanged(async () => assert.ok(await runPolicyContext(child.worktree)));
      for (const path of [root, coordinator.worktree, sibling.worktree, paths.foreign]) await denied(path);
      actor({...child, generation: 1}); await denied(child.worktree);
      actor(coordinator); await denied(child.worktree);
      await update(s => ({...s, workers: s.workers.map(w => ({...w, proofProcess: null}))}));
      delete process.env.AGENT_OPS_RUN_PROOF_PID;
      actor(child); delete process.env.AGENT_OPS_RUN_PROOF_PID;
      await unchanged(async () => assert.ok(await runPolicyContext(child.worktree)));
      for (const key of ['AGENT_OPS_RUN_ID', 'AGENT_OPS_WORKER_ID', 'AGENT_OPS_WORKER_GENERATION']) delete process.env[key];
      await unchanged(async () => assert.ok(await runPolicyContext(child.worktree), 'Ordinary record-based checkout needs no global proof actor'));
      const record = records.get(child.workerId);
      for (const changes of [{runId: 'run-0000000000000000'}, {workerId: 'foreign'}, {ownerSessionId: 'foreign'}, {coordinatorId: 'foreign'}, {workerGeneration: 1}]) {
        await writeWorktreeRecord({...record, ...changes}); process.env.AGENT_OPS_RUN_ID = initial.runId;
        await denied(child.worktree);
      }
    } else assert.fail('Unknown proof fixture mode');
  } finally {await rm(root, {recursive: true, force: true});}
}

async function isolated(mode) {
  // Native proof binding requires POSIX process groups and ps identity fields.
  if (process.platform === 'win32') return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--probe', mode], {detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  let diagnostic = '';
  child.stdout.on('data', b => {diagnostic = (diagnostic + b).slice(-65536);});
  child.stderr.on('data', b => {diagnostic = (diagnostic + b).slice(-65536);});
  const timer = setTimeout(() => {try {process.kill(-child.pid, 'SIGKILL');} catch {}}, 60000);
  try {
    const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', resolve);});
    assert.equal(code, 0, diagnostic || `Proof policy ${mode} fixture failed`);
  } finally {clearTimeout(timer);}
}

export const coordinatorProofPolicyChecks = {
  'coordinator-proof-policy': () => isolated('policy'),
  'coordinator-proof-actor': () => isolated('actor'),
  'coordinator-proof-boundaries': () => isolated('boundaries'),
  'worker-proof-contexts': () => isolated('worker')
};

if (process.argv[2] === '--probe') await probe(process.argv[3]);
