import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, copyFile, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {load, moduleUrl, withRepository, reviewedCandidate, config, finding, checkedGit, runner, sealNativeCandidate} from './fixture.mjs';
import {report, reviewer} from './assessment-checks.mjs';

const execute = promisify(execFile);
async function cli(cwd, args, extraEnv = {}) {
  const env = {...process.env, AGENT_OPS_HOME: cwd, AGENT_OPS_HOST: 'codex', ...extraEnv};
  // Fixture repositories have their own authority, never the enclosing worker's lease.
  for (const key of ['AGENT_OPS_RUN_ID', 'AGENT_OPS_WORKER_ID', 'AGENT_OPS_WORKER_GENERATION']) delete env[key];
  const result = await execute(process.execPath, [fileURLToPath(moduleUrl('packages/cli/src/bin.js')), ...args],
    {cwd, env, timeout: 30000, maxBuffer: 2 * 1024 * 1024}).then(r => ({...r, code: 0}), e => ({stdout: e.stdout, stderr: e.stderr, code: e.code}));
  if (args.includes('--json')) result.envelope = JSON.parse(result.stdout);
  return result;
}
async function cliModule() {
  try {
    const api = await load('packages/cli/src/commands/followup.js');
    // tsc emits code only; subprocesses in fixture checkouts need the packaged schema asset too.
    await mkdir(fileURLToPath(moduleUrl('schemas')), {recursive: true});
    await copyFile(new URL('../../schemas/review-report.schema.json', import.meta.url), fileURLToPath(moduleUrl('schemas/review-report.schema.json')));
    return api;
  }
  catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') assert.fail('The production followup CLI lifecycle must exist');
    throw error;
  }
}

