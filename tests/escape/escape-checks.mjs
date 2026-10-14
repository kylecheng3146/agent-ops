import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Escape Loop R1 acceptance on synthetic repositories. Modules load lazily so a
// build without the escape loop fails each check as an assertion, never as a crash.
const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const load = async path => {
  try {return await import(pathToFileURL(join(build, path)).href);}
  catch (e) {assert.fail(`${path} is unavailable: ${e.code ?? e.message}`);}
};
const need = (module, ...names) => {
  for (const name of names) assert.equal(typeof module[name], 'function', `${name} is not implemented`);
  return module;
};
const link = async (...names) => need(await load('runtime/src/escape/link.js'), ...names);

const runner = root => ({run: async args => {
  try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']})};}
  catch (e) {return {exitCode: e.status ?? 1, stdout: e.stdout ?? Buffer.alloc(0)};}
}});
async function repo(files) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-escape-')));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const write = async (path, content) => {await mkdir(dirname(join(root, path)), {recursive: true}); await writeFile(join(root, path), content);};
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Escape fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false');
  await write('.gitignore', '.agent-ops/\n');
  for (const [path, content] of Object.entries(files)) await write(path, content);
  git('add', '-A'); git('commit', '-qm', 'base');
  const commit = async (changes, message = 'change') => {
    for (const [path, content] of Object.entries(changes)) await write(path, content);
    git('add', '-A'); git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  return {root, git, write, commit, base: git('rev-parse', 'HEAD'), runner: runner(root), commonDir: join(root, '.git')};
}
async function withRepo(files, check) {
  const fixture = await repo(files);
  try {return await check(fixture);} finally {await rm(fixture.root, {recursive: true, force: true});}
}
/** A synthetic local finish receipt, written where finish writes them. */
async function receipt(f, {target, candidate, schemaVersion = 2, surface, residualRisks = [], session = 'session-a'}) {
  const {sha256} = await load('runtime/src/fs/hash.js');
  const {writePrivateFile} = await load('runtime/src/security/permissions.js');
  const {receiptRange} = await link('receiptRange');
  const id = `${sha256(session)}-${candidate}`;
  await writePrivateFile(join(f.commonDir, 'agent-ops', 'receipts', `${id}.json`), JSON.stringify({schemaVersion, sessionId: session,
    candidateHead: candidate, targetCommit: target, ...(schemaVersion === 2 ? await receiptRange(f.runner, target, candidate) : {}),
    sourceFingerprint: 'f'.repeat(64), reviewMode: 'tree',
    tasks: [{task: {schemaVersion: 2, id: 'task-gated', title: 'Gated change', criteria: [], ...(surface === undefined ? {} : {surface})}}],
    children: [], verification: {}, reviews: {}, residualRisks, createdAt: '2026-10-14T00:00:00.000Z'}), f.commonDir);
  return id;
}

const NA = reason => ({na: reason});
const SCENARIOS = {initialState: NA('Fixture has no persisted state to start from.'), redo: NA('Fixture operations are never retried.'),
  timeBoundary: NA('Fixture has no dates, TTLs or timezones.'), identitySwitch: NA('Fixture has no stores, roles or tenants.'),
  concurrency: NA('Fixture runs one writer at a time.')};
const audit = ({included, excluded = [], duplicates}) => ({
  axes: {dependents: NA('Fixture pages import nothing.'), duplicates: {queries: duplicates}, otherPaths: NA('Fixture has one route per page.'),
    sharedState: NA('Fixture pages keep no shared state.')},
  included: included.map(([id, path]) => ({id, path, behavior: `${path} shows the changed size.`})),
  excluded: excluded.map(([glob, reason]) => ({glob, reason})), unknown: [], contracts: [], valueChanges: [], scenarios: SCENARIOS});
const PAGE = (name, size) => `export function ${name}() {\n  return <img className="product-image-size" src={${size}} />;\n}\n`;
const PAGES = {'src/pages/ProductPage.tsx': PAGE('ProductPage', 'SMALL'), 'src/pages/ComboPage.tsx': PAGE('ComboPage', 'SMALL'),
  'src/pages/PackPage.tsx': PAGE('PackPage', 'SMALL'), 'src/pages/AboutPage.tsx': 'export function AboutPage() {\n  return <p>About</p>;\n}\n'};

const CRITERIA = [{id: 'behavior', description: 'The behavior holds.', verifierIds: ['unit']},
  {id: 'regression', description: 'Nothing else broke.', verifierIds: ['unit']}];
