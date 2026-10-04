import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import { runAdvanceCommand, type AdvanceStep } from "../../packages/cli/src/commands/advance.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { FileCompletionGateStore } from "../../runtime/src/hooks/completion-gate.js";
import { integrateSessionChildren, writeNoChangeDelivery, type NoChangeDelivery } from "../../runtime/src/parallel/integrate.js";
import { addWorktree, sessionWorktreeName, writeWorktreeRecord, type WorktreeRecord } from "../../runtime/src/parallel/service.js";
import {FileRunRepository, createRunState} from "../../runtime/src/run/service.js";
import { reviewReportDigest, saveReviewAttestation, saveReviewReportArtifact } from "../../runtime/src/review/attestation.js";
import { resolveReviewScope } from "../../runtime/src/review/scope.js";
import type { ReviewRunResult } from "../../runtime/src/review/runner.js";
import { finishWorktree, type FinishDependencies } from "../../runtime/src/parallel/finish.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { collectBaseChangePaths } from "../../runtime/src/verify/change-surface.js";
import { buildVerificationEvidence, FileEvidenceStore } from "../../runtime/src/verify/evidence.js";
import { calculateSourceFingerprint } from "../../runtime/src/verify/source-fingerprint.js";
import { CONFIG, deps, git, gitRunner, repository, write } from "./fixture.js";
import { reportFor } from "../review/report-fixture.js";

const SESSION = "integration-session";
const criteria = [
  { id: "behavior", description: "Delivered behavior works", verifierIds: ["node-test"] },
  { id: "regression", description: "Existing behavior remains", verifierIds: ["node-test"] }
];

function service(root: string, base?: string): TaskService {
  return new TaskService(new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root),
    base === undefined ? {} : { completion: {
      root, gitRunner: gitRunner(root), base, loadConfig: async () => CONFIG
    } });
}

function finishDeps(): FinishDependencies {
  return { ...deps(), tasks: (root, base) => service(root, base) };
}

async function deliver(record: WorktreeRecord, file: string, content: string,
  intent = `Add ${file} without changing unrelated files.`, taskCriteria = criteria): Promise<string> {
  const tasks = service(record.path);
  const task = await tasks.create({
    title: `Deliver ${file}`, intent, criteria: taskCriteria, policyConfigHash: calculateConfigHash(CONFIG), sessionId: record.sessionId
  });
  await write(record.path, file, content);
  await git(record.path, "add", file);
  await git(record.path, "commit", "-qm", `deliver ${file}`);
  const runner = gitRunner(record.path);
  const fingerprint = await calculateSourceFingerprint(record.path, {
    mode: "base", baseRef: record.base, resolvedBase: record.base,
    changedFiles: await collectBaseChangePaths(runner, record.base)
  }, runner);
  const evidence = new FileEvidenceStore(record.path, record.path);
  const refs: Record<string, string[]> = {};
  for (const criterion of taskCriteria) {
    refs[criterion.id] = [await evidence.save(buildVerificationEvidence({
      taskId: task.task.id, criterionId: criterion.id, command: CONFIG.verification.commands[0]!, scope: "project",
      startedAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z",
      exitCode: 0, testCount: null, status: "PASS", failureClass: "none", sourceFingerprint: fingerprint,
      toolVersions: {}, config: CONFIG
    }))];
  }
  await tasks.recordEvidence(task.task.id, refs);
  return task.task.id;
}

