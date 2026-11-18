import assert from 'node:assert/strict';
import {execFileSync, spawn as nodeSpawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
// A missing capability module is an observable assertion failure on the baseline, not an infrastructure error.
const load = path => import(pathToFileURL(join(build, path)).href).catch(error => {
  if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes(join(build, path))) assert.fail(`${path} must be built`);
  throw error;
});
// A capability absent from the build is an observable assertion failure, not a module-load error.
async function qa(path, ...names) {
  const mod = await load(path).catch(() => ({}));
  for (const name of names) assert.equal(typeof mod[name], 'function', `${path} must export ${name}`);
  return mod;
}
const hash = value => createHash('sha256').update(value).digest('hex');
const at = '2026-11-13T00:00:00.000Z';
const goal = 'Users can rely on independent QA before delivery';
const task = {schemaVersion: 2, id: 'task-qa-root', title: 'QA root', goal, criteria: [
  {id: 'behavior', description: 'Observable behavior', verifierIds: ['tests']},
  {id: 'compatibility', description: 'Compatible readers', verifierIds: ['tests']}],
  qa: {schemaVersion: 1, required: true, policyHash: 'a'.repeat(64), enrolledAt: at, enrollment: 'new', late: false}};
const runners = [{id: 'qa-runner', command: 'node', args: ['{materials}'], cwd: '.', adapter: 'generic'}];
const scenarios = {initialState: {applies: true, behavior: 'Fresh enrolled task'}, redo: {na: 'No replay in this fixture'},
  timeBoundary: {na: 'No deadline'}, identitySwitch: {applies: true, behavior: 'Planner differs from developer'}, concurrency: {na: 'Single planner'}};
const binding = {runnerId: 'qa-runner', checkIds: ['happy'], redCheckIds: ['happy'], materials: [{path: 'tests/qa-independent/case.test.mjs', role: 'test'}]};
const planCases = () => [
  {id: 'case-happy', criterionIds: ['behavior'], surfaceIds: ['surface-a'], required: true, mode: 'behavioral', preconditions: ['Enrolled task'],
    actions: ['Run the CLI path'], expected: 'The user task completes', bindings: [binding]},
  {id: 'case-docs', criterionIds: ['compatibility'], surfaceIds: ['surface-a'], required: true, mode: 'nonmechanical', preconditions: [],
    actions: ['Read the guide'], expected: 'Guide is accurate', bindings: [], nonmechanicalReason: 'Prose accuracy needs judgment'}];
const planAnswer = (patch = {}) => ({cases: planCases(), scenarios,
  environment: [{name: 'macOS', required: true, status: 'available', evidence: ['Observed darwin in the clone']}], questions: [], ...patch});

async function fixture(check) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-qa-execution-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-ops-qa-outside-'));
  const git = (args, cwd = root) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'QA fixture']); git(['config', 'user.email', 'qa@example.invalid']);
    await writeFile(join(root, '.gitignore'), '.agent-ops/\n');
    await mkdir(join(root, 'tests'));
    await writeFile(join(root, 'source.txt'), 'baseline\n');
    await writeFile(join(root, 'tests/existing.test.mjs'), "import assert from 'node:assert/strict'; assert.equal(2, 2);\n");
    git(['add', '.']); git(['commit', '-qm', 'baseline']);
    const commit = git(['rev-parse', 'HEAD']).trim();
    const {taskContractHash} = await load('runtime/src/task/contract.js');
    const version = {taskId: task.id, goalHash: hash(goal), taskContractHash: taskContractHash(task), treeContractHash: 'b'.repeat(64),
      scopeHash: 'c'.repeat(64), policyHash: task.qa.policyHash, configHash: 'd'.repeat(64), candidateCommit: commit, sourceFingerprint: 'e'.repeat(64)};
    const {FileQaStore} = await load('runtime/src/qa/store.js');
    await check({root, outside, git, commit, version, store: new FileQaStore(join(root, '.git'))});
  } finally {
    await rm(root, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
}
/** Test-only planner transport: it answers like a read-only Claude envelope. Never a production plan. */
function fakePlanner(answer, exitCode = 0) {
  const requests = [];
  return {requests, runner: {start(request) {
    requests.push({...request, cloned: existsSync(join(request.cwd, 'source.txt')),
      remotes: execFileSync('git', ['remote'], {cwd: request.cwd, encoding: 'utf8'}).trim(), head: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: request.cwd, encoding: 'utf8'}).trim()});
    // Codex prints the bare final message; Claude and agy wrap it in a structured envelope.
    const body = JSON.stringify(request.command === 'codex' ? answer : {structured_output: answer, usage: {input_tokens: 5, output_tokens: 3}});
    return {pid: null, stdout: (async function* () {yield Buffer.from(body);})(), stderr: (async function* () {})(),
      completion: Promise.resolve({exitCode, signal: null}), terminateTree: async () => {}};
  }}};
}
const FAKE_HOST = `import {createInterface} from 'node:readline';
import {mkdirSync, writeFileSync} from 'node:fs';
const mode = process.argv[2];
createInterface({input: process.stdin}).on('line', line => {
  const text = JSON.parse(line).message.content[0].text;
  const generation = Number(/"generation":(\\d+)/u.exec(text)[1]);
  const plan = /"plan":"([a-f0-9]{64})"/u.exec(text)[1];
  const candidateCommit = /"candidateCommit":"([a-f0-9]{40,64})"/u.exec(text)[1];
  mkdirSync('tests/qa-independent', {recursive: true});
  writeFileSync('tests/qa-independent/partial.txt', 'diagnostic in progress\\n');
  if (mode === 'hang') return;
  writeFileSync('tests/qa-independent/case.test.mjs', "import assert from 'node:assert/strict'; assert.equal(1, 1);\\n");
  if (mode === 'mutate') writeFileSync('source.txt', 'QA changed the product\\n');
  mkdirSync('.agent-ops', {recursive: true});
  writeFileSync('.agent-ops/qa-author-response.json', JSON.stringify({schemaVersion: 1, generation: mode === 'stale' ? generation + 1 : generation, plan, candidateCommit,
    materials: [{path: 'tests/qa-independent/case.test.mjs', role: 'test', caseIds: ['case-happy']}], requestedEdits: [],
    observations: [{caseId: 'case-happy', notes: ['fake host observation only']}], questions: []}));
  console.log(JSON.stringify(mode === 'error' ? {type: 'result', subtype: 'error_during_execution'}
    : {type: 'result', subtype: 'success', usage: {input_tokens: 11, output_tokens: 7}, total_cost_usd: 0.002}));
});
`;
const alive = pid => {try {process.kill(pid, 0); return true;} catch (e) {return e.code !== 'ESRCH';}};
async function until(predicate) {
  for (let i = 0; i < 200; i++) {if (await predicate()) return; await new Promise(r => setTimeout(r, 50));}
  assert.fail('Condition was not reached');
}

