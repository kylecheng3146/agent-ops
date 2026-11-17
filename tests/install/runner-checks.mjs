import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const runners = [{id: 'behavior', command: 'node', args: ['tests/check.mjs'], cwd: '.', adapter: 'generic',
  timeoutMs: 42000, setup: [{command: 'npm', args: ['ci']}], build: [{command: 'npm', args: ['run', 'build']}],
  testBuild: [{command: 'node', args: ['--check', 'tests/check.mjs']}]}];

async function fixture(build, check) {
  const output = resolve(build ?? process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
  const mod = path => import(pathToFileURL(join(output, path)).href);
  const {createInstallPlan} = await mod('runtime/src/install/plan.js');
  const {applyInstallPlan} = await mod('runtime/src/install/apply.js');
  const {commonHarnessAdapters} = await mod('runtime/src/install/harness.js');
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-install-runners-'));
  try {
    const options = {root, scope: 'project', harness: ['codex'], profiles: ['core'], adapters: commonHarnessAdapters()};
    const first = await createInstallPlan(options);
    assert.deepEqual(first.config.verification, {commands: []}, 'Fresh installation defaults stay unchanged');
    await applyInstallPlan(root, first);
    const config = {...first.config, verification: {commands: [], acceptanceRunners: runners}};
    const path = join(root, '.agent-ops/config.json');
    await writeFile(path, JSON.stringify(config));
    await check({root, options, config, path, mod, createInstallPlan});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

async function previewLearning({root, options, path, mod}, learning) {
  const {runUpdateCommand} = await mod('packages/cli/src/commands/update.js');
  const {parseArgs} = await mod('packages/cli/src/args.js');
  const before = await readFile(path, 'utf8');
  const preview = await runUpdateCommand({root, adapters: options.adapters, isTTY: false,
    args: parseArgs(['update', '--scope', 'project', '--target-version', '1.3.0', '--dry-run', '--json']),
    confirm: async () => assert.fail('Preview must not request confirmation')});
  assert.equal(preview.code, 'UPDATE_PLAN_READY');
  const operation = preview.data.plan.installation.operations.find(o => o.path === '.agent-ops/config.json');
  assert.equal(operation.kind, 'write');
  assert.deepEqual(JSON.parse(operation.content).learning, learning, 'CLI update preview preserves learning registration');
  assert.equal(await readFile(path, 'utf8'), before, 'Preview must not write the config');
}

export const installRunnerChecks = {
  'install-learning-preserved': async build => {
    for (const [humanConfirmed, independentlyLabelled] of [[true, true], [true, false], [false, true], [false, false]])
      await fixture(build, async f => {
        const {createUpdatePlan, applyUpdatePlan} = await f.mod('runtime/src/install/update.js');
        const learning = {suitePath: 'fixtures/labelled-suite.json', suiteDigest: 'a'.repeat(64), humanConfirmed, independentlyLabelled,
          settings: {target: 'agy', model: 'fixture-model-v1', effort: 'high'}};
        await writeFile(f.path, JSON.stringify({...f.config, learning}));
        for (let attempt = 0; attempt < 2; attempt++) {
          await previewLearning(f, learning);
          const plan = await createUpdatePlan({...f.options, targetVersion: '1.3.0'});
          assert.deepEqual(plan.installation.config.learning, learning);
          await applyUpdatePlan(f.root, plan);
          assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).learning, learning, 'Applied update retains every registration field');
        }
        assert.deepEqual((await f.createInstallPlan(f.options)).config.learning, learning, 'Init re-plan retains the registration');
      });
  },
  'install-learning-absent': build => fixture(build, async f => {
    const {createUpdatePlan, applyUpdatePlan} = await f.mod('runtime/src/install/update.js');
    await previewLearning(f, undefined);
    const plan = await createUpdatePlan({...f.options, targetVersion: '1.3.0'});
    assert.equal(Object.hasOwn(plan.installation.config, 'learning'), false);
    await applyUpdatePlan(f.root, plan);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(f.path, 'utf8')), 'learning'), false);
    assert.equal(Object.hasOwn((await f.createInstallPlan(f.options)).config, 'learning'), false);
  }),
  'install-runners-preserved': async build => {
    for (const detected of [false, true]) await fixture(build, async ({root, options, path, mod, createInstallPlan}) => {
      const {createUpdatePlan, applyUpdatePlan} = await mod('runtime/src/install/update.js');
      if (detected) {
        await writeFile(join(root, 'package.json'), JSON.stringify({scripts: {test: 'node --test'}}));
        await writeFile(join(root, 'package-lock.json'), '{}');
      }
      let previous;
      for (let attempt = 0; attempt < 2; attempt++) {
        const plan = await createUpdatePlan({...options, targetVersion: '0.11.3'});
        await applyUpdatePlan(root, plan);
        const saved = JSON.parse(await readFile(path, 'utf8')).verification;
        assert.deepEqual(saved.acceptanceRunners, runners, 'Applied update preserves every acceptance runner field');
        assert.equal(saved.commands.length, detected ? 1 : 0);
        if (detected) assert.equal(saved.commands[0].id, 'node-test');
        if (previous) assert.deepEqual(saved, previous, 'Repeated update is idempotent');
        previous = saved;
      }
      const replanned = await createInstallPlan(options);
      assert.deepEqual(replanned.config.verification, previous, 'Init replanning preserves the same verification');
    });
  },
  'install-runners-diagnostics': build => fixture(build, async ({root, config, path, options, mod}) => {
    const {doctorInstallation} = await mod('runtime/src/install/doctor.js');
    const {runInitCommand} = await mod('packages/cli/src/commands/init.js');
    const {parseArgs} = await mod('packages/cli/src/args.js');
    for (const hasRunners of [true, false]) {
      await writeFile(path, JSON.stringify({...config, verification: {commands: [], ...(hasRunners ? {acceptanceRunners: runners} : {})}}));
      const report = await doctorInstallation({root});
      const diagnostic = report.checks.find(check => check.id === 'verification-commands');
      assert.ok(diagnostic, 'Doctor retains the verifier diagnostic');
      assert.equal(diagnostic.status, 'DEGRADED');
      assert.equal(diagnostic.code, undefined);
      assert.match(diagnostic.remediation, /Add verification.commands/u);
      assert.match(diagnostic.message, /legacy criteria need a required verifier/u);
      assert.doesNotMatch(diagnostic.message, /no task can be completed/u);
      const result = await runInitCommand({root, adapters: options.adapters, isTTY: false,
        args: parseArgs(['init', '--scope', 'project', '--harness', 'codex', '--profile', 'core', '--dry-run', '--json']),
        confirm: async () => {throw new Error('Dry-run must not request confirmation');}});
      assert.equal(result.code, 'INIT_PLAN_READY');
      assert.equal(result.data.applied, false);
      assert.ok(result.data.warnings?.length, 'Init retains the missing-verifier warning');
      assert.match(result.data.warnings[0], /legacy criteria need a required verifier/u);
      assert.doesNotMatch(result.data.warnings[0], /no task can be completed/u);
    }
  })
};