const CONFIG = {schemaVersion: 3, profiles: ['core'], verification: {commands: [
  {id: 'unit', command: 'node', args: ['--test'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}]},
features: {completionGate: {enabled: false}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};
const ADVISORY = {...CONFIG, profiles: ['core', 'advisory']};

async function tasksFor(f, config = CONFIG, prefix = 'task') {
  const {TaskService} = await load('runtime/src/task/service.js');
  const {FileTaskStore} = await load('runtime/src/task/store.js');
  let next = 0;
  return new TaskService(new FileTaskStore(join(f.root, '.agent-ops/tasks/state.json'), f.root),
    {generateId: () => `${prefix}-${++next}`, completion: {root: f.root, gitRunner: f.runner, loadConfig: async () => config}});
}
async function cli(f, service) {
  const {parseArgs} = await load('packages/cli/src/args.js');
  const {runTaskCommand} = await load('packages/cli/src/commands/task.js');
  const file = async (name, value) => {const path = join(f.root, '.agent-ops', name); await mkdir(dirname(path), {recursive: true}); await writeFile(path, JSON.stringify(value)); return path;};
  return {parseArgs, file, run: async argv => runTaskCommand({args: parseArgs(argv), service})};
}

/** A real review command over a committed fix; execute is the reviewer stub. */
async function reviewer(f, tasks, config) {
  const {parseArgs} = await load('packages/cli/src/args.js');
  const {runReviewCommand} = await load('packages/cli/src/commands/review.js');
  const {calculateConfigHash} = await load('runtime/src/config/hash.js');
  const {buildVerificationEvidence, FileEvidenceStore} = await load('runtime/src/verify/evidence.js');
  const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js');
  const {collectBaseChangePaths} = await load('runtime/src/verify/change-surface.js');
  const {taskContractHash} = await load('runtime/src/task/contract.js');
  const evidenceStore = new FileEvidenceStore(f.root, f.root);
  const policyConfigHash = calculateConfigHash(config);
  const evidence = async (taskId, base) => {
    const record = await tasks.status({taskId});
    const fingerprint = await calculateSourceFingerprint(f.root, {mode: 'base', baseRef: base, resolvedBase: base,
      changedFiles: await collectBaseChangePaths(f.runner, base)}, f.runner);
    const saved = {};
    for (const criterion of record.task.criteria) saved[criterion.id] = [await evidenceStore.save(buildVerificationEvidence({
      taskId, criterionId: criterion.id, command: config.verification.commands[0], scope: 'project',
      startedAt: '2026-10-14T00:00:00.000Z', finishedAt: '2026-10-14T00:00:01.000Z', exitCode: 0, testCount: 1, status: 'PASS',
      failureClass: 'none', sourceFingerprint: fingerprint, toolVersions: {}, config, taskContractHash: taskContractHash(record.task)}))];
    return {record, saved, fingerprint};
  };
  const verified = async (taskId, base) => {const {saved} = await evidence(taskId, base); await tasks.recordEvidence(taskId, saved);};
  const review = (taskId, base, execute) => runReviewCommand({args: parseArgs(['review', '--task', taskId, '--yes', '--rerun', '--base', base]),
    authorized: true, targets: ['codex', 'agy'], tasks, taskId, root: f.root, gitRunner: f.runner, config, policyConfigHash, evidenceStore, execute});
  return {verified, review, evidence, policyConfigHash};
}
function verdict(request, failed = []) {
  const criteria = request.invocation.packet.criteria;
  const report = {summary: 'Escape review.', results: criteria.map(c => ({criterionId: c.id, status: failed.includes(c.id) ? 'FAIL' : 'PASS',
    summary: `Reviewed ${c.id}.`, evidence: [`inspected ${c.id}`]})),
  findings: failed.length === 0 ? [] : [{severity: 'important', blocking: true, title: 'Mislabelled escape.', details: 'The label is wrong.',
    locations: [], evidence: ['facts'], recommendation: 'Relabel.', criterionIds: failed}],
  residualRisks: [], changedFilesInspected: request.invocation.packet.artifactRefs, supportingFilesInspected: []};
  const targets = request.invocation.plannedTargets ?? [request.invocation.harness, request.invocation.harness];
  return {status: failed.length === 0 ? 'PASS' : 'FAIL', harness: targets[0], results: report.results.map(({criterionId, status, evidence}) => ({criterionId, status, evidence})),
    report, plannedTargets: targets, sessionIsolation: 'fresh', attempts: targets.map((target, i) => ({target, status: 'PASS', sessionId: `escape-${i}`})),
    adversarial: {target: targets[1], refuted: false, report}};
}
async function withHome(check) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-escape-home-')));
  const previous = process.env.AGENT_OPS_HOME;
  process.env.AGENT_OPS_HOME = home;
  const events = async () => {
    try {return (await readFile(join(home, '.agent-ops/state/logs/events.ndjson'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));}
    catch (e) {if (e.code === 'ENOENT') return []; throw e;}
  };
  try {return await check({home, catches: async () => (await events()).filter(e => e.type === 'gate-catch')});}
  finally {if (previous === undefined) delete process.env.AGENT_OPS_HOME; else process.env.AGENT_OPS_HOME = previous; await rm(home, {recursive: true, force: true});}
}

/** A plain worktree finish of a two-commit change: the real receipt writer. */
async function finished(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-escape-finish-')));
  try {
    const {finishWorktree} = await load('runtime/src/parallel/finish.js');
    const {addWorktree} = await load('runtime/src/parallel/service.js');
    const {CompletionGateService} = await load('runtime/src/hooks/completion-gate.js');
    const {TaskService} = await load('runtime/src/task/service.js');
    const {FileTaskStore} = await load('runtime/src/task/store.js');
    const {calculateConfigHash} = await load('runtime/src/config/hash.js');
    const {buildVerificationEvidence, FileEvidenceStore} = await load('runtime/src/verify/evidence.js');
    const {calculateSourceFingerprint} = await load('runtime/src/verify/source-fingerprint.js');
    const {collectBaseChangePaths} = await load('runtime/src/verify/change-surface.js');
    const {reviewReportDigest, saveReviewAttestation, saveReviewReportArtifact} = await load('runtime/src/review/attestation.js');
    const config = {...CONFIG, profiles: ['core', 'loop'], verification: {commands: [{id: 'node-test', command: 'node', args: ['--test'], cwd: '.', required: true, evidence: {kind: 'exit-code'}}]},
      features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}};
    const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    const write = async (base, path, content) => {await mkdir(dirname(join(base, path)), {recursive: true}); await writeFile(join(base, path), content);};
    git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'core.autocrlf', 'false');
    await write(root, '.gitignore', '.agent-ops/\n'); await write(root, 'source.txt', 'base\n'); await write(root, 'CLAUDE.md', 'rules\n');
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
    await write(root, '.agent-ops/config.json', JSON.stringify(config));
    await write(root, '.agent-ops/CLAUDE.md', 'managed rules\n');
    await write(root, '.agent-ops/manifest.json', JSON.stringify({schemaVersion: 2, scope: 'project', harness: ['claude'],
      artifacts: [{id: 'config', path: '.agent-ops/config.json', hash: 'a'.repeat(64), owner: 'agent-ops'},
        {id: 'claude-rules', path: '.agent-ops/CLAUDE.md', hash: 'b'.repeat(64), owner: 'agent-ops'}],
      markers: [{id: 'claude-routing', path: 'CLAUDE.md', hash: 'c'.repeat(64), owner: 'agent-ops', startMarker: '<!-- start -->', endMarker: '<!-- end -->'}]}));
    const loadConfig = async () => config;
    const gitDep = async (cwd, args) => {
      try {return {exitCode: 0, stdout: execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}), stderr: ''};}
      catch (e) {return {exitCode: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '')};}
    };
    const gateFor = cwd => new CompletionGateService({root: cwd, config, gitRunner: runner(cwd),
      taskService: new TaskService(new FileTaskStore(join(cwd, '.agent-ops/tasks/state.json'), cwd), {completion: {root: cwd, gitRunner: runner(cwd), loadConfig}}),
      evidenceStore: new FileEvidenceStore(cwd, cwd), forRoot: async other => gateFor(other)});
    const deps = {git: gitDep, loadConfig, trust: {status: async () => 'TRUSTED', grant: async () => {}, revoke: async () => {}},
      gate: async cwd => gateFor(cwd), runSetup: async () => ({exitCode: 0, output: ''}), now: () => '2026-10-14T00:00:00.000Z',
      tasks: (cwd, completionBase) => new TaskService(new FileTaskStore(join(cwd, '.agent-ops/tasks/state.json'), cwd),
        completionBase === undefined ? {} : {completion: {root: cwd, gitRunner: runner(cwd), base: completionBase, loadConfig}}),
      processRunner: {start: () => ({pid: 1, stdout: (async function* () {})(), stderr: (async function* () {})(),
        completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => undefined})}};
    const {record} = await addWorktree(deps, {cwd: root, name: 'alpha', sessionId: 'session-alpha'});
    await write(record.path, 'alpha.txt', 'alpha work\n'); git(record.path, 'add', '-A'); git(record.path, 'commit', '-qm', 'alpha one');
    await write(record.path, 'source.txt', 'base\nalpha\n'); git(record.path, 'add', '-A'); git(record.path, 'commit', '-qm', 'alpha two');
    const commits = git(record.path, 'rev-list', '--reverse', `${record.base}..HEAD`).split('\n');
    const worktreeGit = runner(record.path);
    const fingerprint = await calculateSourceFingerprint(record.path, {mode: 'base', baseRef: record.base, resolvedBase: record.base,
      changedFiles: await collectBaseChangePaths(worktreeGit, record.base)}, worktreeGit);
    const tasks = new TaskService(new FileTaskStore(join(record.path, '.agent-ops/tasks/state.json'), record.path));
    const task = await tasks.create({title: 'Change alpha', criteria: [
      {id: 'behavior', description: 'The behavior holds.', verifierIds: ['node-test']},
      {id: 'regression', description: 'Nothing else broke.', verifierIds: ['node-test']}], policyConfigHash: calculateConfigHash(config), sessionId: record.sessionId});
    const evidence = new FileEvidenceStore(record.path, record.path);
    const references = {};
    for (const criterion of task.task.criteria) references[criterion.id] = [await evidence.save(buildVerificationEvidence({
      taskId: task.task.id, criterionId: criterion.id, command: config.verification.commands[0], scope: 'project',
      startedAt: '2026-10-14T00:00:00Z', finishedAt: '2026-10-14T00:00:01Z', exitCode: 0, testCount: 1, status: 'PASS',
      failureClass: 'none', sourceFingerprint: fingerprint, toolVersions: {}, config}))];
    const round = summary => ({summary, results: [{criterionId: 'change-quality', status: 'PASS', summary, evidence: ['fixture']}],
      findings: [], residualRisks: [`${summary} risk`], changedFilesInspected: ['alpha.txt', 'source.txt'], supportingFilesInspected: []});
    const primary = round('primary'), adversarial = round('adversarial');
    await saveReviewReportArtifact(record.path, {status: 'PASS', harness: 'codex', model: 'fixture', effort: 'fixture', prompt: 'fixture',
      plannedTargets: ['codex', 'agy'], sourceFingerprint: fingerprint, sessionIsolation: 'fresh',
      attempts: [{target: 'codex', status: 'PASS', sessionId: 'p'}, {target: 'agy', status: 'PASS', sessionId: 'a'}], preflight: [],
      report: primary, adversarial: {target: 'agy', refuted: false, report: adversarial}}, fingerprint, task.task.id);
    await saveReviewAttestation(record.path, {schemaVersion: 2, taskId: task.task.id, harness: 'codex', status: 'PASS', sourceFingerprint: fingerprint,
      reviewTargets: ['codex', 'agy'], reviewSessionIds: ['p', 'a'], sessionIsolation: 'fresh', primaryReportDigest: reviewReportDigest(primary),
      adversarialReportDigest: reviewReportDigest(adversarial), reportArtifact: `.agent-ops/reviews/${fingerprint}.${task.task.id}.reports.json`,
      createdAt: '2026-10-14T00:00:00.000Z'});
    await tasks.recordEvidence(task.task.id, references, record.base);
    const result = await finishWorktree(deps, {cwd: root, name: 'alpha'});
    assert.ok(result.receipt, `plain finish wrote no receipt: ${JSON.stringify(result.warnings)}`);
    return await check({root, deps, git, commits, base: record.base, result, commonDir: join(root, '.git'),
      receipt: JSON.parse(await readFile(result.receipt, 'utf8'))});
  } finally {await rm(root, {recursive: true, force: true});}
}

