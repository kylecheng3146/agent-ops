import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { runTaskCommand } from "../../packages/cli/src/commands/task.js";
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import { findReviewAttestation, invalidateReviewAttestation, saveReviewAttestation } from "../../runtime/src/review/attestation.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { FileEvidenceStore } from "../../runtime/src/verify/evidence.js";
import { validateEvidence } from "../../runtime/src/schema/validate.js";
import { createFailureFingerprint } from "../../runtime/src/verify/fingerprint.js";
import { COMPLETION_CONFIG, completionContext, completionGit, passingCompletionEvidence } from "./completion-fixture.js";

function input(parentTaskId?: string) {
  return { title: "Complete verified work", policyConfigHash: calculateConfigHash(COMPLETION_CONFIG),
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    criteria: ["behavior", "regression"].map((id) => ({ id, description: `${id} passes`, verifierIds: ["unit"] })) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-task-completion-"));
  const store = new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root);
  const context = completionContext(root);
  const tasks = new TaskService(store, { completion: context });
  return { root, store, context, tasks };
}

test("completion rejects fake references, absent or wrong-task review, and later failures without changing state", async () => {
  const { root, store, tasks } = await fixture();
  try {
    const task = await tasks.create(input());
    const before = await store.read();
    const fake = await runTaskCommand({ service: tasks, args: parseArgs([
      "task", "complete", "--task", task.task.id,
      "--evidence", "behavior=true", "--evidence", "regression=review:claude:PASS"
    ]) });
    assert.equal(fake.code, "TASK_EVIDENCE_INVALID");
    assert.deepEqual(await store.read(), before);

    const references = await passingCompletionEvidence(root, task);
    const evidenceStore = new FileEvidenceStore(root, root);
    const validation = validateEvidence(await evidenceStore.load(references.behavior![0]!));
    assert.ok(validation.ok);
    const evidence = validation.value;
    const attestation = await findReviewAttestation(root, evidence.sourceFingerprint!);
    assert.ok(attestation);
    await invalidateReviewAttestation(root, attestation.sourceFingerprint);
    await assert.rejects(tasks.complete(task.task.id, references), { code: "TASK_COMPLETION_REVIEW_REQUIRED" });
    await saveReviewAttestation(root, { ...attestation, taskId: "another-task" });
    await assert.rejects(tasks.complete(task.task.id, references), { code: "TASK_COMPLETION_REVIEW_REQUIRED" });
    await saveReviewAttestation(root, attestation);

    const failed = await evidenceStore.save({ ...evidence, status: "FAIL", exitCode: 1, failureClass: "nonzero-exit", finishedAt: "2026-07-23T12:00:03Z" });
    await assert.rejects(tasks.complete(task.task.id, { ...references, behavior: [failed, ...references.behavior!] }),
      { code: "TASK_COMPLETION_EVIDENCE_REQUIRED" });
    const tiedFailure = await evidenceStore.save({ ...evidence, status: "FAIL", exitCode: 1, failureClass: "nonzero-exit" });
    await assert.rejects(tasks.complete(task.task.id, { ...references, behavior: [tiedFailure, ...references.behavior!] }),
      { code: "TASK_COMPLETION_EVIDENCE_REQUIRED" });
    assert.deepEqual(await store.read(), before);

    await tasks.recordFailure(task.task.id, createFailureFingerprint({
      commandId: "unit", failureClass: "nonzero-exit", exitCategory: "nonzero", diagnostics: "later failure"
    }));
    const afterFailure = await store.read();
    await assert.rejects(tasks.complete(task.task.id, references), { code: "TASK_COMPLETION_VERIFICATION_FAILED" });
    assert.deepEqual(await store.read(), afterFailure);
    await tasks.clearFailure(task.task.id);
    const completed = await tasks.complete(task.task.id, references);
    assert.equal(completed.status, "complete");
    assert.deepEqual(await tasks.complete(task.task.id, references), completed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("submitting older PASS references cannot hide a recorded failure", async () => {
  const { root, tasks } = await fixture();
  try {
    const task = await tasks.create(input());
    const references = await passingCompletionEvidence(root, task);
    const store = new FileEvidenceStore(root, root);
    const validation = validateEvidence(await store.load(references.behavior![0]!));
    assert.ok(validation.ok);
    const failed = await store.save({ ...validation.value, status: "FAIL", exitCode: 1,
      failureClass: "nonzero-exit", finishedAt: "2026-07-23T12:00:03Z" });
    await tasks.recordEvidence(task.task.id, { behavior: [failed] });
    await assert.rejects(tasks.complete(task.task.id, references), { code: "TASK_COMPLETION_EVIDENCE_REQUIRED" });
    assert.equal((await tasks.status({ taskId: task.task.id })).status, "active");
    const recovered = await store.save({ ...validation.value, finishedAt: "2026-07-23T12:00:04Z" });
    const completed = await tasks.complete(task.task.id, { ...references, behavior: [recovered] });
    assert.deepEqual(completed.evidence.behavior, [failed, recovered]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid recorded proof does not permit junk submitted evidence", async () => {
  const { root, tasks } = await fixture();
  try {
    const task = await tasks.create(input());
    await tasks.recordEvidence(task.task.id, await passingCompletionEvidence(root, task));
    const before = await tasks.status({ taskId: task.task.id });
    await assert.rejects(tasks.complete(task.task.id, { behavior: ["PASS"], regression: ["PASS"] }),
      { code: "TASK_EVIDENCE_INVALID" });
    assert.deepEqual(await tasks.status({ taskId: task.task.id }), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completion requires context and rejects stale source/config, including repeated completion", async () => {
  const { root, store, tasks, context } = await fixture();
  try {
    const task = await tasks.create(input());
    const references = await passingCompletionEvidence(root, task);
    const unchecked = new TaskService(store);
    await assert.rejects(unchecked.complete(task.task.id, references), { code: "TASK_COMPLETION_UNAVAILABLE" });
    const changedConfig = new TaskService(store, { completion: { ...context,
      loadConfig: async () => ({ ...COMPLETION_CONFIG, profiles: ["core", "loop"] }) } });
    await assert.rejects(changedConfig.complete(task.task.id, references), { code: "TASK_COMPLETION_TASK_STALE" });
    const changedSource = new TaskService(store, { completion: { ...context, gitRunner: {
      run: async (args) => args[0] === "rev-parse"
        ? { exitCode: 0, stdout: Buffer.from(`${"b".repeat(40)}\n`) } : completionGit.run(args)
    } } });
    await assert.rejects(changedSource.complete(task.task.id, references), { code: "TASK_COMPLETION_EVIDENCE_REQUIRED" });
    assert.equal((await tasks.status({ taskId: task.task.id })).status, "active");
    await tasks.complete(task.task.id, references);
    await assert.rejects(changedSource.complete(task.task.id, references), { code: "TASK_COMPLETION_EVIDENCE_REQUIRED" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config changes during completion do not persist a completed record", async () => {
  const { root, store, tasks, context } = await fixture();
  try {
    const task = await tasks.create(input());
    const references = await passingCompletionEvidence(root, task);
    let reads = 0;
    const changing = new TaskService(store, { completion: { ...context,
      loadConfig: async () => ++reads === 1 ? COMPLETION_CONFIG : { ...COMPLETION_CONFIG, profiles: ["core", "loop"] } } });
    const before = await readFile(join(root, ".agent-ops", "tasks", "state.json"), "utf8");
    await assert.rejects(changing.complete(task.task.id, references), { code: "TASK_COMPLETION_SOURCE_CHANGED" });
    assert.equal(await readFile(join(root, ".agent-ops", "tasks", "state.json"), "utf8"), before);
    let snapshots = 0;
    const changingSource = new TaskService(store, { completion: { ...context, gitRunner: {
      run: async (args) => args[0] === "rev-parse" && ++snapshots > 1
        ? { exitCode: 0, stdout: Buffer.from(`${"b".repeat(40)}\n`) } : completionGit.run(args)
    } } });
    await assert.rejects(changingSource.complete(task.task.id, references), { code: "TASK_COMPLETION_SOURCE_CHANGED" });
    assert.equal(await readFile(join(root, ".agent-ops", "tasks", "state.json"), "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active and archived-unfinished subtasks block a parent; verified children never complete it", async () => {
  const { root, tasks } = await fixture();
  try {
    const parent = await tasks.create(input());
    const child = await tasks.create(input(parent.task.id));
    const references = await passingCompletionEvidence(root, parent);
    await assert.rejects(tasks.complete(parent.task.id, references), { code: "TASK_SUBTASK_INCOMPLETE" });
    await tasks.complete(child.task.id, await passingCompletionEvidence(root, child));
    assert.equal((await tasks.status({ taskId: parent.task.id })).status, "active");
    await tasks.archive(child.task.id);
    await tasks.complete(parent.task.id, await passingCompletionEvidence(root, parent));
    await assert.rejects(tasks.create(input(parent.task.id)), { code: "TASK_PARENT_NOT_ACTIVE" });

    const otherParent = await tasks.create(input());
    const unfinished = await tasks.create(input(otherParent.task.id));
    await tasks.archive(unfinished.task.id);
    await assert.rejects(tasks.complete(otherParent.task.id, await passingCompletionEvidence(root, otherParent)),
      { code: "TASK_SUBTASK_INCOMPLETE" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slow completion releases the state lock and rechecks new children before committing", { timeout: 5000 }, async () => {
  const { root, store, tasks, context } = await fixture();
  let release = (): void => {};
  try {
    const parent = await tasks.create(input());
    const references = await passingCompletionEvidence(root, parent);
    let entered = (): void => {};
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const completing = new TaskService(store, { completion: { ...context, loadConfig: async () => {
      entered(); await hold; return COMPLETION_CONFIG;
    } } }).complete(parent.task.id, references);
    await ready;
    assert.equal((await tasks.list()).length, 1);
    await tasks.create(input(parent.task.id));
    const rejected = assert.rejects(completing, { code: "TASK_SUBTASK_INCOMPLETE" });
    release();
    await rejected;
    assert.equal((await tasks.status({ taskId: parent.task.id })).status, "active");
    assert.equal((await tasks.list()).length, 2);
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

for (const mutation of ["archive", "failure", "evidence"] as const) {
  test(`completion cannot overwrite concurrent ${mutation}`, { timeout: 5000 }, async () => {
    const { root, store, tasks, context } = await fixture();
    let release = (): void => {};
    try {
      const task = await tasks.create(input());
      const references = await passingCompletionEvidence(root, task);
      let entered = (): void => {};
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const completing = new TaskService(store, { completion: { ...context, loadConfig: async () => {
        entered(); await hold; return COMPLETION_CONFIG;
      } } }).complete(task.task.id, references);
      await ready;
      if (mutation === "archive") await tasks.archive(task.task.id);
      else if (mutation === "evidence") await tasks.recordEvidence(task.task.id, references);
      else await tasks.recordFailure(task.task.id, createFailureFingerprint({
        commandId: "unit", failureClass: "nonzero-exit", exitCategory: "nonzero", diagnostics: "concurrent failure"
      }));
      const before = await store.read();
      const rejected = assert.rejects(completing, { code: "TASK_COMPLETION_STATE_CHANGED" });
      release();
      await rejected;
      assert.deepEqual(await store.read(), before);
    } finally {
      release();
      await rm(root, { recursive: true, force: true });
    }
  });
}
