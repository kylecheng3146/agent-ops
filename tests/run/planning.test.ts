import assert from "node:assert/strict";
import {mkdtemp, mkdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {workerPlan} from "../../runtime/src/run/planning.js";
import {createRunState, FileRunRepository} from "../../runtime/src/run/service.js";
import {registeredRunWriter} from "../../runtime/src/run/ownership.js";
import type {WorktreeRecord} from "../../runtime/src/parallel/service.js";

const state = createRunState({root: "/repo", commonDir: "/repo/.git", targetBranch: "main", goal: "Fixed goal", host: "claude", ownerSessionId: "coordinator-session", rootTaskId: "task-root"});
const criteria = [{id: "one", description: "One requirement", verifierIds: ["unit"]},
  {id: "two", description: "Second requirement", verifierIds: [], acceptance: {mode: "invariant", bindings: [{runnerId: "checks", checkIds: ["test"], materials: [{path: "tests/test.py", role: "test"}]}]}}];
test("deferred worker plans validate criteria and dependencies without choosing an early baseline", () => {
  const current = {...state, tasks: [{taskId: "task-dependency", dependencies: [], status: "planned" as const, workerId: null,
    deliveryDigest: null, sourceCommit: null, blockedReason: null}]};
  const spec = {title: "Child", intent: "Independent requirements", criteria, dependencies: ["task-dependency"]};
  const plan = workerPlan(spec, "task-child", current);
  assert.equal(plan.criteria[1]!.acceptance!.baselineCommit, undefined);
  assert.deepEqual(spec.criteria, criteria);
  for (const value of [{...spec, dependencies: ["task-root"]}, {...spec, dependencies: ["missing"]}, {...spec, command: "shell"},
    {...spec, criteria: [criteria[0]]}, {...spec, criteria: [criteria[0], criteria[0]]},
    {...spec, criteria: [criteria[0], {...criteria[1], acceptance: {...criteria[1]!.acceptance, baselineCommit: "a".repeat(40)}}]}])
    assert.throws(() => workerPlan(value, "task-child", current));
});

test("writer ownership requires the common ledger's native identity, current generation and live lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-run-owner-"));
  const common = join(root, ".git");
  await mkdir(common);
  const repository = new FileRunRepository(join(common, "agent-ops", "runs"), common);
  const current = createRunState({root, commonDir: common, targetBranch: "main", goal: "Fixed goal", host: "claude", ownerSessionId: "coordinator-session"});
  const record: WorktreeRecord = {schemaVersion: 1, name: "child", branch: "agent-ops/child", path: join(root, ".worktrees", "child"), mainRoot: root,
    targetBranch: "main", base: "a".repeat(40), sessionId: current.ownerSessionId, agentId: "worker-child", runId: current.runId,
    coordinatorId: current.coordinatorId, workerId: "worker-child", ownerSessionId: "native-child", workerGeneration: 1, createdAt: current.createdAt};
  try {
    await repository.create({...current, workers: [{workerId: "worker-child", taskId: "task-child", host: "claude", ownerSessionId: "native-child",
      nativeSessionId: "native-child", nativeJobId: null, worktree: record.path, processId: 123, processIdentity: "process-instance",
      generation: 1, status: "running", leaseExpiresAt: new Date(Date.now()+60000).toISOString(), heartbeatAt: current.createdAt,
      stopIntent: null, nativeGoalState: "active", lastFailure: null}]});
    assert.equal(await registeredRunWriter(record, "native-child"), true);
    assert.equal(await registeredRunWriter(record, current.ownerSessionId), false);
    assert.equal(await registeredRunWriter({...record, workerGeneration: 2}, "native-child"), false);
    assert.equal(await registeredRunWriter({...record, coordinatorId: "spoofed"}, "native-child"), false);
    await repository.mutate(current.runId, saved => ({...saved, disableRestart: true}));
    assert.equal(await registeredRunWriter(record, "native-child"), false);
  } finally {await rm(root, {recursive: true, force: true});}
});
