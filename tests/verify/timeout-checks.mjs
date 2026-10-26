import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmod, mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Runner and review time limits. Modules load lazily so an older build fails each
// check as an assertion, never as a crashed runner.
const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const load = async path => {
  try {return await import(pathToFileURL(join(build, path)).href);}
  catch (e) {assert.fail(`${path} is unavailable: ${e.code ?? e.message}`);}
};

const SLOW_STEP = {command: process.execPath, args: ['-e', 'setTimeout(() => {}, 5000)'], timeoutMs: 300};

/** A one-criterion behavioral task whose runner has one build step, by default one that outlives its own 300 ms limit. */
async function slowBuild(check, step = SLOW_STEP) {
  const {FileTaskStore} = await load('runtime/src/task/store.js');
  const {TaskService} = await load('runtime/src/task/service.js');
  const {FileEvidenceStore, calculateConfigHash} = await load('runtime/src/verify/evidence.js');
  const {VerificationService} = await load('runtime/src/verify/service.js');
  const {NodeVerificationProcessRunner} = await load('runtime/src/verify/spawn.js');
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-timeout-'));
  try {
    const git = (...args) => execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    git('init', '-q'); git('config', 'user.name', 'Timeout fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await writeFile(join(root, 'product.mjs'), 'export const value = 0;\n');
    git('add', '.'); git('commit', '-qm', 'baseline');
    const baseline = git('rev-parse', 'HEAD').toString().trim();
    const gitRunner = {run: async args => {
      try {return {exitCode: 0, stdout: git(...args)};} catch {return {exitCode: 1, stdout: Buffer.alloc(0)};}
    }};
    const config = {schemaVersion: 3, profiles: ['core'], verification: {commands: [], acceptanceRunners: [{id: 'acceptance',
      command: process.execPath, args: ['tests/check.mjs'], cwd: '.', adapter: 'generic',
      build: [step]}]},
      features: {completionGate: {enabled: false}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};
    const tasks = new TaskService(new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root),
      {completion: {root, gitRunner, base: baseline, loadConfig: async () => config}});
    const materials = [{path: 'tests/check.mjs', role: 'test'}];
    const record = await tasks.create({title: 'Fix value', goal: 'Value equals one', policyConfigHash: calculateConfigHash(config), criteria: [
      {id: 'behavior', description: 'Value equals one', verifierIds: [], acceptance: {mode: 'behavioral', baselineCommit: baseline,
        bindings: [{runnerId: 'acceptance', materials, checkIds: ['behavior'], redCheckIds: ['behavior']}]}},
      {id: 'numeric', description: 'Value stays numeric', verifierIds: [], acceptance: {mode: 'invariant', baselineCommit: baseline,
        bindings: [{runnerId: 'acceptance', materials, checkIds: ['numeric']}]}}]});
    await mkdir(join(root, 'tests'));
    await writeFile(join(root, 'tests/check.mjs'), 'process.exitCode = 0;\n');
    await writeFile(join(root, 'product.mjs'), 'export const value = 1;\n');
    git('add', '.'); git('commit', '-qm', 'candidate');
    const report = await new VerificationService({root, scope: 'project', config, gitRunner, processRunner: new NodeVerificationProcessRunner(),
      taskService: tasks, evidenceStore: new FileEvidenceStore(root, root), trusted: true, base: baseline}).verify(record.task.id);
    await check(report);
  } finally {await rm(root, {recursive: true, force: true});}
}

const raw = {
  'acceptance-step-timeouts': async () => {
    const {ACCEPTANCE_TIMEOUTS} = await load('runtime/src/verify/acceptance-replay.js');
    // Each step kind has its own default; the old shared 60 s cut off npm ci and long runners alike.
    assert.deepEqual(ACCEPTANCE_TIMEOUTS, {setup: 600_000, build: 300_000, testBuild: 300_000, run: 300_000, git: 60_000});
  },

  'acceptance-timeout-detail': () => slowBuild(async report => {
    assert.equal(report.status, 'UNKNOWN', JSON.stringify(report.acceptance));
    const details = (report.acceptance ?? []).map(row => row.detail);
    assert.ok(details.length > 0 && details.every(detail => /build step .+ exceeded 300 ms; raise the step's timeoutMs in verification\.acceptanceRunners\[\]\.build\./u.test(detail ?? '')),
      JSON.stringify(report.acceptance));
  }),

  'temporary-cleanup-fail-open': async () => {
    // Windows holds a killed step's files open (EBUSY); a read-only directory stands in for that here.
    // An undeletable replay checkout must not turn a finished verification into a crash.
    const scratch = await mkdtemp(join(tmpdir(), 'agent-ops-scratch-'));
    const saved = process.env.TMPDIR; process.env.TMPDIR = scratch;
    try {
      await slowBuild(report => assert.ok(['PASS', 'FAIL', 'UNKNOWN'].includes(report.status), JSON.stringify(report.acceptance)),
        {command: process.execPath, args: ['-e', "const fs = require('fs'); fs.mkdirSync('locked'); fs.writeFileSync('locked/f', 'x'); fs.chmodSync('locked', 0o555);"]});
      if (process.platform !== 'win32') assert.ok((await readdir(scratch)).some(name => name.startsWith('agent-ops-acceptance-')),
        'the fixture left no undeletable checkout, so cleanup was never exercised');
    } finally {
      if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
      for (const name of await readdir(scratch)) await chmod(join(scratch, name, 'repository/locked'), 0o755).catch(() => undefined);
      await rm(scratch, {recursive: true, force: true});
    }
  },

  'review-default-timeout': async () => {
    const {DEFAULT_REVIEW_TIMEOUT_MS} = await load('runtime/src/review/execute.js');
    assert.equal(DEFAULT_REVIEW_TIMEOUT_MS, 1_800_000);
  },

  'review-timeout-not-capped': async () => {
    const execute = await load('runtime/src/review/execute.js');
    assert.equal(typeof execute.stageTimeout, 'function', 'stageTimeout is not exported');
    // A configured reviewer timeout above the default is honored, not cut back to it.
    assert.equal(execute.stageTimeout({timeoutMs: 3_600_000}), 3_600_000);
    assert.equal(execute.stageTimeout({}), execute.DEFAULT_REVIEW_TIMEOUT_MS);
    // Short stages keep their own ceiling, and the chain deadline still wins.
    assert.equal(execute.stageTimeout({timeoutMs: 3_600_000}, 60_000), 60_000);
    assert.equal(execute.stageTimeout({timeoutMs: 3_600_000, deadlineAt: 1_000, now: () => 400}), 600);
  },

  'default-command-timeout-600s': async () => {
    const spawnModule = await load('runtime/src/verify/spawn.js');
    assert.equal(spawnModule.DEFAULT_TIMEOUT_MS, 600_000, 'Default verification command timeout must be 600,000 ms (10 minutes)');
  },

  'proof-group-timeout-isolation': async () => {
    // Windows uses tree termination; this probe requires a shared POSIX group.
    if (process.platform === 'win32') return;
    const {spawn} = await import('node:child_process');
    const spawnUrl = pathToFileURL(join(build, 'runtime/src/verify/spawn.js')).href;
    const probeScript = `
      import {spawnSync} from 'node:child_process';
      const {NodeVerificationProcessRunner, runVerificationCommand} = await import(${JSON.stringify(spawnUrl)});
      let selfSignaled = false;
      process.on('SIGTERM', () => { selfSignaled = true; });
      const innerScript = [
        "import {spawn} from 'node:child_process';",
        "const grand = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], {stdio: 'ignore'});",
        "console.log('GRAND_PID=' + grand.pid);",
        "setTimeout(() => {}, 2000);"
      ].join(' ');
      const sharedRunner = new NodeVerificationProcessRunner({processGroupId: process.pid});
      const sharedResult = await runVerificationCommand({
        id: 'slow-proof-cmd',
        command: process.execPath,
        args: ['--input-type=module', '-e', innerScript],
        cwd: '.',
        required: true,
        timeoutMs: 250
      }, {
        cwd: process.cwd(),
        runner: sharedRunner,
        timeoutMs: 250,
        terminationGraceMs: 100
      });
      const match = /GRAND_PID=(\\d+)/.exec(sharedResult.stdout);
      const grandPid = match ? Number(match[1]) : null;
      await new Promise(r => setTimeout(r, 150));
      let grandAlive = false;
      if (grandPid !== null) {
        try { process.kill(grandPid, 0); grandAlive = true; process.kill(grandPid, 'SIGKILL'); } catch {}
      }
      let normalTerminationError;
      const nativeNormalRunner = new NodeVerificationProcessRunner();
      const normalRunner = {start(request) {
        const running = nativeNormalRunner.start(request);
        return {...running, terminateTree: async grace => {
          try {await running.terminateTree(grace);}
          catch(error) {normalTerminationError = {pid: running.pid, code: error.code, message: error.message}; throw error;}
        }};
      }};
      const normalResult = await runVerificationCommand({
        id: 'slow-normal-cmd',
        command: 'sleep',
        args: ['2'],
        cwd: '.',
        required: true,
        timeoutMs: 150
      }, {
        cwd: process.cwd(),
        runner: normalRunner,
        timeoutMs: 150,
        terminationGraceMs: 100
      });
      process.stdout.write(JSON.stringify({
        selfSignaled,
        grandPid,
        grandAlive,
        sharedTimedOut: sharedResult.timedOut,
        sharedFailureClass: sharedResult.failureClass,
        normalTimedOut: normalResult.timedOut,
        normalFailureClass: normalResult.failureClass,
        normalTerminationError
      }));
    `;
    const probe = await new Promise((resolveProbe, rejectProbe) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', probeScript], {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('error', rejectProbe);
      child.on('close', (code, signal) => resolveProbe({code, signal, stdout, stderr}));
    });
    assert.equal(probe.signal, null, `Proof group leader was killed by signal ${probe.signal}: ${probe.stderr}`);
    assert.equal(probe.code, 0, `Probe exited ${probe.code}: ${probe.stderr}`);
    const data = JSON.parse(probe.stdout);
    assert.equal(data.selfSignaled, false, 'Proof group leader must not receive SIGTERM when a single verification command times out');
    assert.equal(data.sharedTimedOut, true, 'Timed-out command under proofGroupId must report timedOut=true');
    assert.equal(data.sharedFailureClass, 'timeout', 'Timed-out command under proofGroupId must classify as timeout');
    assert.ok(typeof data.grandPid === 'number' && data.grandPid > 0, 'Timed-out command must have spawned its child process');
    assert.equal(data.grandAlive, false, 'Timed-out command descendant subtree must be terminated');
    assert.equal(data.normalTimedOut, true, 'Non-shared runner timeout must still report timedOut=true');
    assert.equal(data.normalFailureClass, 'timeout', 'Non-shared runner timeout must still classify as timeout: ' + JSON.stringify(data.normalTerminationError));
  },

  'tree-verification-shares-passing-command': async () => {
    const {FileTaskStore} = await load('runtime/src/task/store.js');
    const {executionContractHash} = await load('runtime/src/task/contract.js');
    const {TaskService} = await load('runtime/src/task/service.js');
    const {FileEvidenceStore, calculateConfigHash} = await load('runtime/src/verify/evidence.js');
    const {VerificationService} = await load('runtime/src/verify/service.js');
    const {NodeVerificationProcessRunner} = await load('runtime/src/verify/spawn.js');
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-tree-share-'));
    try {
      const git = (...args) => execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
      git('init', '-q'); git('config', 'user.name', 'Tree share fixture'); git('config', 'user.email', 'fixture@example.invalid');
      await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
      await mkdir(join(root, 'tests'));
      const checkScript = [
        "import {value} from '../product.mjs';",
        "const executionId = process.env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID ?? 'local';",
        "const phase = process.env.AGENT_OPS_ACCEPTANCE_PHASE ?? 'candidate';",
        "const status = value === 1 ? 'PASS' : 'FAIL';",
        "const failureClass = value === 1 ? 'none' : 'assertion-failed';",
        "const results = ['parent-check', 'child-check', 'solo-check'].map(checkId => ({",
        "  executionId, phase, framework: 'node-assert', frameworkVersion: '1',",
        "  checkId, status, failureClass, attempts: 1, evidence: ['checked value']",
        "}));",
        "console.log(JSON.stringify({",
        "  protocolVersion: 1, executionId, phase, framework: 'node-assert', frameworkVersion: '1',",
        "  results, completed: true, completionEvidence: ['done'], diagnostics: []",
        "}));",
        "if (status !== 'PASS') process.exitCode = 1;"
      ].join('\n') + '\n';
      await writeFile(join(root, 'tests/check.mjs'), checkScript);
      await writeFile(join(root, 'product.mjs'), 'export const value = 0;\n');
      git('add', '.'); git('commit', '-qm', 'baseline');
      const baseline = git('rev-parse', 'HEAD').toString().trim();
      const gitRunner = {run: async args => {
        try {return {exitCode: 0, stdout: git(...args)};} catch {return {exitCode: 1, stdout: Buffer.alloc(0)};}
      }};
      const makeConfig = (cmdScript = "console.log('# tests 1\\n# pass 1\\n# fail 0');") => ({
        schemaVersion: 3,
        profiles: ['core'],
        verification: {
          commands: [{
            id: 'unit-test',
            command: process.execPath,
            args: ['-e', cmdScript],
            cwd: '.',
            required: true,
            timeoutMs: 5000,
            evidence: {kind: 'test-count', minimum: 1}
          }],
          acceptanceRunners: [{
            id: 'acceptance',
            command: process.execPath,
            args: ['tests/check.mjs'],
            cwd: '.',
            adapter: 'generic'
          }]
        },
        features: {completionGate: {enabled: false}, stopVerification: {enabled: false}},
        pathMappings: [],
        securityExceptions: []
      });
      const config = makeConfig();
      const tasks = new TaskService(new FileTaskStore(join(root, '.agent-ops/tasks/state.json'), root),
        {completion: {root, gitRunner, base: baseline, loadConfig: async () => config}});
      const materials = [{path: 'tests/check.mjs', role: 'test'}];
      const parent = await tasks.create({
        title: 'Parent task',
        goal: 'Tree goal',
        policyConfigHash: calculateConfigHash(config),
        criteria: [
          {id: 'c-parent-unit', description: 'Unit test passes', verifierIds: ['unit-test']},
          {id: 'c-parent-acc', description: 'Parent check passes', verifierIds: [], acceptance: {
            mode: 'behavioral', baselineCommit: baseline,
            bindings: [{runnerId: 'acceptance', materials, checkIds: ['parent-check'], redCheckIds: ['parent-check']}]
          }}
        ]
      });
      const child = await tasks.create({
        title: 'Child task',
        goal: 'Tree goal',
        parentTaskId: parent.task.id,
        policyConfigHash: calculateConfigHash(config),
        criteria: [
          {id: 'c-child-unit', description: 'Unit test passes for child', verifierIds: ['unit-test']},
          {id: 'c-child-acc', description: 'Child check passes', verifierIds: [], acceptance: {
            mode: 'behavioral', baselineCommit: baseline,
            bindings: [{runnerId: 'acceptance', materials, checkIds: ['child-check'], redCheckIds: ['child-check']}]
          }}
        ]
      });
      const standalone = await tasks.create({
        title: 'Standalone task',
        goal: 'Solo goal',
        policyConfigHash: calculateConfigHash(config),
        criteria: [
          {id: 'c-solo-unit', description: 'Unit test passes for solo', verifierIds: ['unit-test']},
          {id: 'c-solo-unit-2', description: 'Unit test passes for solo second criterion', verifierIds: ['unit-test']}
        ]
      });
      await writeFile(join(root, 'product.mjs'), 'export const value = 1;\n');
      git('add', '.'); git('commit', '-qm', 'candidate');
      const delegate = new NodeVerificationProcessRunner();
      let unitTestRuns = 0;
      const countingRunner = {
        start(spec) {
          if (spec.args?.[0] === '-e' && String(spec.args?.[1]).includes('# pass 1')) unitTestRuns += 1;
          return delegate.start(spec);
        }
      };
      const evidenceStore = new FileEvidenceStore(root, root);
      const service = new VerificationService({
        root, scope: 'project', config, gitRunner, processRunner: countingRunner,
        taskService: tasks, evidenceStore, trusted: true, base: baseline
      });
      const parentReport = await service.verify(parent.task.id);
      assert.equal(parentReport.status, 'PASS');
      assert.equal(unitTestRuns, 1, 'Parent task verification must execute unit-test once');

      const childReport = await service.verify(child.task.id);
      assert.equal(childReport.status, 'PASS');
      assert.equal(unitTestRuns, 1, 'Child task in the same tree at identical sourceFingerprint/configHash/scope must reuse passing unit-test execution');
      assert.ok((childReport.acceptance?.length ?? 0) > 0 && childReport.acceptance.every(r => r.criterionId === 'c-child-acc' && r.status === 'PASS'),
        'Child task must still execute its own acceptance check');

      const childStatus = await tasks.status({taskId: child.task.id});
      const childUnitRefs = childStatus.evidence['c-child-unit'] ?? [];
      assert.equal(childUnitRefs.length, 1, 'Child task must record its own verification evidence ref');
      const childEvidence = await evidenceStore.load(childUnitRefs[0]);
      assert.equal(childEvidence.taskId, child.task.id);
      assert.equal(childEvidence.criterionId, 'c-child-unit');
      assert.equal(childEvidence.taskContractHash, executionContractHash(child.task));
      assert.equal(childEvidence.sourceFingerprint, childReport.sourceFingerprint);

      // Single standalone task is not in a multi-task tree and must execute unit-test freshly.
      const soloReport = await service.verify(standalone.task.id);
      assert.equal(soloReport.status, 'PASS');
      assert.equal(unitTestRuns, 2, 'Standalone task outside the multi-task tree must execute unit-test freshly');

      // Different scope must execute unit-test freshly.
      const childUnitOnly = await tasks.create({
        title: 'Second child task',
        goal: 'Tree goal',
        parentTaskId: parent.task.id,
        policyConfigHash: calculateConfigHash(config),
        criteria: [
          {id: 'c-child2-unit', description: 'Unit test passes for second child', verifierIds: ['unit-test']},
          {id: 'c-child2-unit-b', description: 'Unit test passes for second child b', verifierIds: ['unit-test']}
        ]
      });
      const userScopeService = new VerificationService({
        root, scope: 'user', config, gitRunner, processRunner: countingRunner,
        taskService: tasks, evidenceStore, trusted: true, base: baseline
      });
      await userScopeService.verify(childUnitOnly.task.id);
      assert.equal(unitTestRuns, 3, 'Different verification scope must not reuse project-scope command evidence');

      // Failing command must not be shared across peer tasks in the tree.
      const failingConfig = makeConfig("console.error('boom'); process.exit(1);");
      let failingRuns = 0;
      const failingRunner = {
        start(spec) {
          if (spec.args?.[0] === '-e' && String(spec.args?.[1]).includes('boom')) failingRuns += 1;
          return delegate.start(spec);
        }
      };
      const failingService = new VerificationService({
        root, scope: 'project', config: failingConfig, gitRunner, processRunner: failingRunner,
        taskService: tasks, evidenceStore, trusted: true, base: baseline
      });
      const failedChild = await failingService.verify(childUnitOnly.task.id);
      assert.equal(failedChild.status, 'FAIL');
      assert.equal(failingRuns, 1);
      const failedParent = await failingService.verify(parent.task.id);
      assert.equal(failedParent.status, 'FAIL');
      assert.equal(failingRuns, 2, 'Failing command execution must not be reused across peer tasks');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }
};

/** Missing behavior surfaces as a failed assertion, so the baseline is red, not broken. */
export const timeoutChecks = Object.fromEntries(Object.entries(raw).map(([id, check]) => [id, async () => {
  try {await check();}
  catch (e) {
    if (e?.code === 'ERR_ASSERTION') throw e;
    throw new assert.AssertionError({message: `${id}: ${e?.code ?? ''} ${e?.stack ?? e}`});
  }
}]));
