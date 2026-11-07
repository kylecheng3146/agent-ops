import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, readdir, rm, stat, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {digest, improves, parseProposal, parseSuite, scoreReply, type LearningSuite, type Proposal} from "../../runtime/src/learning/data.js";
import {FileLearningStore, matchingExperiences} from "../../runtime/src/learning/store.js";
import {runLearningTrial, replayLearningTrial, targetLearningCall, learningConditions, type LearningCall, type LearningTrial} from "../../runtime/src/learning/experiment.js";
import {runCriteriaReview} from "../../runtime/src/review/criteria.js";
import {parseArgs} from "../../packages/cli/src/args.js";
import type {AgentTask} from "../../runtime/src/contracts.js";
import type {ProcessRequest, VerificationProcessRunner} from "../../runtime/src/verify/spawn.js";

const settings = {target: "codex" as const, model: "fixture-model-1", effort: "high"};
const source = {receipt: "a".repeat(64), taskId: "task-source", commit: "b".repeat(40),
  evidence: {goal: "Delivered queue repair", diff: "queue changed", verification: ["PASS"], reviews: ["primary PASS", "adversarial PASS"]}};
const proposal: Proposal = {strategies: [{id: "retry-writes", paths: ["src/queue/**"], cue: "A write may be retried.",
  check: "Check retry deduplication."}], expectedImprovement: "Find omitted retry scenarios.", failureCondition: "No held-out improvement or additional false positives."};
const suiteData: LearningSuite = {schemaVersion: 1, cases: [
  {id: "probe-retry", split: "probe", snapshot: {originalGoal: "Add retry to queue", criteria: [{id: "behavior", description: "Sends data"}, {id: "regression", description: "Reads data"}]}, expected: ["redo"]},
  {id: "probe-complete", split: "probe", snapshot: {originalGoal: "Display queue total", criteria: [{id: "behavior", description: "Total is visible"}, {id: "regression", description: "Empty total is zero"}]}, expected: []},
  {id: "holdout-retry", split: "holdout", snapshot: {originalGoal: "Add retry to invoice delivery", criteria: [{id: "behavior", description: "Delivers invoice"}, {id: "regression", description: "Reports failure"}]}, expected: ["redo"]},
  {id: "holdout-complete", split: "holdout", snapshot: {originalGoal: "Format invoice date", criteria: [{id: "behavior", description: "Date uses requested format"}, {id: "regression", description: "Empty date is blank"}]}, expected: []}
]};
const suite: LearningSuite = {...suiteData, cases: suiteData.cases.map(c => ({...c, snapshot: {...c.snapshot,
  surface: {included: [{path: `src/queue/${c.id}.ts`}]}}}))};
const data = (prompt: string): Record<string, any> => JSON.parse(prompt.slice(prompt.lastIndexOf("BEGIN UNTRUSTED DATA\n") + 21, prompt.lastIndexOf("\nEND UNTRUSTED DATA")));
function fixtureCall(options: {fail?: boolean; noGain?: boolean; inconsistent?: boolean; leakCheck?: string[]} = {}): LearningCall {
  let evaluation = 0;
  const invoke: LearningCall = async prompt => {
    const input = data(prompt);
    if (!prompt.startsWith("Evaluate")) {
      options.leakCheck?.push(prompt);
      assert.doesNotMatch(prompt, /holdout-retry|holdout-complete|Format invoice date|Add retry to invoice delivery/);
    }
    if (options.fail) return {value: null, durationMs: 1, failure: "TARGET_FAILED"};
    if (prompt.startsWith("Propose")) return {value: {candidates: [proposal]}, durationMs: 1};
    if (prompt.startsWith("Compose")) return {value: proposal, durationMs: 1};
    evaluation++;
    return {durationMs: 1, usage: {totalTokens: 20}, value: {results: input.cases.map((c: any) => {
      const detects = !options.noGain && c.snapshot.experiences.length > 0 && c.snapshot.originalGoal.includes("retry") &&
        !(options.inconsistent && evaluation % 2 === 0);
      return {caseId: c.caseId, advice: {summary: "Fixture advisory", recommendations: detects ? [{criterionId: "behavior", issue: "Retry can duplicate delivery",
        recommendation: "Specify duplicate delivery behavior", reason: "A retry is possible"}] : [], limitations: []},
        omissions: detects ? [{dimension: "redo", recommendationIndex: 0}] : []};
    })}};
  };
  return async (prompt, schema) => ({...await invoke(prompt, schema), conditions: digest(learningConditions(settings, schema))});
}
async function fixture(check: (store: FileLearningStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "learning-test-"));
  try {await check(new FileLearningStore(root), root);} finally {await rm(root, {recursive: true, force: true});}
}
const trial = (store: FileLearningStore, call: LearningCall | null = fixtureCall()) => runLearningTrial({store, settings, source, suiteCommit: "c".repeat(40), suite, call});

