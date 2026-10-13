import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {recoveryChecks} from '../debug/recovery-checks.mjs';
import {officePhaseChecks} from '../office/phase-checks.mjs';
import {peerOriginChecks} from '../debug/peer-origin-checks.mjs';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const mod = path => import(pathToFileURL(join(build, path)).href);
const {collectChangeSurface} = await mod('runtime/src/verify/change-surface.js');
const {CompletionGateService} = await mod('runtime/src/hooks/completion-gate.js');
const {writeSessionMarker} = await mod('runtime/src/hooks/codex-loop.js');
const {TaskService} = await mod('runtime/src/task/service.js');
const {FileTaskStore} = await mod('runtime/src/task/store.js');
const {FileEvidenceStore} = await mod('runtime/src/verify/evidence.js');
const {addWorktree} = await mod('runtime/src/parallel/service.js');
const {createInstallPlan} = await mod('runtime/src/install/plan.js');
const {applyInstallPlan} = await mod('runtime/src/install/apply.js');
const {commonHarnessAdapters} = await mod('runtime/src/install/harness.js');
const {createRunState, FileRunRepository} = await mod('runtime/src/run/service.js');
const {bindRunPolicy, readRunPolicy} = await mod('runtime/src/run/policy.js');
const config = {schemaVersion: 3, profiles: ['core', 'loop'], verification: {commands: []},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};

async function fixture(check) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-startup-'));
  const git = args => execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
  const runner = cwd => ({run: async args => {
    try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd, stdio: ['ignore', 'pipe', 'pipe']})};}
    catch (e) {return {exitCode: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0)};}
  }});
  const gate = cwd => new CompletionGateService({root: cwd, config, gitRunner: runner(cwd),
    taskService: new TaskService(new FileTaskStore(join(cwd, '.agent-ops/tasks/state.json'), cwd)),
    evidenceStore: new FileEvidenceStore(cwd, cwd)});
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Run fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n.claude/loop-state.md\n.codex/loop-state.md\n');
    await writeFile(join(root, 'source.txt'), 'baseline\n');
    git(['add', '.']); git(['commit', '-qm', 'baseline']);
    await mkdir(join(root, '.agent-ops'), {recursive: true});
    await writeFile(join(root, '.agent-ops/config.json'), JSON.stringify(config));
    await mkdir(join(root, '.claude')); await mkdir(join(root, '.codex'));
    await check({root, git, runner, gate});
  } finally {await rm(root, {recursive: true, force: true});}
}

