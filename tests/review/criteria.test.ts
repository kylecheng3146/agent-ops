import assert from "node:assert/strict";
import {mkdtemp, rm, stat, readdir, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import test from "node:test";
import type {AgentTask} from "../../runtime/src/contracts.js";
import {runCriteriaReview, readCriteriaReview, criteriaSnapshot, criteriaReviewPrompt, renderCriteriaReview, revisionReviewDue, validateCriteriaAdvice} from "../../runtime/src/review/criteria.js";
import {AgentOpsError} from "../../runtime/src/fs/paths.js";
import {taskContractHash} from "../../runtime/src/task/contract.js";
import type {ProcessRequest, VerificationProcessRunner} from "../../runtime/src/verify/spawn.js";
import {findReviewAttestation} from "../../runtime/src/review/attestation.js";
import {TaskService} from "../../runtime/src/task/service.js";
import {FileTaskStore} from "../../runtime/src/task/store.js";
import {runTaskCommand} from "../../packages/cli/src/commands/task.js";
import {parseArgs} from "../../packages/cli/src/args.js";
import {appendLocalLog, readLocalLog} from "../../runtime/src/logging/local-log.js";
import {localStatePaths} from "../../runtime/src/security/permissions.js";

const task: AgentTask = {schemaVersion: 2, id: "task-advice", title: "Not the original goal", goal: "Deliver original behavior", intent: "Assigned behavior",
  criteria: [{id: "behavior", description: "Observable behavior", verifierIds: ["unit"]}, {id: "regression", description: "No regression", verifierIds: ["unit"]}]};
const advice = {summary: "Consider a boundary scenario", recommendations: [{criterionId: "behavior", issue: "Missing empty input", recommendation: "Add empty input behavior", reason: "Users can submit nothing"}], limitations: ["Binding imports deferred until implementation"]};
async function* chunks(text = ""): AsyncIterable<Uint8Array> {yield Buffer.from(text);}
function runner(requests: ProcessRequest[], result: unknown = advice, exitCode = 0): VerificationProcessRunner {
  return {start: request => {requests.push(request); return {pid: 123, stdout: chunks(JSON.stringify(result)), stderr: chunks(),
    completion: Promise.resolve({exitCode, signal: null}), terminateTree: async () => {}};}};
}
async function fixture(): Promise<string> {return await mkdtemp(join(tmpdir(), "criteria-test-"));}

test("one data-only round, private provenance, safe log, no final evidence and cache survives revision", async () => {
  const root = await fixture(), requests: ProcessRequest[] = [];
  try {
    const state = localStatePaths(root);
    const log = async (report: Awaited<ReturnType<typeof runCriteriaReview>>["report"], path: string) => {
      await appendLocalLog(join(state.logDirectory, "events.ndjson"), {type: "criteria-review", taskId: task.id,
        attemptId: report.attemptId, status: report.status, code: report.code, durationMs: report.durationMs,
        invocations: report.invocations, recommendations: report.advice?.recommendations.length ?? 0, report: path, usage: {}}, {anchorDirectory: state.anchorDirectory});
    };
    const first = await runCriteriaReview({root, task, target: "codex", runner: runner(requests), log});
    assert.equal(first.report.status, "COMPLETED"); assert.equal(first.report.invocations, 1);
    assert.deepEqual(first.report.advice, advice); assert.equal(requests.length, 1);
    assert.notEqual(requests[0]!.cwd, root);
    await assert.rejects(stat(requests[0]!.cwd), {code: "ENOENT"});
    assert.ok(requests[0]!.args.includes("--ignore-rules"));
    assert.ok(!requests[0]!.args.includes(root)); assert.equal(requests[0]!.replaceEnv, true);
    assert.match(requests[0]!.stdin!, /Do not inspect files/);
    if (process.platform !== "win32") {
      assert.equal((await stat(first.reportPath)).mode & 0o777, 0o600);
    }
    const revised = {...task, criteria: task.criteria.map(c => ({...c, description: c.description + " changed"}))};
    const cached = await runCriteriaReview({root, task: revised, target: "codex", runner: runner(requests)});
    assert.equal(requests.length, 1); assert.equal(cached.stale, true);
    assert.match(renderCriteriaReview(cached), /historical snapshot/);
    assert.equal((await readCriteriaReview(root, revised))!.stale, true);
    const rerun = await runCriteriaReview({root, task: revised, target: "codex", runner: runner(requests), rerun: true});
    assert.equal(requests.length, 2); assert.notEqual(rerun.report.attemptId, first.report.attemptId); assert.equal(rerun.stale, false);
    assert.equal((await readdir(join(root, ".agent-ops/reviews"))).filter(name => name.endsWith(".json")).length, 3);
    const logs = await readLocalLog(root);
    assert.equal(logs.length, 1); assert.equal(logs[0]!.event.type, "criteria-review");
    assert.doesNotMatch(JSON.stringify(logs), /Missing empty input|Assigned behavior/);
    assert.equal(await findReviewAttestation(root, "a".repeat(64), task.id), null);
    await assert.rejects(stat(join(root, ".agent-ops/tasks")), {code: "ENOENT"});
  } finally {await rm(root, {recursive: true, force: true});}
});

test("strict structure, missing goal and child scope remain explicitly unassessed", async () => {
  assert.equal(validateCriteriaAdvice({...advice, verdict: "PASS"}), false);
  assert.equal(validateCriteriaAdvice({...advice, limitations: [null]}), false);
  const child = {...task, goal: undefined, parentTaskId: "task-parent", surface: {covers: ["child-surface"]}};
  const snapshot = criteriaSnapshot(child, {...task, id: "task-parent", intent: "Parent goal spans multiple children"});
  assert.equal(snapshot.originalGoal, null); assert.equal(snapshot.child, true);
  assert.match(criteriaReviewPrompt(snapshot), /Child completeness is judged only/);
  assert.match(criteriaReviewPrompt(snapshot), /Missing originalGoal is insufficient/);
  assert.doesNotMatch(criteriaReviewPrompt(snapshot), /Not the original goal/);
  const root = await fixture();
  try {
    for (const result of [{...advice, verdict: "PASS"}, {...advice, recommendations: [{...advice.recommendations[0]!, criterionId: "foreign"}]}]) {
      const value = await runCriteriaReview({root, task, target: "codex", runner: runner([], result), rerun: true});
      assert.equal(value.report.status, "NOT_RUN");
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

test("missing reviewer, real output/launch errors and logging failures remain advisory", async () => {
  const root = await fixture();
  try {
    const missing = await runCriteriaReview({root, task});
    assert.equal(missing.report.status, "NOT_RUN"); assert.equal(missing.report.invocations, 0);
    const failed = await runCriteriaReview({root, task, target: "codex", rerun: true, runner: {start: () => {throw new Error("secret launch details");}}, log: async () => {throw new Error("disk full");}});
    assert.equal(failed.report.status, "NOT_RUN"); assert.equal(failed.warnings.length, 1);
    assert.doesNotMatch(JSON.stringify(failed), /secret launch details|disk full/);
    await rm(join(root, ".agent-ops/reviews"), {recursive: true});
    await writeFile(join(root, ".agent-ops/reviews"), "not a directory");
    const requests: ProcessRequest[] = [];
    const unsaved = await runCriteriaReview({root, task, target: "codex", runner: runner(requests)});
    assert.equal(unsaved.report.code, "CRITERIA_REVIEW_STORAGE_UNAVAILABLE"); assert.equal(requests.length, 0);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("concurrent creation waits for the single running attempt; explicit cancellation terminates it", async () => {
  const root = await fixture(), controller = new AbortController();
  let calls = 0, terminated = 0;
  let complete!: (value: {exitCode: null; signal: string}) => void;
  let ready!: () => void;
  const started = new Promise<void>(resolve => {ready = resolve;});
  const pendingRunner: VerificationProcessRunner = {start: () => {
    calls++; ready(); return {pid: 123, stdout: chunks(), stderr: chunks(), completion: new Promise(resolve => {complete = resolve;}),
      terminateTree: async () => {terminated++; complete({exitCode: null, signal: "SIGTERM"});}};
  }};
  try {
    const first = runCriteriaReview({root, task, target: "codex", runner: pendingRunner, signal: controller.signal});
    await started;
    let returned = false;
    const second = runCriteriaReview({root, task, target: "codex", runner: pendingRunner}).then(value => {returned = true; return value;});
    await delay(40); assert.equal(returned, false); assert.equal(calls, 1);
    const rejected = assert.rejects(first, {code: "CRITERIA_REVIEW_CANCELLED"});
    controller.abort("SIGINT"); await rejected;
    assert.equal((await second).report.status, "CANCELLED"); assert.equal(terminated, 1); assert.equal(calls, 1);
    assert.equal((await readCriteriaReview(root, task))!.report.status, "CANCELLED");
  } finally {await rm(root, {recursive: true, force: true});}
});

test("production task callback runs after persistence and before create returns; revise only reads historical advice", async () => {
  const root = await fixture();
  const service = new TaskService(new FileTaskStore(join(root, ".agent-ops/tasks/state.json"), root));
  try {
    let calls = 0;
    const created = await runTaskCommand({service, args: parseArgs(["task", "create", "--title", "Goal", "--goal", "Original goal",
      "--surface-file", join(process.cwd(), "tests/fixtures/surface/minimal.json"), ...task.criteria.flatMap(c => ["--criterion", JSON.stringify(c)])]),
      onTaskCreated: async record => {assert.equal((await service.status({taskId: record.task.id})).status, "active"); calls++;
        return await runCriteriaReview({root, task: record.task});}});
    assert.equal(created.status, "ok"); assert.equal(calls, 1); assert.equal(created.data!.criteriaReview!.report.status, "NOT_RUN");
    const record = created.data!.record!;
    const file = join(root, "criteria.json"); await writeFile(file, JSON.stringify(record.task.criteria.map(c => ({...c, description: c.description + " refined"}))));
    const revised = await runTaskCommand({service, args: parseArgs(["task", "revise", "--task", record.task.id,
      "--expected-contract", created.data!.contractHash!, "--criteria-file", file, "--reason", "Adopt empty-input advice; other suggestion rejected because outside assigned scope"]),
      onTaskCreated: async () => {throw new Error("must not rerun");}, criteriaStatus: async record => await readCriteriaReview(root, record.task)});
    assert.equal(revised.status, "ok"); assert.equal(revised.data!.criteriaReview!.stale, true); assert.equal(calls, 1);
    assert.match(revised.data!.text, /historical snapshot/);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("a substantive revise is due once; surface-only changes stay current; an explicit rerun re-arms it", async () => {
  const root = await fixture(), requests: ProcessRequest[] = [];
  try {
    assert.equal(revisionReviewDue(await readCriteriaReview(root, task)), false, "no report: never due");
    const first = await runCriteriaReview({root, task, target: "codex", runner: runner(requests)});
    assert.equal(first.report.trigger, "create");
    assert.equal(revisionReviewDue(first), false);

    const surfaced = {...task, surface: {axes: {}, included: [], excluded: [], unknown: [], contracts: [], scenarios: {}}} as unknown as AgentTask;
    const surfaceOnly = await readCriteriaReview(root, surfaced);
    assert.equal(surfaceOnly!.stale, false, "surface-only changes leave the advice current");
    assert.equal(revisionReviewDue(surfaceOnly), false);

    for (const changed of [
      {...task, criteria: task.criteria.map(c => ({...c, description: c.description + " changed"}))},
      {...task, intent: "Different assigned behavior"},
      {...task, goal: "A different goal"}
    ]) assert.equal(revisionReviewDue(await readCriteriaReview(root, changed)), true);

    const revised = {...task, intent: "Different assigned behavior"};
    const auto = await runCriteriaReview({root, task: revised, target: "codex", runner: runner(requests), rerun: true, trigger: "revise"});
    assert.equal(auto.report.trigger, "revise"); assert.equal(requests.length, 2);
    const again = {...revised, criteria: task.criteria.map(c => ({...c, description: c.description + " again"}))};
    const afterAuto = await readCriteriaReview(root, again);
    assert.equal(afterAuto!.stale, true);
    assert.equal(revisionReviewDue(afterAuto), false, "only one automatic rerun");

    const manual = await runCriteriaReview({root, task: again, target: "codex", runner: runner(requests), rerun: true});
    assert.equal(manual.report.trigger, "rerun");
    const third = {...again, intent: "Third intent"};
    assert.equal(revisionReviewDue(await readCriteriaReview(root, third)), true, "an explicit rerun re-arms one automatic rerun");
    assert.match(renderCriteriaReview(manual), /reruns this review once; later ones need an explicit --rerun/);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("a report with an unknown trigger is unreadable; one without a trigger stays valid", async () => {
  const root = await fixture();
  try {
    const view = await runCriteriaReview({root, task, target: "codex", runner: runner([])});
    const {trigger: _trigger, ...legacy} = view.report;
    await writeFile(view.reportPath, JSON.stringify(legacy), {mode: 0o600});
    assert.equal((await readCriteriaReview(root, task))!.report.trigger, undefined);
    await writeFile(view.reportPath, JSON.stringify({...legacy, trigger: "nightly"}), {mode: 0o600});
    assert.equal(await readCriteriaReview(root, task), null);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("task revise runs the due advisory after saving; NOT_RUN keeps TASK_REVISED and cancellation keeps the revision", async () => {
  const root = await fixture(), requests: ProcessRequest[] = [];
  const service = new TaskService(new FileTaskStore(join(root, ".agent-ops/tasks/state.json"), root));
  try {
    let result: unknown = advice, exitCode = 0, cancel = false;
    const onTaskRevised = async (record: {task: AgentTask}) => {
      const view = await readCriteriaReview(root, record.task);
      if (!revisionReviewDue(view)) return view;
      if (cancel) throw new AgentOpsError("CRITERIA_REVIEW_CANCELLED", "Criteria review cancelled; task preserved.");
      return await runCriteriaReview({root, task: record.task, target: "codex", runner: runner(requests, result, exitCode), rerun: true, trigger: "revise"});
    };
    const created = await runTaskCommand({service, args: parseArgs(["task", "create", "--title", "Goal", "--goal", "Original goal",
      "--surface-file", join(process.cwd(), "tests/fixtures/surface/minimal.json"), ...task.criteria.flatMap(c => ["--criterion", JSON.stringify(c)])]),
      onTaskCreated: async record => await runCriteriaReview({root, task: record.task, target: "codex", runner: runner(requests)})});
    assert.equal(requests.length, 1);
    const revise = async (suffix: string) => {
      const current = (await service.status({taskId: created.data!.record!.task.id})).task;
      const file = join(root, `criteria-${suffix}.json`);
      await writeFile(file, JSON.stringify(current.criteria.map(c => ({...c, description: c.description + suffix}))));
      return await runTaskCommand({service, onTaskRevised, args: parseArgs(["task", "revise", "--task", current.id,
        "--expected-contract", taskContractHash(current), "--criteria-file", file, "--reason", "Adopt advice"])});
    };

    exitCode = 1; result = {};
    const notRun = await revise(" a");
    assert.equal(notRun.code, "TASK_REVISED"); assert.equal(requests.length, 2);
    assert.equal(notRun.data!.criteriaReview!.report.status, "NOT_RUN"); assert.equal(notRun.data!.criteriaReview!.report.trigger, "revise");

    const settled = await revise(" b");
    assert.equal(settled.code, "TASK_REVISED"); assert.equal(requests.length, 2, "the automatic rerun was spent");
    assert.equal(settled.data!.criteriaReview!.stale, true);

    await runCriteriaReview({root, task: (await service.status({taskId: created.data!.record!.task.id})).task, target: "codex",
      runner: runner(requests), rerun: true});
    exitCode = 0; result = advice;
    const shown = await revise(" c");
    assert.equal(requests.length, 4);
    assert.equal(shown.data!.criteriaReview!.report.status, "COMPLETED");
    assert.match(shown.data!.text, /Missing empty input/);

    await runCriteriaReview({root, task: (await service.status({taskId: created.data!.record!.task.id})).task, target: "codex",
      runner: runner(requests), rerun: true});
    cancel = true;
    const cancelled = await revise(" d");
    assert.equal(cancelled.status, "error"); assert.equal(cancelled.code, "CRITERIA_REVIEW_CANCELLED");
    assert.match((await service.status({taskId: created.data!.record!.task.id})).task.criteria[0]!.description, / d$/, "revision kept");
  } finally {await rm(root, {recursive: true, force: true});}
});

test("an explicit rerun recovers an interrupted claim and each envelope target runs once", async () => {
  const root = await fixture(), requests: ProcessRequest[] = [];
  try {
    const first = await runCriteriaReview({root, task});
    await writeFile(first.reportPath, JSON.stringify({...first.report, status: "RUNNING", ownerPid: 2147483647, ownerIdentity: "gone"}));
    const recovered = await runCriteriaReview({root, task, rerun: true, target: "codex", runner: runner(requests)});
    assert.equal(recovered.report.status, "COMPLETED"); assert.equal(requests.length, 1);
    for (const target of ["agy", "claude"] as const) {
      const report = await runCriteriaReview({root, task, rerun: true, target, runner: runner(requests, {structured_output: advice, usage: {input_tokens: 12, output_tokens: 7}})});
      assert.equal(report.report.status, "COMPLETED"); assert.equal(report.report.invocations, 1);
      assert.equal(report.report.usage!.totalTokens, 19);
      assert.ok(requests.at(-1)!.args.includes("--json-schema"));
    }
    assert.equal(requests.length, 3);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("redacting an authorization header preserves JSON structure and following text", async () => {
  const root = await fixture(), requests: ProcessRequest[] = [];
  const header = "Authorization: [REDACTED_AUTHORIZATION]\nKeep following text";
  try {
    const result = await runCriteriaReview({root, task: {...task, goal: header}, target: "codex", runner: runner(requests, {...advice, summary: header})});
    assert.equal(result.report.status, "COMPLETED");
    assert.equal(result.report.advice!.recommendations.length, 1);
    assert.match(result.report.advice!.summary, /Keep following text/);
    const payload = requests[0]!.stdin!.split("BEGIN UNTRUSTED DATA\n")[1]!.split("\nEND UNTRUSTED DATA")[0]!;
    assert.equal(JSON.parse(payload).originalGoal, header);
    const cached = await readCriteriaReview(root, {...task, goal: header});
    assert.equal(cached!.report.status, "COMPLETED"); assert.equal(cached!.stale, false);
  } finally {await rm(root, {recursive: true, force: true});}
});
