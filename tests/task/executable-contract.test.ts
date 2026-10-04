import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AcceptanceCriterion, AgentOpsConfig } from "../../runtime/src/contracts.js";
import { validateConfig, validateTask } from "../../runtime/src/schema/validate.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { goalHash, taskContractHash, treeContractHash } from "../../runtime/src/task/contract.js";
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
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
      mode: "review-only", baselineCommit: sha, bindings: []}}];
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