test("paired learning replays, reserves independent tasks, revalidates composition and persists exact provenance", async () => {
  await fixture(async (store, root) => {
    const authoring: string[] = [], result = await trial(store, fixtureCall({leakCheck: authoring}));
    assert.equal(result.trial.status, "PASS"); assert.ok(result.adopted); assert.equal(result.trial.calls.length, 8);
    assert.equal(authoring.length, 2); assert.equal(result.trial.evaluations.length, 6);
    assert.deepEqual(replayLearningTrial(result.trial), {status: "PASS", reason: "HELDOUT_IMPROVEMENT"});
    const fresh = new FileLearningStore(root), loaded = await matchingExperiences(root, ["src/queue/send.ts"]);
    assert.equal(loaded.length, 1); assert.equal(loaded[0].revision, result.adopted); assert.deepEqual(loaded[0].source, {receipt: source.receipt, taskId: source.taskId, commit: source.commit});
    assert.deepEqual(await matchingExperiences(root, ["src/date.ts"]), []);
    assert.equal((await fresh.version(result.adopted!)).trial, result.artifact);
    if (process.platform !== "win32") assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    const saved = await store.artifact("trials", result.artifact) as LearningTrial;
    saved.evaluations[0].score.holdout.fn = 99;
    assert.equal(replayLearningTrial(saved).status, "NOT_RUN");
  });
});

test("no improvement, uncertain outputs, missing execution and failure retain baseline", async () => {
  for (const call of [fixtureCall({noGain: true}), fixtureCall({inconsistent: true}), fixtureCall({fail: true}), null]) {
    await fixture(async store => {
      const result = await trial(store, call);
      assert.notEqual(result.trial.status, "PASS"); assert.equal(result.adopted, null);
      assert.equal((await store.read()).active, null);
      assert.ok(await store.artifact("trials", result.artifact));
      if (call === null) {assert.equal(result.trial.status, "NOT_RUN"); assert.equal(result.trial.calls.length, 0);}
    });
  }
  assert.equal(improves({probe: {fp: 0, fn: 1}, holdout: {fp: 0, fn: 2}}, {probe: {fp: 0, fn: 0}, holdout: {fp: 1, fn: 0}}), false);
});

test("adoption cannot overwrite a concurrent revision; recovery preserves history and rejected versions cannot be restored", async () => {
  await fixture(async (store, root) => {
    const first = await trial(store), before = await store.read();
    await store.recover("retire", "Experience no longer fits current workflow");
    const stale = await store.adopt(before, {...(await store.version(first.adopted!)), previous: first.adopted});
    assert.equal(stale, null); assert.equal((await store.read()).active, null);
    await store.recover("rollback", "Restore previously proven revision", first.adopted!);
    assert.equal((await new FileLearningStore(root).read()).active, first.adopted);
    assert.equal((await store.read()).history.length, 3);
    await assert.rejects(store.recover("rollback", "Unknown version", "f".repeat(64)));
    await assert.rejects(store.recover("retire", " "));
  });
});

