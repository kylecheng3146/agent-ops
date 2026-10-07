import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AcceptanceCriterion, AgentOpsConfig } from "../../runtime/src/contracts.js";
import { validateConfig, validateTask } from "../../runtime/src/schema/validate.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { goalHash, taskContractHash, treeContractHash } from "../../runtime/src/task/contract.js";
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import { reviewReportDigest, REVIEW_ATTESTATION_DIRECTORY } from "../../runtime/src/review/attestation.js";
import type { ReviewReport } from "../../runtime/src/review/report.js";
import { loadFindingPin } from "../../runtime/src/task/pin-finding.js";
import { COMPLETION_CONFIG } from "./completion-fixture.js";

const sha = "a".repeat(40);
const config: AgentOpsConfig = {...COMPLETION_CONFIG, verification: {...COMPLETION_CONFIG.verification,
  acceptanceRunners: [{id: "acceptance", command: "node", args: ["{materials}"], cwd: ".", adapter: "generic"}]}};
function criteria(): AcceptanceCriterion[] {
  return [{id: "behavior", description: "Changes observable behavior", verifierIds: ["unit"], acceptance: {
    mode: "behavioral", baselineCommit: sha, bindings: [{runnerId: "acceptance",
      checkIds: ["test::changed"], redCheckIds: ["test::changed"],
      materials: [{path: "tests/behavior.test.js", role: "test"}]}]}},
    {id: "judgment", description: "Meets fixed goal", verifierIds: [], acceptance: {
      mode: "review-only", baselineCommit: sha, bindings: [], reviewOnlyReason: "Goal interpretation requires independent judgment."}}];
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-contract-"));
  const store = new FileTaskStore(join(root, ".agent-ops/tasks/state.json"), root);
  let next = 0;
  const calls: readonly string[][] = [];
  const service = new TaskService(store, {generateId: () => "task-contract-" + (++next),
    completion: {root, loadConfig: async () => config, gitRunner: {run: async args => {
      (calls as string[][]).push([...args]);
      return {exitCode: 0, stdout: Buffer.from(args[0] === "rev-parse" ?
        (args[2] === "HEAD" ? sha : args[2]?.replace("^{commit}", "") ?? sha) + "\n" : "")};
    }}}});
  return {root, store, service, calls};
}
test("typed criteria coexist with legacy, reject false red and arbitrary command overrides", () => {
  const task = {schemaVersion: 2, id: "task-valid", title: "Acceptance", criteria: criteria()};
  assert.equal(validateTask(task).ok, true);
  assert.equal(validateTask({...task, schemaVersion: 1}).ok, false);
  const bad = structuredClone(task);
  bad.criteria[0]!.acceptance!.bindings[0]!.redCheckIds = [];
  assert.equal(validateTask(bad).ok, false);
  const unsafe = structuredClone(task);
  unsafe.criteria[0]!.acceptance!.bindings[0]!.materials[0]!.path = "../source.js";
  assert.equal(validateTask(unsafe).ok, false);
  const unexplained = structuredClone(task);
  delete unexplained.criteria[1]!.acceptance!.reviewOnlyReason;
  assert.equal(validateTask(unexplained).ok, false, "review-only fallback must state why mechanical proof is unavailable");
  assert.equal(validateConfig({...config, verification: {...config.verification,
    acceptanceRunners: [{...config.verification.acceptanceRunners![0], shell: true}]}}).ok, false);
  const legacy = {...task, schemaVersion: 1, criteria: criteria().map(({acceptance: _a, ...c}) => ({...c, verifierIds: ["unit"]}))};
  assert.equal(validateTask(legacy).ok, true);
  assert.equal(calculateConfigHash(COMPLETION_CONFIG), calculateConfigHash(structuredClone(COMPLETION_CONFIG)));
});
test("create retains immutable baselines; revise preserves goal, history and CAS", async () => {
  const f = await fixture();
  try {
    const original = await f.service.create({title: "Goal", goal: "User goal stays fixed", criteria: criteria()});
    assert.equal(original.createdSourceCommit, sha);
    assert.ok(f.calls.some(a => a[0] === "update-ref" && a[1]?.endsWith("/" + sha)));
    const changed = criteria(); changed[0]!.description = "Precisely checks the changed behavior";
    const hash = taskContractHash(original.task);
    const attempts = await Promise.allSettled([1, 2].map(() => f.service.revise(original.task.id,
      {expectedContractHash: hash, criteria: changed, reason: "Clarify check scope"})));
    assert.equal(attempts.filter(a => a.status === "fulfilled").length, 1);
    const latest = await f.service.status({taskId: original.task.id});
    assert.equal(goalHash(latest.task), goalHash(original.task));
    assert.notEqual(taskContractHash(latest.task), hash);
    assert.equal(latest.revisions?.[0]?.previousHash, hash);
    assert.deepEqual(latest.evidence, {});
    const invalid = criteria(); invalid[0]!.acceptance!.baselineCommit = "b".repeat(40);
    await assert.rejects(f.service.revise(original.task.id, {expectedContractHash: taskContractHash(latest.task),
      criteria: invalid, reason: "Try moving baseline"}), {code: "BASELINE_IMMUTABLE"});
    assert.equal((await f.store.read()).tasks[0]!.task.contractRevision, 1);
  } finally {await rm(f.root, {recursive: true, force: true});}
});
test("replan maps every requirement atomically and rejects stale or incomplete splits", async () => {
  const f = await fixture();
  try {
    const root = await f.service.create({title: "Goal", intent: "Keep original behavior", criteria: criteria()});
    const expectedTreeContractHash = treeContractHash([root.task]);
    const tasks = [{title: "Split", intent: "Cover the original requirements", criteria: criteria(),
      replaces: root.task.criteria.map(c => root.task.id + ":" + c.id)}];
    await assert.rejects(f.service.replan(root.task.id, {expectedTreeContractHash, reason: "Split",
      tasks: [{...tasks[0]!, replaces: [root.task.id + ":behavior"]}]}), {code: "TASK_REPLAN_COVERAGE_REQUIRED"});
    assert.equal((await f.store.read()).tasks.length, 1);
    const created = await f.service.replan(root.task.id, {expectedTreeContractHash, reason: "Split", tasks});
    assert.equal(created.length, 1);
    assert.equal(created[0]!.task.criteria[0]!.acceptance!.baselineCommit, sha);
    await assert.rejects(f.service.replan(root.task.id, {expectedTreeContractHash, reason: "Stale", tasks}),
      {code: "TASK_CONTRACT_CHANGED"});
    assert.equal(JSON.parse(await readFile(join(f.root, ".agent-ops/tasks/state.json"), "utf8")).schemaVersion, 2);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

async function failedFinding(f: Awaited<ReturnType<typeof fixture>>, record: Awaited<ReturnType<TaskService["create"]>>) {
  const report: ReviewReport = {summary: "The event is duplicated", results: record.task.criteria.map(c => ({
    criterionId: c.id, status: "FAIL", summary: "Requires repair", evidence: ["Observed two events"]})),
    findings: [{severity: "important", blocking: true, title: "Duplicate event", details: "SessionStart writes two events",
      locations: [{path: "runtime/event.ts", line: 1}], evidence: ["Two events observed"], recommendation: "Assert a single event",
      criterionIds: record.task.criteria.map(c => c.id)}], residualRisks: [], changedFilesInspected: ["runtime/event.ts"], supportingFilesInspected: []};
  const directory = join(f.root, REVIEW_ATTESTATION_DIRECTORY);
  await mkdir(directory, {recursive: true});
  // Corrupt unrelated reports must not prevent a legitimate pin.
  await writeFile(join(directory, "0".repeat(64) + ".reports.json"), "null");
  const fingerprint = "f".repeat(64);
  const artifact = {schemaVersion: 2, status: "FAIL", taskId: record.task.id, sourceFingerprint: fingerprint,
    taskContractHash: taskContractHash(record.task), taskContracts: {[record.task.id]: taskContractHash(record.task)},
    goalHash: goalHash(record.task), candidateCommit: "b".repeat(40), report};
  const path = join(directory, fingerprint + "." + record.task.id + ".reports.json");
  await writeFile(path, JSON.stringify(artifact), {mode: 0o600});
  return {reference: reviewReportDigest(report) + ":0", path, artifact};
}
test("pin binds a failed report to its goal and candidate, with explicit recurrence and immutable baseline", async () => {
  const f = await fixture();
  try {
    const record = await f.service.create({title: "Goal", goal: "Exactly one event", criteria: criteria()});
    const saved = await failedFinding(f, record);
    const criterion = {...criteria()[0]!, id: "regression"};
    const result = await f.service.pinFinding(record.task.id, taskContractHash(record.task), saved.reference, criterion);
    assert.ok(result.record);
    assert.equal(result.pendingCriterion.acceptance?.baselineCommit, "b".repeat(40));
    assert.match(result.pendingCriterion.finding!.pinId, /^[a-f0-9]{64}$/u);
    assert.equal(result.record.task.criteria.length, 3);
    assert.equal(result.record.task.goal, record.task.goal);
    assert.deepEqual(result.record.evidence, {});
    await assert.rejects(f.service.create({title: "Forged pin", criteria: [result.pendingCriterion, criteria()[1]!]}), {code: "TASK_PIN_REQUIRED"});
    const forged = {...result.pendingCriterion, id: "forged", finding: {...result.pendingCriterion.finding!, pinId: "c".repeat(64)}};
    await assert.rejects(f.service.revise(record.task.id, {expectedContractHash: taskContractHash(result.record.task),
      criteria: [...result.record.task.criteria, forged], reason: "Try forging provenance"}), {code: "TASK_PIN_EXISTS"});
    const sourceMapping = result.record.task.criteria.map(c => record.task.id + ":" + c.id);
    await assert.rejects(f.service.replan(record.task.id, {expectedTreeContractHash: await f.service.treeContract(record.task.id), reason: "Try dropping the regression",
      tasks: [{title: "Split", intent: "Preserve all requirements", criteria: criteria(), replaces: sourceMapping}]}), {code: "TASK_REPLAN_PIN_REQUIRED"});

    assert.deepEqual(await loadFindingPin(f.root, result.record, saved.reference, {...criterion, id: "regression"}), result.pendingCriterion);
    await assert.rejects(loadFindingPin(f.root, result.record, saved.reference, {...criterion, id: "other"}), {code: "TASK_PIN_EXISTS"});
    const recurring = await loadFindingPin(f.root, result.record, saved.reference,
      {...criterion, description: "Recheck exact cardinality", finding: result.pendingCriterion.finding});
    assert.equal(recurring.acceptance?.baselineCommit, "b".repeat(40));
    assert.equal(recurring.finding?.pinId, result.pendingCriterion.finding?.pinId);
    await assert.rejects(f.service.pinFinding(record.task.id, taskContractHash(record.task), saved.reference, criterion), {code: "TASK_CONTRACT_CHANGED"});
    await writeFile(saved.path, JSON.stringify({...saved.artifact, goalHash: "c".repeat(64)}));
    await assert.rejects(loadFindingPin(f.root, result.record, saved.reference, criterion), {code: "TASK_FINDING_NOT_FOUND"});
  } finally {await rm(f.root, {recursive: true, force: true});}
});
test("pin at the five-criterion cap returns a validated replan obligation without changing state", async () => {
  const f = await fixture();
  try {
    const five = [...criteria(), ...["three", "four", "five"].map(id => ({...criteria()[1]!, id}))];
    const record = await f.service.create({title: "Goal", criteria: five});
    const saved = await failedFinding(f, record);
    const result = await f.service.pinFinding(record.task.id, taskContractHash(record.task), saved.reference, {...criteria()[0]!, id: "regression"});
    assert.equal(result.record, null);
    assert.equal(result.pendingCriterion.finding?.reportDigest, saved.reference.split(":")[0]);
    assert.equal(taskContractHash((await f.service.status({taskId: record.task.id})).task), taskContractHash(record.task));
    await assert.rejects(loadFindingPin(f.root, record, saved.reference,
      {...criteria()[0]!, acceptance: {...criteria()[0]!.acceptance!, mode: "invariant"}}), {code: "TASK_PIN_CRITERION_INVALID"});
  } finally {await rm(f.root, {recursive: true, force: true});}
});