export const cliChecks = {
  'followup-cli-workflows': async () => {
    await cliModule();
    const {parseArgs, COMMAND_NAMES} = await load('packages/cli/src/args.js');
    const {COMMAND_HELP_TEXT} = await load('packages/cli/src/cli.js');
    assert.ok(COMMAND_NAMES.includes('followup'));
    const id = 'followup-' + 'a'.repeat(64);
    for (const args of [[], ['list'], ['show', id], ['import'], ['sync'], ['accept', id, '--reason', 'Accepted explicitly'],
      ['defer', id, '--reason', 'Later'], ['reopen', id], ['clarify', id, '--reason', 'Concrete', '--finding-file', 'finding.json'],
      ['process', id, '--host', 'codex', '--review-only-reason', 'No executable oracle']])
      assert.equal(parseArgs(['followup', ...args, '--json']).command, 'followup');
    for (const args of [['accept', id], ['defer', id, '--reason', ' '], ['show'], ['list', id], ['process', id],
      ['process', id, '--host', 'agy'], ['process', id, '--host', 'codex', '--yes'], ['show', id, '--reason', 'x'],
      ['list', '--task', 'x'], ['import', '--json', '--json'], ['clarify', id, '--reason', 'x'], ['bogus']])
      assert.throws(() => parseArgs(['followup', ...args]));
    assert.equal(parseArgs(['followup', '--help']).helpTopic, 'followup');
    assert.match(COMMAND_HELP_TEXT.followup, /UNKNOWN/);
    await withRepository(async f => {
      const candidate = await reviewedCandidate(f);
      const {runWorktreeCommand} = await load('packages/cli/src/commands/parallel.js');
      const finished = await runWorktreeCommand({cwd: f.root, deps: f.deps,
        args: parseArgs(['worktree', 'finish', candidate.record.name])});
      assert.equal(finished.status, 'ok'); assert.match(finished.data.text, /Followup: collected 1 candidate\(s\), 2 observation\(s\)/);
      const receipt = await readFile(finished.data.receipt, 'utf8');
      let response = await cli(f.root, ['followup', 'list', '--json']);
      assert.equal(response.code, 0, response.stderr); assert.equal(response.envelope.code, 'FOLLOWUP_LIST');
      assert.equal(response.envelope.data.items.length, 3);
      const item = response.envelope.data.items.find(i => i.kind === 'candidate');
      const observation = response.envelope.data.items.find(i => i.kind === 'observation');
      response = await cli(f.root, ['followup', 'show', item.id]);
      assert.match(response.stdout, /source.txt/); assert.match(response.stdout, /receiptDigest/);
      for (const action of ['accept', 'defer']) {
        response = await cli(f.root, ['followup', action, item.id, '--reason', 'Keep the reason; token=private-value', '--json']);
        assert.equal(response.code, 0, response.stderr);
        assert.equal(response.envelope.data.item.disposition, action === 'accept' ? 'accepted' : 'deferred');
        assert.equal(response.envelope.data.progress.status, 'unresolved');
        assert.doesNotMatch(response.stdout, /private-value/);
      }
      response = await cli(f.root, ['followup', 'reopen', item.id, '--json']);
      assert.equal(response.envelope.data.item.disposition, 'pending');
      response = await cli(f.root, ['followup', 'process', observation.id, '--host', 'codex', '--json']);
      assert.equal(response.envelope.code, 'FOLLOWUP_CLARIFICATION_REQUIRED'); assert.equal(response.code, 1);
      const path = join(f.root, '.agent-ops/finding.json');
      await writeFile(path, JSON.stringify(finding));
      response = await cli(f.root, ['followup', 'clarify', observation.id, '--finding-file', path, '--reason', 'Specific source claim', '--json']);
      assert.equal(response.code, 0, response.stderr); assert.equal(response.envelope.data.item.kind, 'candidate');
      assert.equal(typeof response.envelope.data.item.original, 'string');
      response = await cli(f.root, ['followup', 'process', item.id, '--host', 'codex', '--json']);
      assert.equal(response.code, 0, response.stderr); assert.equal(response.envelope.data.progress.status, 'unresolved');
      assert.equal(response.envelope.data.progress.code, 'FOLLOWUP_UNKNOWN');
      assert.deepEqual(response.envelope.data.progress.attempts, [], 'Unavailable reviewers cannot auto-start');
      const progress = response.envelope.data.progress;
      response = await cli(f.root, ['followup', 'sync', '--json']);
      assert.equal(response.envelope.data.collection.added, 0);
      response = await cli(f.root, ['followup', 'show', item.id, '--json']);
      assert.deepEqual(response.envelope.data.progress, progress, 'Metadata-only sync preserves assessment links');
      assert.equal(response.envelope.data.item.history.length, 4);
      const ledger = join(f.commonDir, 'agent-ops/followup/ledger.json');
      await writeFile(ledger, '{broken');
      response = await cli(f.root, ['config', 'explain', '--json']);
      assert.equal(response.code, 0, response.stderr); assert.match(response.stderr, /FOLLOWUP_STATE_INVALID/);
      assert.equal(await readFile(ledger, 'utf8'), '{broken', 'Malformed private state is preserved');
      await rm(ledger);
      response = await cli(f.root, ['config', 'explain', '--json']);
      assert.equal(response.code, 0, response.stderr);
      response = await cli(f.root, ['followup', 'list', '--json']);
      assert.equal(response.envelope.data.items.length, 3, 'Ordinary CLI use retries authentic history intake');
      assert.equal(response.envelope.data.collection.added, 0, 'Ordinary command already reconciled the receipt');
      await checkedGit(f.root, ['worktree', 'add', '-qb', 'linked', '.worktrees/linked']);
      response = await cli(join(f.root, '.worktrees/linked'), ['followup', 'list', '--json']);
      assert.equal(response.envelope.data.items.length, 3, 'Linked checkouts share private ledger');
      assert.equal(await readFile(finished.data.receipt, 'utf8'), receipt, 'CLI never changes original sealed completion');
      assert.deepEqual(JSON.parse(receipt).tasks.map(t => t.status), ['complete']);
    });
  },
  'followup-end-to-end': async () => {
    await cliModule();
    // Full receipt -> isolated semantic assessment -> production native authority -> sealed specific closure,
    // with real Git/process/acceptance replay; only model transport and launchd are fixture boundaries.
    if (process.platform !== 'win32') await withRepository(async f => {
      const {finishWorktree} = await load('runtime/src/parallel/finish.js');
      const {FileFollowupStore} = await load('runtime/src/followup/store.js');
      const candidate = await reviewedCandidate(f);
      await finishWorktree(f.deps, {cwd: f.root, name: candidate.record.name});
      const item = (await new FileFollowupStore(f.commonDir).read()).items.find(i => i.kind === 'candidate');
      const original = await readFile(item.provenance.receiptPath, 'utf8');
      await checkedGit(f.root, ['worktree', 'add', '-qb', 'linked', '.worktrees/linked']);
      const linked = join(f.root, '.worktrees/linked');
      const settings = {...config, reviewRoles: [{role: 'independent-review', targets: ['claude'], timeoutMs: 10000}]};
      await writeFile(join(f.root, '.agent-ops/config.json'), JSON.stringify(settings));
      await mkdir(join(linked, '.agent-ops'));
      await writeFile(join(linked, '.agent-ops/config.json'), JSON.stringify(settings));
      const bin = join(f.commonDir, 'fake-reviewer'); await mkdir(bin);
      const script = `#!${process.execPath}\nimport fs from 'node:fs';\nconst a=process.argv;\nif(a.includes('--help')) console.log('--add-dir --permission-mode --no-session-persistence --safe-mode --disable-slash-commands --json-schema');\nelse if(a.includes('--version')) console.log('fixture');\nelse {const p=fs.readFileSync(0,'utf8');console.log(JSON.stringify(p.includes('followup-assessment')?{structured_output:${JSON.stringify(report())}}:{result:'OK'}));}\n`;
      await writeFile(join(bin, 'claude'), script); await chmod(join(bin, 'claude'), 0o700);
      const result = await cli(linked, ['followup', 'process', item.id, '--host', 'codex', '--json'], {PATH: `${bin}:${process.env.PATH}`});
      assert.equal(result.code, 1, JSON.stringify(result));
      assert.equal(result.envelope.code, process.platform === 'darwin' ? 'WORKTREE_NESTED' : 'RUN_BACKGROUND_UNSUPPORTED', JSON.stringify(result));
      assert.equal(result.envelope.data.progress.attempts.at(-1).status, 'refused');
      assert.equal(result.envelope.data.progress.status, 'unresolved');
      await checkedGit(f.root, ['worktree', 'remove', '.worktrees/linked']);
      await writeFile(join(f.root, '.agent-ops/config.json'), JSON.stringify(config));
      const {processFollowup, readFollowupProgress, followupResolutionDescription} = await load('runtime/src/followup/process.js');
      const {productionRunContext} = await load('packages/cli/src/run-deps.js');
      const {loadEffectiveConfig, repositoryTrustBinding} = await load('packages/cli/src/context.js');
      const {trustStore} = await load('packages/cli/src/parallel-deps.js');
      const {CLI_VERSION} = await load('packages/cli/src/version.js');
      const {FileRunRepository} = await load('runtime/src/run/service.js');
      const native = {supported: true, writeDescriptor: async () => {}, bootstrap: async () => {}, enableRestart: async () => {},
        wake: async () => {}, disableRestart: async () => {}, bootout: async () => {}};
      const mock = await reviewer(f);
      const reason = 'Independent source invariant has no executable oracle; both fresh reviewers must justify this fallback.';
      const options = {root: f.root, commonDir: f.commonDir, itemId: item.id, targetBranch: 'main', gitRunner: runner(f.root),
        loadConfig: async () => config, review: mock.options, reviewOnlyReason: reason, host: 'codex', start: async input => {
          const context = await productionRunContext(f.root, {launchd: native});
          return (await context.service.start({...input, root: f.root, commonDir: f.commonDir, targetBranch: 'main', ownerSessionId: 'fixture'})).state;
        }};
      const previousHome = process.env.AGENT_OPS_HOME;
      try {
        process.env.AGENT_OPS_HOME = f.root;
        const trusted = (await loadEffectiveConfig(f.root, 'project')).config;
        await trustStore().grant(await repositoryTrustBinding(f.root, trusted, CLI_VERSION));
        const selected = await Promise.all([processFollowup(options), processFollowup(options)]);
        assert.ok(selected.every(p => p.status === 'linked'));
        assert.equal(selected[0].attempts.at(-1).runId, selected[1].attempts.at(-1).runId);
        assert.equal(mock.calls.length, 2, 'Competing selection reuses one assessment and production run');
        const attempt = selected[0].attempts.at(-1);
        const runs = new FileRunRepository(join(f.commonDir, 'agent-ops/runs'), f.commonDir);
        const run = await runs.read(attempt.runId);
        assert.ok(run.policyBinding, 'Successful handoff uses production native authority');
        assert.equal(run.workers[0].status, 'assigned');
        const baseline = await checkedGit(f.root, ['rev-parse', 'HEAD']);
        const criteria = [{id: 'followup-resolution', description: followupResolutionDescription(item.id, attempt.findingDigest),
          verifierIds: ['node-test'], acceptance: {mode: 'review-only', baselineCommit: baseline, bindings: [], reviewOnlyReason: reason}},
          {id: 'regression', description: 'Preserve existing behavior.', verifierIds: ['node-test']}];
        const repair = await reviewedCandidate(f, {name: 'repair', modern: true, goal: attempt.goal, criteria, sessionId: run.ownerSessionId});
        const sealed = await sealNativeCandidate(f, repair, run);
        const finished = await finishWorktree(f.deps, {cwd: f.root, name: sealed.record.name, finalProof: repair.finalProof});
        const closed = await readFollowupProgress(f.commonDir, item.id);
        assert.equal(closed.status, 'resolved', JSON.stringify(finished.warnings));
        assert.equal(closed.resolutions.at(-1).commit, finished.mergedHead);
        assert.equal(closed.resolutions.at(-1).receipt.runId, attempt.runId);
        const shown = await cli(f.root, ['followup', 'show', item.id, '--json']);
        assert.equal(shown.envelope.data.progress.status, 'resolved');
        assert.deepEqual(shown.envelope.data.progress.resolutions, closed.resolutions, 'Ordinary CLI reconciliation preserves exact proof');
      } finally {if (previousHome === undefined) delete process.env.AGENT_OPS_HOME; else process.env.AGENT_OPS_HOME = previousHome;}
      assert.equal(await readFile(item.provenance.receiptPath, 'utf8'), original);
    });
  },
  'followup-bilingual-contract': async () => {
    const root = resolve('.');
    for (const lang of ['en', 'zh-TW']) {
      const spec = await readFile(join(root, `docs/${lang}/spec/acceptance-and-evidence.md`), 'utf8');
      assert.match(spec, /EVIDENCE-FOLLOWUP-001/);
      for (const token of ['PRESENT', 'ABSENT', 'UNKNOWN', 'followup-resolution', 'review-only', 'fail-open', 'Git common directory', 'SessionStart'])
        assert.ok(spec.includes(token), `${lang} normative contract covers ${token}`);
      const guide = await readFile(join(root, `docs/${lang}/guides/task-debug.md`), 'utf8');
      for (const action of ['list', 'show', 'import', 'sync', 'clarify', 'accept', 'defer', 'reopen', 'process'])
        assert.match(guide, new RegExp(`followup ${action}`), `${lang} guidance exposes ${action}`);
      assert.match(guide, /--review-only-reason/); assert.match(guide, /--reason/);
    }
    assert.match(await readFile(join(root, 'README.md'), 'utf8'), /agent-ops followup list/);
  }
};