const raw = {
  'escape-receipt-v2': () => finished(async ({root, deps, git, commits, base, result, commonDir, receipt}) => {
    const {readFinishedReview} = await load('packages/cli/src/commands/review-show.js');
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(commits.length, 2);
    assert.deepEqual(receipt.commits, commits, 'every commit in target..candidate, oldest first');
    assert.equal(receipt.targetCommit, base);
    assert.deepEqual(receipt.fileFingerprints.map(f => f.path), ['alpha.txt', 'source.txt']);
    for (const f of receipt.fileFingerprints) assert.match(f.digest, /^[a-f0-9]{64}$/u);
    assert.notEqual(receipt.fileFingerprints[0].digest, receipt.fileFingerprints[1].digest);
    // review show accepts the v2 receipt bound by the finish note.
    const view = await readFinishedReview(deps, root, commonDir, result.receipt);
    assert.equal(view.candidateHead, receipt.candidateHead);
    assert.equal(git(root, 'cat-file', '-t', receipt.candidateHead), 'commit');
  }),

  'escape-receipt-v1-compat': async () => {
    await finished(async ({root, deps, git, commonDir, receipt, result}) => {
      const {readFinishedReview} = await load('packages/cli/src/commands/review-show.js');
      const {sha256} = await load('runtime/src/fs/hash.js');
      const {writePrivateFile} = await load('runtime/src/security/permissions.js');
      const {loadReceipts} = await link('loadReceipts');
      // The same proof written by a release before schema 2 still reads.
      const {commits: _c, fileFingerprints: _f, ...rest} = receipt;
      const v1 = {...rest, schemaVersion: 1};
      const path = join(dirname(result.receipt), `${sha256('session-legacy')}-${receipt.candidateHead}.json`);
      const content = `${JSON.stringify(v1, null, 2)}\n`;
      await writePrivateFile(path, content, commonDir);
      await writeFile(join(root, '.agent-ops', 'note.txt'), `legacy\nreceipt: ${path}\nreceipt-sha256: ${sha256(content)}\n`);
      git(root, 'notes', '--ref=agent-ops', 'add', '-f', '-F', join(root, '.agent-ops', 'note.txt'), receipt.candidateHead);
      assert.equal((await readFinishedReview(deps, root, commonDir, path)).candidateHead, receipt.candidateHead);
      const loaded = await loadReceipts(commonDir);
      assert.deepEqual(loaded.map(r => r.receipt.schemaVersion).sort(), [1, 2]);
    });
    await withRepo({'src/a.txt': 'alpha\n', 'src/b.txt': 'beta\n'}, async f => {
      const {loadReceipts, resolveEscape} = await link('loadReceipts', 'resolveEscape');
      const a = await f.commit({'src/a.txt': 'alpha 2\n'});
      const b = await f.commit({'src/b.txt': 'beta 2\n'});
      const v1 = await receipt(f, {target: f.base, candidate: b, schemaVersion: 1});
      const receipts = await loadReceipts(f.commonDir);
      assert.deepEqual(receipts.map(r => [r.id, r.receipt.schemaVersion]), [[v1, 1]]);
      assert.deepEqual(await resolveEscape(f.runner, receipts, b), {state: 'gated', receipt: v1, matchedBy: 'head'});
      // A v1 receipt has no range or fingerprints: only its exact head links.
      assert.deepEqual(await resolveEscape(f.runner, receipts, a), {state: 'ungated'});
    });
  },

  'escape-squash-fingerprint': () => withRepo({'src/a.txt': 'alpha\n', 'src/b.txt': 'beta\n', 'src/c.txt': 'gamma\n'}, async f => {
    const {fileFingerprints, loadReceipts, resolveEscape} = await link('fileFingerprints', 'loadReceipts', 'resolveEscape');
    f.git('checkout', '-q', '-b', 'feature');
    const one = await f.commit({'src/a.txt': 'alpha\nfixed\n'}, 'feature one');
    const two = await f.commit({'src/b.txt': 'beta\nfixed\n'}, 'feature two');
    const id = await receipt(f, {target: f.base, candidate: two});
    f.git('checkout', '-q', 'main');
    await f.commit({'src/c.txt': 'gamma\nmain moved\n'}, 'main moved on');
    f.git('merge', '--squash', '-q', 'feature'); f.git('commit', '-qm', 'squash feature');
    const squash = f.git('rev-parse', 'HEAD');
    // The squash commit has a different parent, yet the same per-file diffs.
    const own = await fileFingerprints(f.runner, `${squash}^`, squash);
    const range = await fileFingerprints(f.runner, f.base, two);
    assert.deepEqual(own, range);
    const receipts = await loadReceipts(f.commonDir);
    assert.deepEqual(await resolveEscape(f.runner, receipts, squash), {state: 'gated', receipt: id, matchedBy: 'fingerprint'});
    assert.deepEqual(await resolveEscape(f.runner, receipts, one), {state: 'gated', receipt: id, matchedBy: 'range'});
    const unrelated = await f.commit({'src/c.txt': 'gamma\nunrelated\n'}, 'unrelated');
    assert.deepEqual(await resolveEscape(f.runner, receipts, unrelated), {state: 'ungated'});
  }),

  'escape-origin-required': async () => {
    const {fixture} = await import('../debug/acceptance-helper.mjs');
    const {parseArgs} = await load('packages/cli/src/args.js');
    const {runTaskCommand} = await load('packages/cli/src/commands/task.js');
    const {taskContractHash, goalHash} = await load('runtime/src/task/contract.js');
    const {saveReviewReportArtifact, saveReviewAttestation, reviewReportDigest} = await load('runtime/src/review/attestation.js');
    const {acceptanceCoverage, coverageDigest} = await load('runtime/src/verify/acceptance-coverage.js');
    const {FileEvidenceStore} = await load('runtime/src/verify/evidence.js');
    const {debugProofDigest} = await load('runtime/src/task/debug-state.js');
    const hypothesis = {id: 'cause', statement: 'Original value is zero', method: 'Execute original issue assertion',
      expected: 'Baseline assertion fails', checkId: 'issue', expectedStatus: 'FAIL'};
    const reviewed = async (f, report) => {
      const stored = await f.tasks.status({taskId: f.record.task.id}), id = stored.task.id, fingerprint = report.sourceFingerprint;
      const coverage = await acceptanceCoverage(stored, f.config, fingerprint, new FileEvidenceStore(f.root, f.root));
      const binding = {taskContractHash: taskContractHash(stored.task), taskContracts: {[id]: taskContractHash(stored.task)},
        goalHash: goalHash(stored.task), candidateCommit: f.git('rev-parse', 'HEAD').toString().trim(), coverageDigest: coverageDigest(coverage),
        debugProofs: {[id]: debugProofDigest((await f.tasks.debugService().root(id)).debug)}};
      const round = summary => ({summary, results: stored.task.criteria.map(c => ({criterionId: c.id, status: 'PASS', summary, evidence: ['paired references']})),
        findings: [], residualRisks: [], changedFilesInspected: ['product.mjs'], supportingFilesInspected: []});
      const result = {status: 'PASS', harness: 'codex', model: 'fixture', effort: 'fixture', prompt: 'fixture', plannedTargets: ['codex', 'agy'],
        sourceFingerprint: fingerprint, sessionIsolation: 'fresh', attempts: [{target: 'codex', status: 'PASS', sessionId: 'p'}, {target: 'agy', status: 'PASS', sessionId: 'a'}],
        preflight: [], report: round('primary'), adversarial: {target: 'agy', refuted: false, report: round('adversarial')}};
      const artifact = await saveReviewReportArtifact(f.root, result, fingerprint, id, undefined, binding, coverage);
      await saveReviewAttestation(f.root, {schemaVersion: 3, taskId: id, harness: 'codex', status: 'PASS', sourceFingerprint: fingerprint,
        reviewTargets: ['codex', 'agy'], reviewSessionIds: ['p', 'a'], sessionIsolation: 'fresh', primaryReportDigest: reviewReportDigest(result.report),
        adversarialReportDigest: reviewReportDigest(result.adversarial.report), reportArtifact: artifact, createdAt: new Date().toISOString(), ...binding});
      return stored;
    };
    const f = await fixture();
    try {
      const id = f.record.task.id, d = f.tasks.debugService();
      assert.equal(f.record.task.originRequired, true, 'a new DEBUG root must require an origin');
      need(d, 'origin');
      await f.candidate();
      let report = await f.verify(); assert.equal(report.status, 'PASS');
      await assert.rejects(d.origin(id, {kind: 'external', reason: 'Upstream changed the default value.'}), {code: 'ESCAPE_ORIGIN_EARLY'});
      let reference = report.acceptance.find(r => r.criterionId === 'issue' && r.phase === 'baseline').reference;
      await d.hypothesis(id, {...hypothesis, reference});
      const current = await f.tasks.status({taskId: id});
      await assert.rejects(f.tasks.revise(id, {expectedContractHash: taskContractHash(current.task), reason: 'Skip the debug gate.',
        origin: {kind: 'external', reason: 'Upstream changed the default value.'}}), {code: 'ESCAPE_ORIGIN_DEBUG_ACTION'});
      let stored = await reviewed(f, report);
      await assert.rejects(f.tasks.complete(id, stored.evidence), e => e.code === 'TASK_COMPLETION_ESCAPE_ORIGIN_MISSING');
      const payload = join(f.root, '.agent-ops', 'origin.json');
      // R2: a criteria escape names the red-to-green check that proves it.
      await writeFile(payload, JSON.stringify({kind: 'escape-of', commit: f.baseline.slice(0, 12), label: 'criteria', promote: 'regression:issue'}));
      const declared = await runTaskCommand({args: parseArgs(['task', 'debug', '--task', id, '--debug-action', 'origin', '--payload-file', payload]), service: f.tasks});
      assert.equal(declared.code, 'TASK_DEBUG_ORIGIN_DECLARED', JSON.stringify(declared.errors));
      assert.deepEqual(declared.data.record.task.origin, {kind: 'escape-of', commit: f.baseline, label: 'criteria', promote: 'regression:issue'});
      assert.equal(declared.data.record.task.contractRevision, (current.task.contractRevision ?? 0) + 1);
      assert.notEqual(taskContractHash(declared.data.record.task), taskContractHash(current.task));
      assert.ok(existsSync(join(f.root, '.agent-ops-escapes', `${id}.json`)), 'escape-of writes its ledger record');
      f.git('add', '-A'); f.git('commit', '-qm', 'escape ledger');
      report = await f.verify(); assert.equal(report.status, 'PASS');
      reference = report.acceptance.find(r => r.criterionId === 'issue' && r.phase === 'baseline').reference;
      await d.hypothesis(id, {...hypothesis, reference});
      stored = await reviewed(f, report);
      assert.equal((await f.tasks.complete(id, stored.evidence)).status, 'complete');
    } finally {await f.close();}
  },

  'escape-origin-contract': async () => {
    const {taskContractHash} = await load('runtime/src/task/contract.js');
    const {validateTask} = await load('runtime/src/schema/validate.js');
    const plain = {schemaVersion: 2, id: 'task-fixed', title: 'Fixed', intent: 'Keep the hash.', criteria: [
      {id: 'a', description: 'A holds.', verifierIds: ['unit']}, {id: 'b', description: 'B holds.', verifierIds: ['unit']}]};
    // Tasks without an origin keep the hash they had before the Escape Loop.
    assert.equal(taskContractHash(plain), 'd1b03bf5fb94f43e0871ced59c2634533bd3582c3df88a7d31aec9913828d03a');
    const origin = {kind: 'escape-of', commit: 'a'.repeat(40), label: 'surface'};
    assert.equal(validateTask({...plain, origin}).ok, true, 'escape-of origin is a valid task field');
    const bound = taskContractHash({...plain, origin});
    assert.notEqual(bound, taskContractHash(plain));
    assert.notEqual(bound, taskContractHash({...plain, origin: {...origin, label: 'review'}}));
    for (const bad of [{kind: 'escape-of', commit: 'HEAD', label: 'surface'}, {...origin, label: 'luck'}, {kind: 'external', reason: 'n/a'},
      {kind: 'pre-existing'}, {...origin, receipt: '../x'}])
      assert.equal(validateTask({...plain, origin: bad}).ok, false, JSON.stringify(bad));
    await withRepo(PAGES, async f => {
      const escaped = await f.commit({'src/pages/ProductPage.tsx': PAGE('ProductPage', 'LARGE')}, 'escaped');
      const service = await tasksFor(f);
      const {file, run, parseArgs} = await cli(f, service);
      assert.throws(() => parseArgs(['task', 'create', '--title', 'Fix', '--escape-of', escaped]), {code: 'CLI_MISSING_VALUE'});
      assert.throws(() => parseArgs(['task', 'status', '--escape-of', escaped, '--escape-label', 'surface']), {code: 'CLI_OPTION_NOT_ALLOWED'});
      const surface = await file('surface.json', audit({included: [['product', 'src/pages/ProductPage.tsx']], duplicates: ['product-image-size']}));
      const create = (...extra) => run(['task', 'create', '--title', 'Fix combo size', ...CRITERIA.flatMap(c => ['--criterion', JSON.stringify(c)]),
        '--surface-file', surface, ...extra]);
      const wrong = await create('--escape-of', escaped, '--escape-label', 'luck');
      assert.equal(wrong.code, 'ESCAPE_ORIGIN_INVALID');
      const created = await create('--escape-of', escaped.slice(0, 10), '--escape-label', 'surface');
      assert.equal(created.code, 'TASK_CREATED', JSON.stringify(created.errors));
      assert.deepEqual(created.data.record.task.origin, {kind: 'escape-of', commit: escaped, label: 'surface'});
      assert.match(created.data.text, new RegExp(`Escape of ${escaped}: ungated`, 'u'));
      assert.ok(existsSync(join(f.root, '.agent-ops-escapes', `${created.data.record.task.id}.json`)));
    });
  },

  'escape-blame-hints': () => withRepo({'src/price.ts': 'one\ntwo\nthree\n'}, async f => {
    const {blameHints} = await link('blameHints');
    const wrote = await f.commit({'src/price.ts': 'one\nTWO\nthree\n'}, 'escaped');
    const base = await f.commit({'src/other.ts': 'other\n'}, 'later');
    await f.write('src/price.ts', 'one\nfixed\nthree\n');
    assert.deepEqual(await blameHints(f.runner, base), [{commit: wrote, lines: 1}]);
    // A pure addition has no author to blame: an omission bug.
    await f.write('src/price.ts', 'one\nTWO\nthree\nfour\n');
    assert.deepEqual(await blameHints(f.runner, base), []);
    await f.write('src/price.ts', 'one\nfixed\nthree\n');
    const service = await tasksFor(f);
    const {taskContractHash} = await load('runtime/src/task/contract.js');
    const task = await service.create({title: 'Fix price', criteria: CRITERIA, policyConfigHash: 'a'.repeat(64)});
    const {run} = await cli(f, service);
    const revised = await run(['task', 'revise', '--task', task.task.id, '--expected-contract', taskContractHash(task.task),
      '--reason', 'Declare the escaped commit.', '--escape-of', wrote, '--escape-label', 'criteria']);
    assert.equal(revised.code, 'TASK_REVISED', JSON.stringify(revised.errors));
    assert.ok(revised.data.text.includes(`Blame hints (a hint only): ${wrote.slice(0, 12)} (1 line)`), revised.data.text);
    assert.equal(revised.data.record.task.origin.commit, wrote);
    // Re-declaring the same origin refreshes the record without another contract revision.
    const again = await run(['task', 'revise', '--task', task.task.id, '--expected-contract', taskContractHash(revised.data.record.task),
      '--reason', 'Refresh the escape record.', '--escape-of', wrote, '--escape-label', 'criteria']);
    assert.equal(again.data.record.task.contractRevision, revised.data.record.task.contractRevision);
  }),

  'escape-link-states': () => withRepo({'src/a.txt': 'alpha\n', 'src/b.txt': 'beta\n'}, async f => {
    const {loadReceipts, resolveEscape, assessEscape} = await link('loadReceipts', 'resolveEscape', 'assessEscape');
    const gatedCommit = await f.commit({'src/a.txt': 'alpha 2\n'});
    const id = await receipt(f, {target: f.base, candidate: gatedCommit, residualRisks: ['b.txt may need the same change.']});
    const noted = await f.commit({'src/b.txt': 'beta 2\n'}, 'finished elsewhere');
    f.git('notes', '--ref=agent-ops', 'add', '-m', 'receipt: /elsewhere/agent-ops/receipts/missing.json', noted);
    const plain = await f.commit({'src/b.txt': 'beta 3\n'}, 'never gated');
    let receipts = await loadReceipts(f.commonDir);
    assert.deepEqual(await resolveEscape(f.runner, receipts, gatedCommit), {state: 'gated', receipt: id, matchedBy: 'range'});
    assert.deepEqual(await resolveEscape(f.runner, receipts, plain, id), {state: 'gated', receipt: id, matchedBy: 'override'});
    const missing = `${'0'.repeat(64)}-${plain}`;
    assert.deepEqual(await resolveEscape(f.runner, receipts, plain, missing), {state: 'unresolved', reason: 'receipt-not-local', receipt: missing});
    assert.deepEqual(await resolveEscape(f.runner, receipts, noted), {state: 'unresolved', reason: 'receipt-not-local'});
    assert.deepEqual(await resolveEscape(f.runner, receipts, plain), {state: 'ungated'});
    // Two receipts with the same per-file diff cannot be told apart.
    f.git('checkout', '-q', '-b', 'twin', f.base);
    const twin = await f.commit({'src/a.txt': 'alpha 2\n'}, 'twin');
    await receipt(f, {target: f.base, candidate: twin, session: 'session-b'});
    f.git('checkout', '-q', '-b', 'replay', f.base);
    const replayed = await f.commit({'src/a.txt': 'alpha 2\n'}, 'replayed');
    receipts = await loadReceipts(f.commonDir);
    assert.deepEqual(await resolveEscape(f.runner, receipts, replayed), {state: 'unresolved', reason: 'ambiguous-receipt'});
    // The assessment carries the linked receipt's residual risks.
    const assessed = await assessEscape({root: f.root, git: f.runner, origin: {kind: 'escape-of', commit: gatedCommit, label: 'review'}, base: plain});
    assert.deepEqual(assessed.link, {state: 'gated', receipt: id, matchedBy: 'range'});
    assert.deepEqual(assessed.residualRisks, ['b.txt may need the same change.']);
  }),

  'escape-surface-replay': () => withRepo(PAGES, async f => {
    const {assessEscape} = await link('assessEscape');
    const escaped = await f.commit({'src/pages/ProductPage.tsx': PAGE('ProductPage', 'LARGE')}, 'escaped');
    const surface = audit({included: [['product', 'src/pages/ProductPage.tsx']], duplicates: ['product-image-size'],
      excluded: [['src/pages/ComboPage.tsx', 'Combo pages render a fixed placeholder image that never changes size.']]});
    await receipt(f, {target: f.base, candidate: escaped, surface});
    const origin = label => ({kind: 'escape-of', commit: escaped, label});
    const assess = async (change, label) => {
      await f.write(change, PAGE('Fixed', 'LARGE'));
      const result = await assessEscape({root: f.root, git: f.runner, origin: origin(label), base: escaped});
      f.git('checkout', '-q', '--', '.'); f.git('clean', '-qfd', 'src');
      return result;
    };
    const excluded = await assess('src/pages/ComboPage.tsx', 'review');
    assert.deepEqual(excluded.facts, [{path: 'src/pages/ComboPage.tsx', surface: 'excluded'}]);
    assert.equal(excluded.label, 'surface-excluded', 'replay overrides a later agent label');
    assert.equal(excluded.agentLabel, 'review');
    // PackPage is hit by the recorded query; AboutPage is outside every query: unseen.
    const hit = await assess('src/pages/PackPage.tsx', 'scenario');
    assert.deepEqual(hit.facts, [{path: 'src/pages/PackPage.tsx', surface: 'hit'}]);
    assert.equal(hit.label, 'scenario');
    const unseen = await assess('src/pages/AboutPage.tsx', 'verify');
    assert.deepEqual(unseen.facts, [{path: 'src/pages/AboutPage.tsx', surface: 'unseen'}]);
    assert.equal(unseen.label, 'surface-unseen');
    assert.equal((await assess('src/pages/AboutPage.tsx', 'requirement')).label, 'requirement', 'requirement is the only earlier gate');
    const included = await assess('src/pages/ProductPage.tsx', 'criteria');
    assert.deepEqual([included.facts[0].surface, included.label], ['included', 'criteria']);
    const created = await assess('src/pages/NewPage.tsx', 'review');
    assert.deepEqual([created.facts[0].surface, created.label], ['absent', 'review']);
    assert.deepEqual(created.missedPaths, ['src/pages/NewPage.tsx']);
  }),

  'escape-review-packet': () => withRepo(PAGES, async f => {
    const {buildAdversarialPrompt, buildReviewPrompt} = await load('runtime/src/review/runner.js');
    const escaped = await f.commit({'src/pages/ProductPage.tsx': PAGE('ProductPage', 'LARGE')}, 'escaped');
    const surface = audit({included: [['product', 'src/pages/ProductPage.tsx']], duplicates: ['product-image-size'],
      excluded: [['src/pages/ComboPage.tsx', 'Combo pages render a fixed placeholder image that never changes size.']]});
    const id = await receipt(f, {target: f.base, candidate: escaped, surface, residualRisks: ['Combo page may still render the old size.']});
    const tasks = await tasksFor(f);
    need(tasks, 'declareEscape');
    const task = await tasks.create({title: 'Fix combo size', criteria: CRITERIA, policyConfigHash: (await reviewer(f, tasks, CONFIG)).policyConfigHash,
      origin: {kind: 'escape-of', commit: escaped, label: 'review'}});
    await f.write('src/pages/ComboPage.tsx', PAGE('ComboPage', 'LARGE'));
    await tasks.declareEscape(task.task.id);
    f.git('add', '-A'); f.git('commit', '-qm', 'fix combo size');
    const {verified, review} = await reviewer(f, tasks, CONFIG);
    await verified(task.task.id, escaped);
    let seen;
    const passed = await review(task.task.id, escaped, async request => {seen = request; return verdict(request);});
    assert.equal(passed.data.result.status, 'PASS', JSON.stringify(passed.data.result.reason));
    const [row] = seen.invocation.packet.escape;
    assert.deepEqual(row.link, {state: 'gated', receipt: id, matchedBy: 'range'});
    assert.deepEqual([row.agentLabel, row.label], ['review', 'surface-excluded']);
    assert.deepEqual(row.facts, [{path: 'src/pages/ComboPage.tsx', surface: 'excluded'}]);
    assert.deepEqual(row.residualRisks, ['Combo page may still render the old size.']);
    assert.equal(row.recordCurrent, true);
    assert.ok(seen.invocation.packet.criteria.some(c => c.id === 'escape-label'));
    const primary = buildReviewPrompt(seen.invocation);
    const challenge = buildAdversarialPrompt(seen.invocation, verdict(seen).report);
    for (const prompt of [primary, challenge]) {
      assert.match(prompt, /Escape origin: task data `escape`/u);
      assert.ok(prompt.includes('Combo page may still render the old size.') && prompt.includes('surface-excluded'));
    }
    assert.match(primary, /Round 1: check the label/u);
    assert.match(challenge, /Round 2: re-derive the label independently/u);
  }),

  'escape-ledger': () => withRepo(PAGES, async f => {
    const {declareEscape, LEDGER_DIRECTORY} = await link('declareEscape');
    const escaped = await f.commit({'src/pages/ProductPage.tsx': PAGE('ProductPage', 'LARGE')}, 'escaped');
    await f.write('src/pages/ComboPage.tsx', PAGE('ComboPage', 'LARGE /* secret-ish body */'));
    const declare = (taskId, label) => declareEscape({root: f.root, git: f.runner, taskId, base: escaped, now: '2026-10-14T00:00:00.000Z',
      origin: {kind: 'escape-of', commit: escaped, label}});
    const first = await declare('task-one', 'review');
    assert.equal(LEDGER_DIRECTORY, '.agent-ops-escapes');
    assert.equal(first.path, join(f.root, '.agent-ops-escapes', 'task-one.json'));
    const stored = JSON.parse(await readFile(first.path, 'utf8'));
    assert.deepEqual(Object.keys(stored).sort(), ['agentLabel', 'declaredAt', 'escapeOf', 'facts', 'label', 'link', 'missedPaths', 'proof', 'residualRisks', 'schemaVersion', 'taskId']);
    assert.deepEqual([stored.taskId, stored.escapeOf, stored.link.state, stored.label, stored.residualRisks], ['task-one', escaped, 'ungated', 'review', 0]);
    assert.deepEqual(stored.missedPaths, ['src/pages/ComboPage.tsx']);
    assert.doesNotMatch(await readFile(first.path, 'utf8'), /secret-ish body|<img/u, 'data only, never file contents');
    // Re-declaring replaces the task's single record; another task gets its own file.
    await declare('task-one', 'surface');
    await declare('task-two', 'verify');
    assert.equal(JSON.parse(await readFile(first.path, 'utf8')).label, 'surface');
    assert.deepEqual(f.git('status', '--porcelain', '--untracked-files=all', '--', '.agent-ops-escapes').split('\n').sort(),
      ['?? .agent-ops-escapes/task-one.json', '?? .agent-ops-escapes/task-two.json'], 'the ledger is trackable, not ignored');
    // A checked-in symlink cannot redirect the ledger outside the worktree.
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-escape-outside-')));
    try {
      f.git('rm', '-rq', '--cached', '--ignore-unmatch', '.agent-ops-escapes'); await rm(join(f.root, '.agent-ops-escapes'), {recursive: true, force: true});
      await symlink(outside, join(f.root, '.agent-ops-escapes'), 'junction');
      await assert.rejects(declare('task-three', 'review'), {code: 'ESCAPE_LEDGER_UNSAFE'});
      assert.equal(existsSync(join(outside, 'task-three.json')), false);
    } finally {await rm(outside, {recursive: true, force: true});}
  }),

  'escape-catch-events': () => withHome(async ({home, catches}) => {
    const {logGateCatch} = need(await load('runtime/src/logging/local-log.js'), 'logGateCatch');
    const {createFailureFingerprint} = await load('runtime/src/verify/fingerprint.js');
    await withRepo(PAGES, async f => {
      await f.commit({'src/pages/ProductPage.tsx': PAGE('ProductPage', 'LARGE')}, 'change');
      const tasks = await tasksFor(f, ADVISORY);
      const {verified, review, evidence, policyConfigHash} = await reviewer(f, tasks, ADVISORY);
      // A surface block is caught before any reviewer runs.
      const blocked = await tasks.create({title: 'Blocked', criteria: CRITERIA, policyConfigHash, requireSurface: true,
        surface: audit({included: [['product', 'src/pages/ProductPage.tsx']], duplicates: ['product-image-size']})});
      await verified(blocked.task.id, f.base);
      const notRun = await review(blocked.task.id, f.base, async () => {throw new Error('blocked review must not start');});
      assert.equal(notRun.code, 'SURFACE_UNCLASSIFIED');
      // A failing review is caught.
      const failing = await tasks.create({title: 'Failing', criteria: CRITERIA, policyConfigHash});
      await verified(failing.task.id, f.base);
      const failed = await review(failing.task.id, f.base, async request => verdict(request, ['behavior']));
      assert.equal(failed.data.result.status, 'FAIL');
      // A recorded red verification turning green is caught.
      const fixing = await tasks.create({title: 'Fixing', criteria: CRITERIA, policyConfigHash});
      await tasks.recordFailure(fixing.task.id, createFailureFingerprint({commandId: 'unit', failureClass: 'assertion-failed', exitCategory: 'nonzero', diagnostics: 'red'}));
      const {record, saved, fingerprint} = await evidence(fixing.task.id, f.base);
      await tasks.recordVerificationEvidence(record, saved, fingerprint);
      assert.equal((await tasks.status({taskId: fixing.task.id})).failureFingerprint, null);
      const events = await catches();
      assert.deepEqual(events.map(({code, taskId}) => [code, taskId]),
        [['SURFACE_UNCLASSIFIED', blocked.task.id], ['REVIEW_FAIL', failing.task.id], ['VERIFY_RED_GREEN', fixing.task.id]]);
      for (const event of events) assert.deepEqual(Object.keys(event).sort(), ['code', 'taskId', 'timestamp', 'type'], 'code and task id only');
      // Without the advisory profile nothing is logged.
      const quiet = await tasksFor(f, CONFIG, 'quiet');
      const {verified: quietVerified, review: quietReview} = await reviewer(f, quiet, CONFIG);
      const other = await quiet.create({title: 'Quiet', criteria: CRITERIA, policyConfigHash: (await reviewer(f, quiet, CONFIG)).policyConfigHash});
      await quietVerified(other.task.id, f.base);
      assert.equal((await quietReview(other.task.id, f.base, async request => verdict(request, ['behavior']))).data.result.status, 'FAIL');
      assert.equal((await catches()).length, 3);
    });
    // A logging fault never changes the outcome: it fails open.
    await writeFile(join(home, 'blocker'), 'not a directory');
    assert.equal(await logGateCatch('REVIEW_FAIL', 'task-x', join(home, 'blocker')), undefined);
  }),

  'escape-spec-docs': async () => {
    const section = (text, id) => {
      const source = text.replace(/\r\n/gu, '\n');
      const start = source.indexOf(`## ${id}\n`);
      assert.ok(start >= 0, `missing ${id}`);
      const end = source.indexOf('\n## ', start + 1);
      return source.slice(start, end < 0 ? undefined : end);
    };
    for (const lang of ['en', 'zh-TW']) {
      const rule = section(await readFile(join('docs', lang, 'spec', 'acceptance-and-evidence.md'), 'utf8'), 'EVIDENCE-ESCAPE-001');
      for (const token of ['--debug-action origin', 'escape-of', 'pre-existing', 'external', 'ESCAPE_ORIGIN_MISSING', 'ESCAPE_ORIGIN_EARLY',
        '--escape-of', '--escape-label', '--escape-receipt', 'gated', 'unresolved', 'ungated', 'receipt-not-local', 'requirement', 'surface',
        'scenario', 'criteria', 'verify', 'review', 'flagged', 'out-of-model', 'surface-excluded', 'surface-unseen', 'git grep -F',
        '.agent-ops-escapes', 'gate-catch', 'escape-label', 'R2'])
        assert.ok(rule.includes(token), `${lang} EVIDENCE-ESCAPE-001 lacks ${token}`);
    }
    const {harnessDescriptor, managedRules} = await load('runtime/src/install/harness.js');
    for (const id of ['claude', 'codex', 'agy', 'opencode']) {
      const rules = managedRules(harnessDescriptor(id), {scope: 'project', profiles: ['core'], capabilities: ['rules', 'task', 'task-debug']});
      for (const token of ['--debug-action origin', 'ESCAPE_ORIGIN_MISSING', '.agent-ops-escapes', '--escape-of'])
        assert.ok(rules.includes(token), `${id} managed DEBUG text lacks ${token}`);
    }
  }
};

/** Missing behavior surfaces as a failed assertion, so the baseline is red, not broken. */
export const escapeChecks = Object.fromEntries(Object.entries(raw).map(([id, check]) => [id, async () => {
  try {await check();}
  catch (e) {
    if (e?.code === 'ERR_ASSERTION') throw e;
    throw new assert.AssertionError({message: `${id}: ${e?.code ?? ''} ${e?.stack ?? e}`});
  }
}]));