test("adopted experience reaches a subsequent advisory and records concrete model-reported use without changing task contract", async () => {
  await fixture(async (store, root) => {
    const adopted = (await trial(store)).adopted!;
    const task: AgentTask = {schemaVersion: 2, id: "task-next", title: "Queue retry", goal: "Add a retry", criteria: [
      {id: "behavior", description: "Sends queue item", verifierIds: ["unit"]}, {id: "regression", description: "Reads queue item", verifierIds: ["unit"]}],
      surface: {axes: {} as never, included: [{id: "queue", path: "src/queue/send.ts", behavior: "Retries delivery"}], excluded: [], unknown: [], contracts: [], valueChanges: [], scenarios: {}}};
    const original = JSON.stringify(task);
    async function* chunks(value: unknown) {yield Buffer.from(JSON.stringify(value));}
    const requests: ProcessRequest[] = [];
    const runner: VerificationProcessRunner = {start: request => {
      requests.push(request);
      return {pid: 123, stdout: chunks({summary: "Check repeated writes", recommendations: [{criterionId: "behavior", issue: "Retry may duplicate writes",
        recommendation: "Add an idempotency criterion", reason: `Use retry experience to cover redelivery [experience:retry-writes@${adopted}]`}], limitations: []}),
        stderr: chunks(""), completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => {}};
    }};
    const result = await runCriteriaReview({root, commonDir: root, task, target: "codex", runner});
    assert.equal(result.report.status, "COMPLETED"); assert.match(requests[0].stdin!, /retry-writes/);
    assert.equal((result.report.snapshot.experiences as any[])[0].revision, adopted);
    assert.equal(JSON.stringify(task), original);
    const files = await readdir(join(store.directory, "uses"));
    const usage = JSON.parse(await readFile(join(store.directory, "uses", files[0]), "utf8"));
    assert.equal(usage.modelReportedUses[0].recommendation.criterionId, "behavior");
    await assert.rejects(stat(join(root, ".agent-ops/tasks")), {code: "ENOENT"});
  });
});

test("learning data rejects policy overrides, duplicate cases, answer leakage and excessive proposals", async () => {
  assert.throws(() => parseProposal({...proposal, verify: "skip"}));
  assert.throws(() => parseProposal({...proposal, strategies: [{...proposal.strategies[0], paths: ["../secrets"]}]}));
  assert.throws(() => parseSuite({...suite, cases: [...suite.cases, {...suite.cases[0], id: "duplicate"}]}));
  assert.throws(() => scoreReply({results: []}, suite));
  await fixture(async store => {
    const result = await trial(store, async prompt => prompt.startsWith("Propose") ? {durationMs: 1, value: {candidates: [proposal, proposal, proposal]}} : fixtureCall()(prompt, {}));
    assert.equal(result.trial.status, "NOT_RUN"); assert.equal(result.adopted, null);
    const artifact = join(store.directory, "trials", result.artifact + ".json");
    await writeFile(artifact, "{}");
    await assert.rejects(store.artifact("trials", result.artifact));
  });
  await fixture(async (store, root) => {
    if (process.platform === "win32") return;
    await writeFile(join(root, "outside"), "{}");
    await store.archive("trials", {record: "token=private-value"});
    const path = join(store.directory, "trials", digest({record: "token=[REDACTED_VALUE]"}) + ".json");
    assert.doesNotMatch(await readFile(path, "utf8"), /private-value/);
    await symlink(join(root, "outside"), join(store.directory, "state.json"));
    await assert.rejects(store.read());
  });
});

test("learning target preserves fixed model, read-only flags and isolated executions; CLI accepts no grader or trust overrides", async () => {
  const requests: ProcessRequest[] = [];
  async function* empty() {yield Buffer.from("{}");}
  const runner: VerificationProcessRunner = {start: request => {requests.push(request); return {pid: 123, stdout: empty(), stderr: empty(),
    completion: Promise.resolve({exitCode: 0, signal: null}), terminateTree: async () => {}};}};
  const call = targetLearningCall(settings, runner);
  await call("baseline", {}); await call("candidate", {});
  assert.notEqual(requests[0].cwd, requests[1].cwd);
  for (const request of requests) {
    assert.ok(request.args.includes("read-only")); assert.ok(request.args.includes(settings.model));
    assert.equal(request.shell, false); assert.equal(request.replaceEnv, true);
    await assert.rejects(stat(request.cwd), {code: "ENOENT"});
  }
  assert.equal(parseArgs(["learn"]).learningAction, "list");
  assert.equal(parseArgs(["learn", "run", "--receipt", "receipt.json", "--suite", "suite.json", "--model", "model-1", "--no-execute"]).learningNoExecute, true);
  for (const option of ["--harness", "--yes", "--grader", "--trust", "--base", "--profile"])
    assert.throws(() => parseArgs(["learn", "run", "--receipt", "r", "--suite", "s", "--model", "model-1", option, "x"]));
});