test("integrates two committed child deliveries and imports their pre-work intents once", async () => {
  const root = await repository();
  try {
    const d = finishDeps();
    const coordinator = (await addWorktree(d, { cwd: root, name: "coordinator", sessionId: SESSION })).record;
    const parent = await service(coordinator.path).create({
      title: "Parent objective", intent: "Combine both independent changes.", criteria,
      policyConfigHash: calculateConfigHash(CONFIG), sessionId: SESSION
    });
    const a = (await addWorktree(d, { cwd: root, name: "child-a", sessionId: SESSION, agentId: "agent-a" })).record;
    const b = (await addWorktree(d, { cwd: root, name: "child-b", sessionId: SESSION, agentId: "agent-b" })).record;
    const aId = await deliver(a, "a.txt", "A\n");
    const bId = await deliver(b, "b.txt", "B\n");
    const integrated = await integrateSessionChildren(d, coordinator, parent.task.id);
    assert.deepEqual(integrated.map(({ name }) => name), ["child-a", "child-b"]);
    assert.equal(await readFile(join(coordinator.path, "a.txt"), "utf8"), "A\n");
    assert.equal(await readFile(join(coordinator.path, "b.txt"), "utf8"), "B\n");
    for (const id of [aId, bId]) {
      const imported = await service(coordinator.path).status({ taskId: id });
      assert.equal(imported.task.parentTaskId, parent.task.id);
      assert.match(imported.task.intent ?? "", /without changing unrelated files/u);
      assert.equal(imported.status, "active");
      assert.deepEqual(imported.evidence, {});
    }
    const head = await git(coordinator.path, "rev-parse", "HEAD");
    assert.deepEqual(await integrateSessionChildren(d, coordinator, parent.task.id), integrated);
    assert.equal(await git(coordinator.path, "rev-parse", "HEAD"), head);
    await write(a.path, "uncommitted.txt", "dirty\n");
    await assert.rejects(integrateSessionChildren(d, coordinator, parent.task.id),
      (failure: unknown) => failure instanceof AgentOpsError && failure.code === "WORKTREE_CHILD_DIRTY");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merge conflict restores the coordinator commit and preserves child worktrees", async () => {
  const root = await repository();
  try {
    const d = finishDeps();
    const coordinator = (await addWorktree(d, { cwd: root, name: "coordinator", sessionId: SESSION })).record;
    const parent = await service(coordinator.path).create({
      title: "Parent objective", criteria, policyConfigHash: calculateConfigHash(CONFIG), sessionId: SESSION
    });
    const a = (await addWorktree(d, { cwd: root, name: "child-a", sessionId: SESSION, agentId: "agent-a" })).record;
    const b = (await addWorktree(d, { cwd: root, name: "child-b", sessionId: SESSION, agentId: "agent-b" })).record;
    await deliver(a, "source.txt", "A\n");
    await deliver(b, "source.txt", "B\n");
    const before = await git(coordinator.path, "rev-parse", "HEAD");
    await assert.rejects(integrateSessionChildren(d, coordinator, parent.task.id),
      (failure: unknown) => failure instanceof AgentOpsError && failure.code === "WORKTREE_INTEGRATION_CONFLICT");
    assert.equal(await git(coordinator.path, "rev-parse", "HEAD"), before);
    assert.equal(await git(coordinator.path, "status", "--porcelain"), "");
    assert.equal(await readFile(join(a.path, "source.txt"), "utf8"), "A\n");
    assert.equal(await readFile(join(b.path, "source.txt"), "utf8"), "B\n");
    assert.deepEqual((await service(coordinator.path).list()).map(({ task }) => task.id), [parent.task.id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("integrates a run-owned no-change child only with an explicit supporting review scope", async () => {
  const root = await repository();
  try {
    const d = finishDeps();
    const runId = "run-integration-no-change";
    const coordinator = (await addWorktree(d, {
      cwd: root, name: "coordinator", sessionId: SESSION,
      runOwnership: { runId, workerId: "coordinator", ownerSessionId: SESSION, generation: 1 }
    })).record;
    const parent = await service(coordinator.path).create({
      title: "Parent objective", intent: "Accept an already-satisfied child with auditable evidence.", criteria,
      policyConfigHash: calculateConfigHash(CONFIG), sessionId: SESSION
    });
    const child = (await addWorktree(d, {
      cwd: root, name: "child-no-change", sessionId: SESSION, agentId: "agent-a",
      runOwnership: { runId, workerId: "worker-a", ownerSessionId: SESSION, generation: 1 }
    })).record;
    const tasks = service(child.path);
    const task = await tasks.create({
      title: "Preserve existing behavior", intent: "Prove the existing source already satisfies this invariant.",
      criteria, policyConfigHash: calculateConfigHash(CONFIG), sessionId: SESSION
    });
    const sourceCommit = await git(child.path, "rev-parse", "HEAD");
    const scope = { mode: "base" as const, baseRef: sourceCommit, resolvedBase: sourceCommit,
      noChange: true as const, changedFiles: ["source.txt"] };
    const fingerprint = await calculateSourceFingerprint(child.path, scope, gitRunner(child.path));
    const evidence = new FileEvidenceStore(child.path, child.path);
    const refs: Record<string, string[]> = {};
    for (const criterion of criteria) {
      refs[criterion.id] = [await evidence.save(buildVerificationEvidence({
        taskId: task.task.id, criterionId: criterion.id, command: CONFIG.verification.commands[0]!, scope: "project",
        startedAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z",
        exitCode: 0, testCount: null, status: "PASS", failureClass: "none", sourceFingerprint: fingerprint,
        toolVersions: {}, config: CONFIG
      }))];
    }
    await tasks.recordEvidence(task.task.id, refs);
    const delivery: NoChangeDelivery = {
      schemaVersion: 1, deliveryKind: "no-change", sourceCommit,
      deliveryDigest: "a".repeat(64), contractDigest: "b".repeat(64), artifactRefs: ["review-artifact.json"],
      reviewScope: JSON.stringify(scope), runId, workerId: "worker-a", generation: 1
    };
    await writeNoChangeDelivery(child, delivery);
    const targetBefore = await git(coordinator.path, "rev-parse", "HEAD");
    const integrated = await integrateSessionChildren(d, coordinator, parent.task.id);
    assert.equal(await git(coordinator.path, "rev-parse", "HEAD"), targetBefore);
    assert.equal(integrated[0]?.deliveryKind, "no-change");
    assert.deepEqual(integrated[0]?.sourceArtifacts, ["review-artifact.json"]);
    assert.deepEqual((await service(coordinator.path).status({ taskId: task.task.id })).evidence, {});
    assert.deepEqual(await integrateSessionChildren(d, coordinator, parent.task.id), integrated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("final finish preserves a child that changes after integration", async () => {
  const root = await repository();
  try {
    const d = finishDeps();
    const coordinator = (await addWorktree(d, { cwd: root, name: "coordinator", sessionId: SESSION })).record;
    const parent = await service(coordinator.path).create({
      title: "Parent objective", criteria, policyConfigHash: calculateConfigHash(CONFIG), sessionId: SESSION
    });
    const child = (await addWorktree(d, { cwd: root, name: "child-a", sessionId: SESSION, agentId: "agent-a" })).record;
    await deliver(child, "a.txt", "A\n");
    const children = await integrateSessionChildren(d, coordinator, parent.task.id);
    const target = await git(root, "rev-parse", "HEAD");
    const head = await git(coordinator.path, "rev-parse", "HEAD");
    await write(child.path, "later.txt", "not delivered\n");
    await assert.rejects(finishWorktree(d, { cwd: root, name: coordinator.name,
      finalProof: { target, head, sourceFingerprint: "pending", children } }),
    (failure: unknown) => failure instanceof AgentOpsError && failure.code === "WORKTREE_CHILDREN_CHANGED");
    assert.equal(await git(root, "rev-parse", "HEAD"), target);
    assert.equal(await readFile(join(child.path, "later.txt"), "utf8"), "not delivered\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const interrupted of [false, true]) test(interrupted
  ? "run integration recovers after target and receipt commit without repeating verification, review or merge"
  : "task advance finishes an eight-criterion parent tree with one final review chain", async () => {
  const root = await repository();
  try {
    const d = finishDeps();
    const coordinator = (await addWorktree(d, { cwd: root, name: sessionWorktreeName(SESSION), sessionId: SESSION })).record;
    const parent = await service(coordinator.path).create({
      title: "Parent objective", intent: "Integrate both deliveries without losing either behavior.", criteria,
      policyConfigHash: calculateConfigHash(CONFIG), sessionId: SESSION
    });
    const a = (await addWorktree(d, { cwd: root, name: "child-a", sessionId: SESSION, agentId: "agent-a" })).record;
    const b = (await addWorktree(d, { cwd: root, name: "child-b", sessionId: SESSION, agentId: "agent-b" })).record;
    const commonDir = await git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const runRepository = new FileRunRepository(join(commonDir, "agent-ops", "runs"), commonDir);
    const runState = createRunState({root, commonDir, targetBranch: "main", goal: "Parent objective", host: "codex", ownerSessionId: SESSION});
    if (interrupted) {
      await runRepository.create(runState);
      await writeWorktreeRecord({...coordinator, runId: runState.runId, coordinatorId: runState.coordinatorId,
        workerId: runState.coordinatorId, ownerSessionId: SESSION, workerGeneration: 1});
      for (const child of [a, b]) await writeWorktreeRecord({...child, runId: runState.runId, coordinatorId: runState.coordinatorId,
        workerId: child.name, ownerSessionId: SESSION, workerGeneration: 1});
    }
    const childCriteria = [...criteria,
      { id: "integration", description: "Integrates with the parent goal", verifierIds: ["node-test"] }];
    await deliver(a, "a.txt", "A\n", "Add A and preserve public behavior.", childCriteria);
    await deliver(b, "b.txt", "B\n", "Add B and preserve A behavior.", childCriteria);
    let reviews = 0;
    let verifications = 0;
    const step: AdvanceStep = async (cwd, args) => {
      const taskId = args[2]!;
      const base = args[args.indexOf("--base") + 1]!;
      const scope = await resolveReviewScope({ root: cwd, runner: gitRunner(cwd), base });
      const fingerprint = await calculateSourceFingerprint(cwd, scope, gitRunner(cwd));
      const tasks = service(cwd);
      if (args[0] === "verify") {
        verifications += 1;
        const task = await tasks.status({ taskId });
        const store = new FileEvidenceStore(cwd, cwd);
        const refs: Record<string, string[]> = {};
        for (const criterion of task.task.criteria) {
          refs[criterion.id] = [await store.save(buildVerificationEvidence({
            taskId, criterionId: criterion.id, command: CONFIG.verification.commands[0]!, scope: "project",
            startedAt: "2026-10-03T01:00:00.000Z", finishedAt: "2026-10-03T01:00:01.000Z",
            exitCode: 0, testCount: null, status: "PASS", failureClass: "none", sourceFingerprint: fingerprint,
            toolVersions: {}, config: CONFIG
          }))];
        }
        await tasks.recordEvidence(taskId, refs);
        return { code: "VERIFICATION_PASSED", status: "ok", data: { report: { status: "PASS" } } };
      }
      reviews += 1;
      assert.equal(args.includes("--tree"), true);
      const all = await tasks.list();
      const tree = {
        rootTaskId: parent.task.id,
        taskIds: all.map(({ task }) => task.id),
        criterionIds: all.flatMap(({ task }) => task.criteria.map(({ id }) => `${task.id}:${id}`))
      };
      const report = reportFor(tree.criterionIds.map((id) => ({ id, description: id })), "PASS", scope.changedFiles);
      const result: ReviewRunResult = {
        status: "PASS", harness: "codex", model: "fixture", effort: "fixture", prompt: "fixture",
        plannedTargets: ["codex", "codex"], sourceFingerprint: fingerprint, sessionIsolation: "fresh",
        attempts: [
          { target: "codex", status: "PASS", sessionId: "final-primary" },
          { target: "codex", status: "PASS", sessionId: "final-adversarial" }
        ], preflight: [], report,
        adversarial: { target: "codex", refuted: false, report }
      };
      for (const { task } of all) {
        const reportArtifact = await saveReviewReportArtifact(cwd, result, fingerprint, task.id, tree);
        await saveReviewAttestation(cwd, {
          schemaVersion: 2, taskId: task.id, tree,
          harness: "codex", status: "PASS", sourceFingerprint: fingerprint,
          reviewTargets: ["codex", "codex"], reviewSessionIds: ["final-primary", "final-adversarial"],
          sessionIsolation: "fresh", primaryReportDigest: reviewReportDigest(report),
          adversarialReportDigest: reviewReportDigest(report), reportArtifact,
          createdAt: "2026-10-03T01:00:02.000Z"
        });
      }
      return { code: "REVIEW_RESULT", status: "ok", data: { result: { status: "PASS" } } };
    };
    let fault = interrupted;
    const failing = {...d, git: async (cwd: string, args: readonly string[]) => {
      if (fault && args[0] === "notes" && args.includes("add")) {
        fault = false;
        return {exitCode: 1, stdout: "", stderr: "Injected note failure after target/receipt."};
      }
      return await d.git(cwd, args);
    }};
    if (interrupted) {
      await assert.rejects(runAdvanceCommand({cwd: root, sessionId: SESSION, parentTaskId: parent.task.id, deps: failing, step}),
        (cause: unknown) => cause instanceof AgentOpsError && cause.code === "WORKTREE_FINISH_PARTIAL");
      assert.equal((await runRepository.read(runState.runId))!.integration?.status, "receipt-written");
      assert.equal((await service(coordinator.path).status({taskId: parent.task.id})).status, "complete");
    }
    const targetAfterFailure = await git(root, "rev-parse", "HEAD");
    const result = await runAdvanceCommand({ cwd: root, sessionId: SESSION, parentTaskId: parent.task.id, deps: d, step });
    if (interrupted) {
      assert.equal(await git(root, "rev-parse", "HEAD"), targetAfterFailure);
      assert.equal((await runRepository.read(runState.runId))!.integration?.status, "cleaned");
    }
    assert.equal(result.status, "ok");
    assert.equal(verifications, 3);
    assert.equal(reviews, 1);
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "A\n");
    assert.equal(await readFile(join(root, "b.txt"), "utf8"), "B\n");
    const receiptPath = (result.data as { receipt: string }).receipt;
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
      reviewMode: string; tasks: { status: string; task: { criteria: unknown[] } }[]
    };
    assert.equal(receipt.reviewMode, "tree");
    assert.equal(receipt.tasks.reduce((n, task) => n + task.task.criteria.length, 0), 8);
    assert.equal(receipt.tasks.every(({ status }) => status === "complete"), true);
    assert.equal((await new FileCompletionGateStore(root).read(SESSION))?.extraRoots, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