export const executionChecks = {
  'qa-planning-continuation': () => fixture(async f => {
    const {runQaPlanning} = await qa('runtime/src/qa/planning.js', 'runQaPlanning');
    const base = {store: f.store, root: f.root, version: f.version, originalGoal: goal, tasks: [task], scope: 'full', timing: 'late',
      surfaceIds: ['surface-a'], runners, advisory: null, available: ['claude'], implementationHost: 'codex',
      implementationSessionId: 'developer-session', controllerId: 'controller'};
    const first = fakePlanner(planAnswer({questions: [{id: 'locale', prompt: 'Which locale?', required: true, criterionIds: ['behavior']}]}));
    const result = await runQaPlanning({...base, runner: first.runner});
    const request = first.requests[0], schema = JSON.parse(request.args[request.args.indexOf('--json-schema') + 1]);
    assert.deepEqual(schema.properties.cases.items.properties.criterionIds.items.enum, ['behavior', 'compatibility'], 'Only actual criterion ids are admitted');
    assert.deepEqual(schema.properties.cases.items.properties.surfaceIds.items.enum, ['surface-a']);
    assert.deepEqual(schema.properties.questions.items.properties.criterionIds.items.enum, ['behavior', 'compatibility']);
    const report = await f.store.put('report', {schemaVersion: 1, id: 'report-prior', version: f.version,
      attempt: {kind: 'attempt', digest: 'a'.repeat(64)}, createdAt: at, results: [{caseId: 'case-happy', status: 'UNKNOWN', executions: [],
        observations: ['Designated baseline check already PASS; candidate PASS is insufficient for behavioral proof.']}], findings: [], questions: []});
    const decision = await f.store.put('decision', {schemaVersion: 1, version: f.version, plan: result.plan, questionId: 'locale',
      answer: 'de-DE', answeredBy: 'human', answeredAt: at});
    const control = await f.store.readControl(task.id);
    await f.store.updateControl(task.id, control.revision, c => ({...c, revision: c.revision + 1, report, decisions: [decision]}));
    const next = fakePlanner(planAnswer());
    await runQaPlanning({...base, runner: next.runner});
    const data = JSON.parse(next.requests[0].stdin.split('BEGIN UNTRUSTED DATA\n')[1].split('\nEND UNTRUSTED DATA')[0]);
    assert.equal(data.history.report.reference.digest, report.digest);
    assert.match(data.history.report.results[0].observations[0], /baseline check already PASS/u);
    assert.equal(data.history.decisions[0].reference.digest, decision.digest);
    assert.deepEqual([data.history.decisions[0].plan, data.history.decisions[0].answer, data.history.decisions[0].answeredAt], [result.plan, 'de-DE', at]);
    assert.match(next.requests[0].stdin, /Historical.*not current proof/u);
    const secondReport = await f.store.put('report', {...await f.store.get({...report, kind: 'report'}), id: 'report-second',
      results: [{caseId: 'case-happy', status: 'FAIL', executions: [], observations: ['New failure must not hide the preceding baseline observation.']}]});
    const latest = await f.store.readControl(task.id);
    await f.store.updateControl(task.id, latest.revision, c => ({...c, revision: c.revision + 1, report: secondReport}));
    const third = fakePlanner(planAnswer()); await runQaPlanning({...base, runner: third.runner});
    const history = JSON.parse(third.requests[0].stdin.split('BEGIN UNTRUSTED DATA\n')[1].split('\nEND UNTRUSTED DATA')[0]).history;
    assert.equal(history.report.reference.digest, secondReport.digest);
    assert.equal(history.previousReports[0].reference.digest, report.digest, 'A subsequent controller report does not erase earlier failure context');
    assert.deepEqual(history.decisions.map(d => d.reference.digest), [decision.digest], 'Repeated control revisions do not duplicate a genuine answer');
    const invalid = planAnswer({cases: [{...planCases()[0], criterionIds: ['invented'], expected: 'token=sk-test-secret-value-12345678901234567890'}, planCases()[1]]});
    await assert.rejects(runQaPlanning({...base, runner: fakePlanner(invalid).runner}), {code: 'QA_PLAN_INVALID'});
    const files = await readdir(join(f.store.directory, 'planning-diagnostics'));
    const diagnostic = JSON.parse(await readFile(join(f.store.directory, 'planning-diagnostics', files.at(-1)), 'utf8'));
    assert.equal(diagnostic.version.taskId, task.id); assert.match(diagnostic.error, /outside the scoped tasks/u);
    assert.doesNotMatch(diagnostic.stdout, /sk-test-secret-value/u, 'Rejected raw answers are retained only after redaction');
    assert.ok(diagnostic.stdout.length > 0); assert.equal((await f.store.readControl(task.id)).state, 'blocked');
    await rename(join(f.store.directory, 'planning-diagnostics'), join(f.store.directory, 'retained-diagnostics'));
    await writeFile(join(f.store.directory, 'planning-diagnostics'), 'Fixture blocks diagnostic storage without deleting earlier failures.');
    await assert.rejects(runQaPlanning({...base, runner: fakePlanner(invalid).runner}), {code: 'QA_PLAN_DIAGNOSTIC_FAILED'});
    assert.equal((await f.store.readControl(task.id)).owner, null, 'A failed diagnostic write does not leave a live planning owner');
  }),
  'qa-independent-planning': () => fixture(async f => {
    const {runQaPlanning, QA_PLAN_SCHEMA} = await qa('runtime/src/qa/planning.js', 'runQaPlanning');
    const {selectQaHost} = await qa('runtime/src/qa/session.js', 'selectQaHost', 'qaSession');
    const reportPath = join(f.root, '.agent-ops/reviews/criteria-task-qa-root.json');
    await mkdir(join(f.root, '.agent-ops/reviews'), {recursive: true});
    const advice = {summary: 'Advisory summary', recommendations: [{criterionId: 'behavior', issue: 'Retry path omitted',
      recommendation: 'Exercise a retry after interruption', reason: 'Scenario redo applies'}], limitations: []};
    const report = {kind: 'criteria-advisory', taskId: task.id, status: 'COMPLETED', advice};
    await writeFile(reportPath, JSON.stringify(report));
    const advisory = {report, reportPath, stale: false, warnings: []};
    const base = {store: f.store, root: f.root, version: f.version, originalGoal: goal, tasks: [task], scope: 'full', timing: 'early',
      surfaceIds: ['surface-a'], runners, advisory, available: ['claude', 'codex', 'agy'], implementationHost: 'codex',
      implementationSessionId: 'developer-session', controllerId: 'controller'};
    const ok = fakePlanner(planAnswer());
    const result = await runQaPlanning({...base, runner: ok.runner});
    const [request] = ok.requests;
    assert.equal(request.command, 'claude', 'An alternate configured host plans when the developer host is known');
    assert.ok(request.args.includes('--permission-mode') && request.args[request.args.indexOf('--permission-mode') + 1] === 'plan', 'Planning is read-only');
    assert.ok(request.args.includes('--no-session-persistence'), 'Planning is a fresh, unpersisted session');
    assert.match(request.args[request.args.indexOf('--json-schema') + 1], /"cases"/u, 'Planning uses the QA plan response schema');
    assert.equal(request.args[request.args.indexOf('--add-dir') + 1], request.cwd);
    assert.notEqual(request.cwd, f.root, 'The planner inspects an isolated clone, never the delivery checkout');
    assert.equal(request.cloned, true, 'The clone is repository-aware: the candidate files are present');
    assert.equal(request.head, f.commit); assert.equal(request.remotes, '', 'The clone has no path back to the delivery repository');
    assert.equal(existsSync(request.cwd), false, 'The read-only planning clone is removed afterwards');
    assert.match(request.stdin, /BEGIN UNTRUSTED DATA/u); assert.match(request.stdin, /Exercise a retry after interruption/u, 'Advisory output is consumed as data');
    assert.ok(request.stdin.includes(goal), 'The original goal is bound into planning');
    assert.doesNotMatch(request.stdin, /developer-session/u, 'No developer conversation identity reaches the planner');
    assert.equal(result.state, 'plan-ready'); assert.deepEqual(result.blockers, []);
    assert.equal(result.usage.inputTokens, 5); assert.equal(result.usage.costUsd, null, 'Unreported cost stays UNKNOWN');
    const plan = await f.store.get(result.plan);
    assert.equal(plan.originalGoal, goal); assert.deepEqual(plan.taskIds, [task.id]); assert.equal(plan.timing, 'early');
    assert.deepEqual(plan.advisoryReferences, [{path: '.agent-ops/reviews/criteria-task-qa-root.json', digest: hash(await readFile(reportPath))}]);
    assert.deepEqual({host: plan.session.host, implementationHost: plan.session.implementationHost, writable: plan.session.writable, fallbackReason: plan.session.fallbackReason},
      {host: 'claude', implementationHost: 'codex', writable: false, fallbackReason: null});
    assert.notEqual(plan.session.sessionId, 'developer-session');
    assert.deepEqual(plan.cases.map(c => c.criterionIds).flat().sort(), ['behavior', 'compatibility'], 'Every criterion maps to a case');
    assert.deepEqual(plan.environment.find(e => e.name === 'runner:qa-runner'), {name: 'runner:qa-runner', required: true, status: 'available',
      evidence: ['Configured acceptance runner authorized by the repository trust record.']});
    let control = await f.store.readControl(task.id);
    assert.deepEqual({state: control.state, owner: control.owner, attestation: control.attestation, plan: control.plan},
      {state: 'plan-ready', owner: null, attestation: null, plan: result.plan}, 'A plan is never proof or an attestation');
    // Independence fallback is explicit, and agy may plan read-only.
    const same = fakePlanner(planAnswer());
    const fallback = await f.store.get((await runQaPlanning({...base, available: ['codex'], runner: same.runner})).plan);
    assert.equal(fallback.session.host, 'codex'); assert.match(fallback.session.fallbackReason, /fresh separate codex session/u);
    assert.match(selectQaHost({implementationHost: null, available: ['agy'], writable: false}).fallbackReason, /unknown/u);
    // Necessary but absent environment, unauthorized runners and genuine questions are blockers, not silent passes.
    const missing = await runQaPlanning({...base, runner: fakePlanner(planAnswer({environment: [{name: 'browser', required: true, status: 'missing', evidence: ['No authorized browser tool']}]})).runner});
    assert.equal(missing.state, 'blocked'); assert.deepEqual(missing.blockers, ['browser: missing']);
    assert.equal((await f.store.readControl(task.id)).state, 'blocked');
    const rogue = await runQaPlanning({...base, runner: fakePlanner(planAnswer({cases: [{...planCases()[0], bindings: [{...binding, runnerId: 'rogue'}]}, planCases()[1]]})).runner});
    assert.equal(rogue.state, 'blocked'); assert.deepEqual(rogue.blockers, ['runner:rogue: missing'], 'Unauthorized runners stay blocked');
    const asked = await runQaPlanning({...base, runner: fakePlanner(planAnswer({questions: [{id: 'scope-choice', prompt: 'Which locale is required?', required: true, criterionIds: ['behavior']}]})).runner});
    assert.equal(asked.state, 'awaiting-input'); assert.equal((await f.store.get(asked.plan)).questions[0].id, 'scope-choice');
    assert.equal(existsSync(join(f.store.directory, 'decision')), false, 'Planning never fabricates a human answer');
    control = await f.store.readControl(task.id);
    for (const [answer, code] of [[{...planAnswer(), verdict: 'PASS'}, 'QA_PLAN_INVALID'],
      [planAnswer({cases: [{...planCases()[0], criterionIds: ['invented']}, planCases()[1]]}), 'QA_PLAN_INVALID'],
      [planAnswer({cases: [planCases()[0]]}), 'QA_PLAN_INVALID'],
      [planAnswer({cases: [{...planCases()[0], surfaceIds: ['elsewhere']}, planCases()[1]]}), 'QA_PLAN_INVALID']]) {
      await assert.rejects(runQaPlanning({...base, runner: fakePlanner(answer).runner}), {code});
      const after = await f.store.readControl(task.id);
      assert.deepEqual({state: after.state, plan: after.plan, attestation: after.attestation}, {state: 'blocked', plan: control.plan, attestation: null});
    }
    // Live codex planners answered {applies:false, na}, which the schema admits; it is stored as {na}, and the prompt states the validator's rules.
    const planned = runQaPlanning({...base, runner: fakePlanner(planAnswer({scenarios: {...scenarios, redo: {applies: false, na: 'No replay'}}})).runner});
    await assert.doesNotReject(planned, 'A not-applicable scenario with applies false is a valid plan');
    const live = await planned;
    assert.equal(live.state, 'plan-ready'); assert.deepEqual((await f.store.get(live.plan)).scenarios.redo, {na: 'No replay'});
    const upgraded = runQaPlanning({...base, runner: fakePlanner(planAnswer({cases: [{...planCases()[0], mode: 'invariant'}, planCases()[1]]})).runner});
    await assert.doesNotReject(upgraded, 'An invariant case with red checks is planned as behavioral');
    assert.equal((await f.store.get((await upgraded).plan)).cases[0].mode, 'behavioral', 'Red checks keep the stricter baseline-red rule');
    await assert.rejects(runQaPlanning({...base, runner: fakePlanner(planAnswer({cases: [{...planCases()[0], bindings: [{...binding, redCheckIds: undefined}]}, planCases()[1]]})).runner}),
      {code: 'QA_PLAN_INVALID', message: /Case case-happy: Behavioral acceptance requires at least one designated red check/u}, 'A behavioral case without red checks is never weakened');
    assert.match(request.stdin, /redCheckIds at least one/u, 'Behavioral red checks are a stated rule, not a hidden rejection');
    assert.match(request.stdin, /not environment/u, 'QA-added material and the authoring checkout are not planned as environment');
    assert.match(request.stdin, /Controller-provided execution primitives are not planner environment/u);
    assert.match(request.stdin, /loopback bind, ephemeral ports, OS temp\/profile directories, and CDP transport/u);
    const unknownEnvironment = await runQaPlanning({...base, runner: fakePlanner(planAnswer({environment: [
      {name: 'external-browser', required: true, status: 'unknown', evidence: ['No installed browser observed']}]})).runner});
    assert.equal(unknownEnvironment.state, 'blocked', 'A genuinely unknown external requirement still blocks');
    // Live: planners without the baseline twice planned a behavior it already had as behavioral, leaving the case UNKNOWN.
    const baselined = fakePlanner(planAnswer());
    await runQaPlanning({...base, baselineCommit: 'a'.repeat(40), runner: baselined.runner});
    assert.ok(baselined.requests[0].stdin.includes(`"baselineCommit":"${'a'.repeat(40)}"`), 'The planner sees the immutable baseline red checks run against');
    assert.match(baselined.requests[0].stdin, /Behavior the baseline already has is an invariant case/u);
    assert.match(baselined.requests[0].stdin, /criterion.*baselineCommit.*cannot override QA/u, 'Separate task-verifier baselines cannot change the controller-owned QA baseline');
    await assert.rejects(runQaPlanning({...base, runner: fakePlanner(planAnswer(), 1).runner}), {code: 'QA_PLAN_NOT_RUN'});
    const none = await runQaPlanning({...base, advisory: null, runner: fakePlanner(planAnswer()).runner});
    assert.deepEqual((await f.store.get(none.plan)).advisoryReferences, []);
    assert.ok(QA_PLAN_SCHEMA.properties.cases && !('verdict' in QA_PLAN_SCHEMA.properties));
  }),
  'qa-owned-execution': () => fixture(async f => {
    const {runQaAuthor, qaAuthorHost, qaAuthorObjective} = await qa('runtime/src/qa/author.js', 'runQaAuthor', 'qaAuthorHost', 'qaAuthorObjective');
    const objective = qaAuthorObjective({taskId: task.id, generation: 1, plan: {kind: 'plan', digest: 'a'.repeat(64)}, candidateCommit: f.commit});
    assert.match(objective, /bindings may reference existing candidate files/u);
    assert.match(objective, /materials lists only NEW untracked files authored in this session/u);
    assert.match(objective, /If existing files already cover the plan, return materials:\[\]/u);
    const {claimQaControl, stopQa, selectQaHost, qaSession, configuredQaHosts} = await qa('runtime/src/qa/session.js', 'claimQaControl', 'stopQa', 'selectQaHost', 'qaSession', 'configuredQaHosts');
    const {reviewTargets, planReviewTargets} = await load('runtime/src/review/roles.js');
    const roles = {reviewRoles: [{role: 'independent-review', targets: ['agy']}, {role: 'implementation', targets: ['claude', 'agy']}]};
    const available = configuredQaHosts(roles);
    assert.deepEqual(available, ['agy', 'claude'], 'QA can use explicitly configured writable hosts outside the final review chain');
    assert.deepEqual(planReviewTargets(reviewTargets(roles, 'independent-review'), 'codex').targets, ['agy', 'agy'], 'Both formal rounds remain agy');
    assert.equal(selectQaHost({available, implementationHost: 'codex', writable: true}).host, 'claude');
    assert.deepEqual(configuredQaHosts({}), [], 'No installed but unconfigured host is enrolled');
    const {nativeProcessIdentity} = await load('runtime/src/run/transport.js');
    const script = join(f.outside, 'fake-native-host.mjs'); await writeFile(script, FAKE_HOST);
    const plan = await f.store.put('plan', {schemaVersion: 1, id: 'plan-1', version: f.version, originalGoal: goal, taskIds: [task.id], dependencyTaskIds: [],
      scope: 'full', session: {host: 'claude', sessionId: 'planner', implementationSessionId: 'developer-session', implementationHost: 'codex', writable: false, fallbackReason: null},
      createdAt: at, timing: 'early', advisoryReferences: [], cases: planCases(), scenarios, environment: [], questions: []});
    const calls = [];
    const host = mode => kind => qaAuthorHost(kind, (command, args, options) => {
      calls.push({command, args: [...args], env: options.env});
      return nodeSpawn(process.execPath, [script, mode], options);
    });
    let n = 0;
    const author = (mode, patch = {}) => runQaAuthor({store: f.store, root: f.root, version: f.version, plan, checkout: join(f.outside, `checkout-${++n}`),
      available: ['claude', 'codex', 'agy'], implementationHost: 'codex', implementationSessionId: 'developer-session', controllerId: 'controller', host: host(mode), ...patch});
    const result = await author('ok');
    // Live: the author got only the plan digest; the plan and human answers live in private state the clone cannot reach.
    const inputPath = join(f.outside, 'checkout-1/.agent-ops/qa-author-input.json');
    assert.equal(existsSync(inputPath), true, 'The controller writes the plan and recorded decisions into the isolated checkout');
    const input = JSON.parse(await readFile(inputPath, 'utf8'));
    assert.deepEqual({plan: input.plan, cases: input.cases.map(c => c.id), decisions: input.decisions},
      {plan: plan.digest, cases: (await f.store.get(plan)).cases.map(c => c.id), decisions: []});
    assert.equal(result.session.host, 'claude'); assert.equal(result.session.writable, true); assert.equal(result.session.fallbackReason, null);
    assert.notEqual(result.session.sessionId, 'developer-session');
    const [call] = calls;
    assert.equal(call.command, 'claude', 'Production command, never task-supplied argv');
    assert.ok(call.args.includes('--permission-mode') && !call.args.some(a => /dangerously|bypass/u.test(a)), 'Native permission mode and denials are preserved');
    assert.equal(call.env.AGENT_OPS_RUN_ID, undefined, 'QA authoring never starts a nested run'); assert.equal(call.env.AGENT_OPS_WORKER_ID, undefined);
    const registered = await f.store.readControlHistory(task.id, 2);
    assert.equal(registered.owner.session.sessionId, result.session.sessionId);
    assert.ok(Number.isSafeInteger(registered.owner.processId) && typeof registered.owner.processIdentity === 'string', 'Provisional process ownership is saved before any answer');
    assert.equal(registered.generation, 1);
    assert.equal(alive(registered.owner.processId), false, 'Output is accepted only after the writer is confirmed dead');
    assert.deepEqual({state: result.control.state, owner: result.control.owner, attestation: result.control.attestation}, {state: 'testing', owner: null, attestation: null});
    assert.deepEqual(result.usage, {inputTokens: 11, outputTokens: 7, totalTokens: 18, costUsd: 0.002});
    assert.deepEqual(result.inspected.materials.map(m => m.path), ['tests/qa-independent/case.test.mjs']);
    // Writable QA hosts are Claude/Codex; same-host fallback is annotated; a shared developer session is refused.
    assert.equal(selectQaHost({implementationHost: 'claude', available: ['claude', 'codex'], writable: true}).host, 'codex');
    assert.match(selectQaHost({implementationHost: 'claude', available: ['claude', 'agy'], writable: true}).fallbackReason, /fresh separate claude session/u);
    assert.throws(() => selectQaHost({implementationHost: 'claude', available: ['agy'], writable: true}), {code: 'QA_HOST_UNAVAILABLE'});
    assert.throws(() => qaSession({host: 'codex', fallbackReason: null}, {sessionId: 'same', implementationSessionId: 'same', implementationHost: 'claude', writable: true}), {code: 'QA_SESSION_SHARED'});
    // Stale output from another generation is rejected; the dirty checkout survives for diagnosis.
    await assert.rejects(author('stale'), e => e.code === 'QA_STALE_WRITER' && e.recoveryPaths.includes(join(f.outside, 'checkout-2')));
    assert.equal(existsSync(join(f.outside, 'checkout-2/tests/qa-independent/partial.txt')), true, 'Dirty diagnostics are preserved');
    assert.deepEqual(((c) => ({state: c.state, owner: c.owner}))(await f.store.readControl(task.id)), {state: 'blocked', owner: null});
    await assert.rejects(author('error'), {code: 'QA_AUTHOR_FAILED'});
    // A live or unidentified owner blocks takeover; user Stop confirms death and disables continuation.
    const sleeper = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'ignore'});
    const identity = await nativeProcessIdentity(sleeper.pid);
    let current = await f.store.readControl(task.id);
    const owner = {controllerId: 'other', session: {...result.session, sessionId: 'other-qa'}, processId: sleeper.pid, processIdentity: identity};
    current = await f.store.updateControl(task.id, current.revision, c => ({...c, revision: c.revision + 1, generation: c.generation + 1, state: 'testing', owner}));
    await assert.rejects(author('ok'), {code: 'QA_WRITER_LIVE'});
    assert.equal(alive(sleeper.pid), true, 'A rejected takeover never touches the live writer');
    const stopped = await stopQa(f.store, task.id, at);
    assert.deepEqual({state: stopped.state, continuation: stopped.continuation, owner: stopped.owner}, {state: 'stopped', continuation: false, owner: null});
    await until(() => !alive(sleeper.pid));
    await assert.rejects(author('ok'), {code: 'QA_CONTINUATION_DISABLED'}, 'Stop disables automatic continuation');
    current = await f.store.readControl(task.id);
    await f.store.updateControl(task.id, current.revision, c => ({...c, revision: c.revision + 1, generation: c.generation + 1, state: 'testing', continuation: true,
      owner: {...owner, processId: null, processIdentity: null}}));
    await assert.rejects(claimQaControl(f.store, {taskId: task.id, controllerId: 'controller', session: result.session, state: 'testing', explicit: true, now: at}),
      {code: 'QA_WRITER_UNIDENTIFIED'});
    await stopQa(f.store, task.id, at);
    // Controlled stop while the author runs: fenced, killed, rejected, and its partial work kept.
    const running = author('hang', {explicit: true});
    const partial = join(f.outside, `checkout-${n}/tests/qa-independent/partial.txt`);
    await until(async () => existsSync(partial) && (await f.store.readControl(task.id))?.owner?.processId != null);
    const pid = (await f.store.readControl(task.id)).owner.processId;
    const final = await stopQa(f.store, task.id, at);
    await assert.rejects(running, e => ['QA_AUTHOR_FAILED', 'QA_STALE_WRITER'].includes(e.code));
    assert.equal(alive(pid), false); assert.deepEqual({state: final.state, continuation: final.continuation}, {state: 'stopped', continuation: false});
    assert.equal((await f.store.readControl(task.id)).state, 'stopped', 'A stopped writer cannot overwrite the stop');
    assert.equal(existsSync(partial), true, 'Stop preserves the dirty QA checkout');
  }),
  'qa-material-isolation': () => fixture(async f => {
    const {inspectQaMaterials, importQaMaterials} = await qa('runtime/src/qa/materials.js', 'inspectQaMaterials', 'importQaMaterials');
    const {cloneQaCheckout} = await qa('runtime/src/qa/session.js', 'cloneQaCheckout');
    const {parseQaAuthorResponse, parseQaArtifact} = await load('runtime/src/qa/validate.js');
    assert.equal(typeof parseQaAuthorResponse, 'function', 'QA author responses need a strict parser');
    const response = materials => parseQaAuthorResponse({schemaVersion: 1, generation: 1, plan: 'f'.repeat(64), candidateCommit: f.commit,
      materials, requestedEdits: [{path: 'source.txt', reason: 'Expose a hook for QA'}], observations: [], questions: []});
    const checkout = join(f.outside, 'qa-checkout');
    await cloneQaCheckout(f.root, checkout, f.commit);
    await assert.rejects(cloneQaCheckout(f.root, checkout, f.commit), {code: 'QA_CHECKOUT_EXISTS'});
    const fresh = {path: 'tests/qa/new.test.mjs', role: 'test', caseIds: ['case-happy']};
    await mkdir(join(checkout, 'tests/qa'), {recursive: true});
    await writeFile(join(checkout, fresh.path), "import assert from 'node:assert/strict'; assert.ok(true);\n");
    const inspected = await inspectQaMaterials(checkout, f.commit, response([fresh]));
    assert.deepEqual(inspected.materials.map(m => [m.path, m.digest]), [[fresh.path, hash(await readFile(join(checkout, fresh.path)))]]);
    assert.deepEqual(inspected.requestedEdits, [{path: 'source.txt', reason: 'Expose a hook for QA'}], 'Existing-file needs go back to the developer');
    const reject = async (materials, path, reason) => {
      await assert.rejects(inspectQaMaterials(checkout, f.commit, response(materials)),
        e => e.code === 'QA_MATERIAL_REJECTED' && e.rejections.some(r => r.path === path && r.reason.includes(reason)) && e.recoveryPaths.includes(checkout));
    };
    for (const [path, reason] of [['src/product.mjs', 'not a test'], ['tests/package.json', 'dependency'], ['.agent-ops/config.json', 'unsafe'],
      ['../escape.test.mjs', 'unsafe'], ['tests/.claude/settings.json', 'policy'], ['tests/missing.test.mjs', 'missing'], ['tests/existing.test.mjs', 'not a new untracked']])
      await reject([{path, role: 'test', caseIds: ['case-happy']}], path, reason);
    await writeFile(join(f.outside, 'secret.txt'), 'outside\n');
    await symlink(join(f.outside, 'secret.txt'), join(checkout, 'tests/qa/link.test.mjs'));
    await reject([{path: 'tests/qa/link.test.mjs', role: 'test', caseIds: ['case-happy']}], 'tests/qa/link.test.mjs', 'not a regular file');
    await link(join(f.outside, 'secret.txt'), join(checkout, 'tests/qa/hard.test.mjs'));
    await reject([{path: 'tests/qa/hard.test.mjs', role: 'test', caseIds: ['case-happy']}], 'tests/qa/hard.test.mjs', 'hard link');
    await mkdir(join(f.outside, 'dir')); await writeFile(join(f.outside, 'dir/x.test.mjs'), 'outside\n');
    await symlink(join(f.outside, 'dir'), join(checkout, 'tests/linked'));
    await reject([{path: 'tests/linked/x.test.mjs', role: 'test', caseIds: ['case-happy']}], 'tests/linked/x.test.mjs', 'symlinked');
    for (const p of ['tests/qa/link.test.mjs', 'tests/qa/hard.test.mjs', 'tests/linked']) await unlink(join(checkout, p));
    // Product, configuration and old assertions are never QA's to change or delete.
    await writeFile(join(checkout, 'tests/existing.test.mjs'), "import assert from 'node:assert/strict'; assert.ok(true);\n");
    await reject([fresh], 'tests/existing.test.mjs', 'existing tracked file changed');
    execFileSync('git', ['checkout', '--', 'tests/existing.test.mjs'], {cwd: checkout});
    await rm(join(checkout, 'source.txt'));
    await reject([fresh], 'source.txt', 'existing tracked file changed');
    execFileSync('git', ['checkout', '--', 'source.txt'], {cwd: checkout});
    await assert.rejects(inspectQaMaterials(checkout, 'a'.repeat(40), response([fresh])), e => e.rejections.some(r => r.path === 'HEAD'), 'A stale candidate is rejected');
    for (const bad of [{verdict: 'PASS'}, {materials: [{...fresh, role: 'product'}]}, {generation: 0}, {materials: [fresh, fresh]}])
      assert.throws(() => parseQaAuthorResponse({schemaVersion: 1, generation: 1, plan: 'f'.repeat(64), candidateCommit: f.commit,
        materials: [fresh], requestedEdits: [], observations: [], questions: [], ...bad}), {code: 'QA_RESPONSE_INVALID'});
    // Import commits exactly the inspected bytes and names the new final candidate.
    const staged = join(f.root, 'staged.txt'); await writeFile(staged, 'unrelated\n'); f.git(['add', 'staged.txt']);
    await assert.rejects(importQaMaterials({checkout, target: f.root, inspected, taskId: task.id}), {code: 'QA_IMPORT_TARGET_DIRTY'});
    f.git(['reset', '-q', '--', 'staged.txt']); await rm(staged);
    await writeFile(join(checkout, fresh.path), 'changed after inspection\n');
    await assert.rejects(importQaMaterials({checkout, target: f.root, inspected, taskId: task.id}), {code: 'QA_MATERIAL_REJECTED'});
    await writeFile(join(checkout, fresh.path), "import assert from 'node:assert/strict'; assert.ok(true);\n");
    const imported = await importQaMaterials({checkout, target: f.root, inspected, taskId: task.id});
    const head = f.git(['rev-parse', 'HEAD']).trim();
    assert.deepEqual(imported.lineage, {authoredCommit: f.commit, importedCommit: head});
    assert.notEqual(head, f.commit, 'Imported material creates a new final candidate that must be re-executed');
    assert.equal(f.git(['diff', '--name-status', f.commit, head]).trim(), `A\t${fresh.path}`);
    assert.equal(hash(f.git(['show', `${head}:${fresh.path}`])), inspected.materials[0].digest);
    assert.equal(f.git(['show', '-s', '--format=%B', head]).includes(`QA-Authored-Commit: ${f.commit}`), true);
    await assert.rejects(importQaMaterials({checkout, target: f.root, inspected, taskId: task.id}), {code: 'QA_CANDIDATE_MOVED'}, 'A moved delivery makes the QA result stale');
    const session = {host: 'claude', sessionId: 'qa', implementationSessionId: 'developer', implementationHost: 'codex', writable: true, fallbackReason: null};
    const attempt = version => ({schemaVersion: 1, id: 'attempt-1', version, generation: 1, plan: {kind: 'plan', digest: 'f'.repeat(64)}, session,
      startedAt: at, finishedAt: at, materials: imported.materials, materialDigest: imported.materialDigest, executions: [],
      usage: {inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null}, lineage: imported.lineage});
    assert.equal(parseQaArtifact('attempt', attempt({...f.version, candidateCommit: head})).lineage.importedCommit, head);
    assert.throws(() => parseQaArtifact('attempt', attempt(f.version)), {code: 'QA_ARTIFACT_INVALID'}, 'Pre-import proof cannot describe the final candidate');
    assert.throws(() => parseQaArtifact('attempt', {...attempt({...f.version, candidateCommit: head}), lineage: {authoredCommit: head, importedCommit: head}}),
      {code: 'QA_ARTIFACT_INVALID'}, 'Imported material always moves the candidate');
  })
};