const checks = {
  ...recoveryChecks,
  ...officePhaseChecks,
  ...peerOriginChecks,
  'live-worktree-heartbeats': () => fixture(async ({root, runner, gate}) => {
    const deps = {git: async (cwd, args) => {
      try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}), stderr: ''};}
      catch (e) {return {exitCode: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? ''};}
    }, loadConfig: async () => config, trust: {status: async () => 'TRUSTED', grant: async () => {}, revoke: async () => {}},
    gate: async cwd => gate(cwd), runSetup: async () => ({exitCode: 0, output: 'setup complete'})};
    const result = await addWorktree(deps, {cwd: root, name: 'writer', sessionId: 'run-owner',
      runOwnership: {runId: 'run-fixture', workerId: 'writer', ownerSessionId: 'run-owner', generation: 1}});
    const raw = await runner(result.record.path).run(['ls-files', '--others', '--exclude-standard', '-z']);
    if (process.platform !== 'win32') assert.match(raw.stdout.toString(), /\.agent-ops-process-/u, 'A real live heartbeat must exercise startup');
    assert.deepEqual((await collectChangeSurface(runner(result.record.path))).paths, [], 'Live supervisor heartbeats must not make setup dirty');
  }),
  'controller-stop': () => fixture(async ({root, gate}) => {
    const service = gate(root);
    await service.seed('controller');
    await writeSessionMarker({root, harness: 'claude', sessionId: 'controller'});
    const stop = {event: 'stop', projectRoot: root, sessionId: 'controller', terminationReason: 'model_stop', fullyIdle: true};
    assert.equal((await service.handle(stop))?.code, 'COMPLETION_GATE_ALLOWED', 'A controller with only runtime heartbeats can stop without a fake task');
  }),
  'run-goal-ignore': async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-goal-ignore-'));
    try {
      await applyInstallPlan(root, await createInstallPlan({root, scope: 'project', harness: ['claude'], profiles: ['core', 'run'],
        adapters: commonHarnessAdapters(), hookRuntimePath: join(build, 'packages/cli/src/hook-entry.js')}));
      execFileSync('git', ['init', '-q'], {cwd: root});
      await mkdir(join(root, '.agent-ops/state'), {recursive: true});
      await writeFile(join(root, '.agent-ops/state/run-goal.md'), 'Original goal\n');
      const ignored = execFileSync('git', ['check-ignore', '--stdin'], {cwd: root, input: '.agent-ops/state/run-goal.md\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}).trim();
      assert.equal(ignored, '.agent-ops/state/run-goal.md');
    } catch (e) {
      if (e.status === 1) assert.fail('Installed runtime ignores must cover run-goal.md');
      throw e;
    } finally {await rm(root, {recursive: true, force: true});}
  },
  'source-and-runtime-safety': () => fixture(async ({root, git, runner, gate}) => {
    const heartbeat = '.claude/.agent-ops-process-12345-00000000-0000-4000-8000-000000000000';
    await writeFile(join(root, heartbeat), 'runtime:00000000-0000-4000-8000-000000000000\n');
    git(['add', heartbeat]); git(['commit', '-qm', 'tracked heartbeat-shaped source']);
    const service = gate(root); await service.seed('changed');
    await writeFile(join(root, heartbeat), 'changed tracked data\n');
    await writeFile(join(root, '.claude/.agent-ops-process-not-a-heartbeat'), 'user data\n');
    const collision = '.agent-ops-process-12345-00000000-0000-4000-8000-000000000000';
    await writeFile(join(root, collision), 'user source with a reserved-looking basename\n');
    await writeFile(join(root, 'source.txt'), 'changed product\n');
    assert.deepEqual((await collectChangeSurface(runner(root))).paths,
      [heartbeat, '.claude/.agent-ops-process-not-a-heartbeat', collision, 'source.txt'].sort());
    assert.equal((await service.handle({event: 'stop', projectRoot: root, sessionId: 'changed', terminationReason: 'model_stop', fullyIdle: true}))?.code, 'COMPLETION_GATE_TASK_REQUIRED');
    const commonDir = join(root, '.git'), repository = new FileRunRepository(join(commonDir, 'agent-ops/runs'), commonDir);
    const state = createRunState({root, commonDir, goal: 'Protect executable runtime', targetBranch: 'main', host: 'codex', ownerSessionId: 'owner'});
    await repository.create(state);
    const {calculateConfigHash} = await mod('runtime/src/config/hash.js');
    const bound = await bindRunPolicy(repository, state.runId, {config, runtimeHash: 'a'.repeat(64),
      baseTrustBinding: {canonicalPath: root, remoteIdentity: 'local:fixture', configHash: calculateConfigHash(config), runtimeHash: 'b'.repeat(64)}});
    await assert.rejects(readRunPolicy(bound, 'c'.repeat(64)), {code: 'RUN_RUNTIME_CHANGED'});
  })
};

const executionId = process.env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID ?? 'local-startup';
const phase = process.env.AGENT_OPS_ACCEPTANCE_PHASE ?? 'candidate';
const results = [];
for (const [checkId, check] of Object.entries(checks)) {
  let status = 'PASS', failureClass = 'none', detail = 'Real Git/process assertions completed';
  try {await check();} catch (e) {status = 'FAIL'; failureClass = e.code === 'ERR_ASSERTION' ? 'assertion-failed' : 'infrastructure-error'; detail = String(e.stack ?? e).replace(/[\r\n]/gu, ' ').slice(0,4000);}
  results.push({executionId, phase, framework: 'node-assert', frameworkVersion: '1', checkId, status, failureClass, attempts: 1, evidence: [detail]});
}
console.log(JSON.stringify({protocolVersion: 1, executionId, phase, framework: 'node-assert', frameworkVersion: '1', results,
  completed: true, completionEvidence: ['All named checks ran once'], diagnostics: []}));
if (results.some(r => r.status !== 'PASS')) process.exitCode = 1;
