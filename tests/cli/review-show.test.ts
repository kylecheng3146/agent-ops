import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { appendFile, readFile } from "node:fs/promises";

import { readFinishedReview, runReviewShowCommand } from "../../packages/cli/src/commands/review-show.js";
import { sha256 } from "../../runtime/src/fs/hash.js";
import type { FinishDependencies } from "../../runtime/src/parallel/finish.js";
import type { FinishReceipt } from "../../runtime/src/parallel/receipt.js";
import { addWorktree, NOTES_REF } from "../../runtime/src/parallel/service.js";
import type { ReviewReportArtifact } from "../../runtime/src/review/attestation.js";
import { resolveReviewScope } from "../../runtime/src/review/scope.js";
import { writePrivateFile } from "../../runtime/src/security/permissions.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { calculateSourceFingerprint } from "../../runtime/src/verify/source-fingerprint.js";
import { deps, git, gitRunner, repository } from "../worktree/fixture.js";
import { reportFor } from "../review/report-fixture.js";

function dependencies(): FinishDependencies {
  return { ...deps(), tasks: (root) => new TaskService(new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root)) };
}

function artifact(taskId: string, criterionId: string): ReviewReportArtifact {
  const first = reportFor([{ id: criterionId }]);
  const second = { ...reportFor([{ id: criterionId }]), summary: "Second round checked every criterion.",
    residualRisks: ["Residual rollout risk."] };
  return {
    schemaVersion: 1, sourceFingerprint: "f".repeat(64), taskId,
    status: "PASS", harness: "agy", plannedTargets: ["agy", "agy"],
    attempts: [{ target: "agy", status: "PASS" }, { target: "agy", status: "PASS" }],
    preflight: [], report: first, adversarial: { target: "agy", refuted: false, report: second },
    createdAt: "2026-10-03T00:00:00.000Z"
  };
}

async function finished(root: string, mode: "tree" | "per-task-fallback", tasks: readonly { id: string; title: string }[]): Promise<string> {
  const head = await git(root, "rev-parse", "HEAD");
  const reviews: Record<string, { report: { digest: string; value: ReviewReportArtifact } }> = {};
  for (const task of tasks) {
    const value = artifact(task.id, task.id);
    reviews[task.id] = { report: { digest: sha256(JSON.stringify(value)), value } };
  }
  const receipt = {
    schemaVersion: 1, sessionId: "session-one", candidateHead: head, targetCommit: head,
    sourceFingerprint: "f".repeat(64), reviewMode: mode,
    tasks: tasks.map(({ id, title }) => ({ task: { id, title } })), children: [],
    verification: {}, reviews, residualRisks: [], createdAt: "2026-10-03T00:00:00.000Z"
  } as unknown as FinishReceipt;
  const path = join(root, ".git", "agent-ops", "receipts", `${sha256("session-one")}-${head}.json`);
  const source = `${JSON.stringify(receipt, null, 2)}\n`;
  await writePrivateFile(path, source, join(root, ".git"));
  await git(root, "notes", `--ref=${NOTES_REF}`, "add", "-f", "-m",
    `session: session-one\nreceipt: ${path}\nreceipt-sha256: ${sha256(source)}`, head);
  return path;
}

test("finished tree review shows both complete reports once and verifies its note", async () => {
  const root = await repository();
  const path = await finished(root, "tree", [{ id: "parent", title: "Parent" }, { id: "child", title: "Child" }]);
  const shown = await runReviewShowCommand({ cwd: root, taskId: "child", deps: dependencies() });
  assert.equal(shown.code, "REVIEW_SHOWN");
  const data = shown.data as { text: string; entries: readonly unknown[] };
  assert.equal(data.entries.length, 1);
  assert.match(data.text, /Round 1 — primary/);
  assert.match(data.text, /Round 2 — adversarial/);
  assert.match(data.text, /Second round checked every criterion/);
  assert.match(data.text, /Residual rollout risk/);
  await writePrivateFile(path, (await readFile(path, "utf8")).replace("Review complete.", "Changed review."), join(root, ".git"));
  await assert.rejects(readFinishedReview(dependencies(), root, join(root, ".git"), path),
    (error: unknown) => error instanceof Error && error.message.includes("does not match its Git note"));
});

test("finished fallback review groups each task's two reports", async () => {
  const root = await repository();
  await finished(root, "per-task-fallback", [{ id: "parent", title: "Parent" }, { id: "child", title: "Child" }]);
  const shown = await runReviewShowCommand({ cwd: root, taskId: "parent", deps: dependencies() });
  const data = shown.data as { text: string; entries: readonly unknown[] };
  assert.equal(data.entries.length, 2);
  assert.match(data.text, /Task parent: Parent/);
  assert.match(data.text, /Task child: Child/);
  assert.equal(data.text.match(/Round 2 — adversarial/g)?.length, 2);
});

test("active FAIL is visible from main, then a changed candidate has no stale verdict", async () => {
  const root = await repository();
  const d = dependencies();
  const { record } = await addWorktree(d, { cwd: root, name: "review-candidate", sessionId: "session-active" });
  const tasks = d.tasks(record.path);
  const task = await tasks.create({ title: "Active task", intent: "Make the behavior work.",
    criteria: [{ id: "behavior", description: "Behavior works", verifierIds: ["node-test"] },
      { id: "regression", description: "Existing behavior works", verifierIds: ["node-test"] }],
    policyConfigHash: "f".repeat(64), sessionId: "session-active" });
  await appendFile(join(record.path, "source.txt"), "candidate\n");
  await git(record.path, "add", "source.txt");
  await git(record.path, "commit", "-m", "candidate");
  const scope = await resolveReviewScope({ root: record.path, runner: gitRunner(record.path), base: await git(root, "rev-parse", "HEAD") });
  const fingerprint = await calculateSourceFingerprint(record.path, scope, gitRunner(record.path));
  const failed = { ...artifact(task.task.id, "behavior"), sourceFingerprint: fingerprint,
    status: "FAIL", attempts: [{ target: "agy", status: "FAIL" }],
    report: reportFor([{ id: "behavior" }], "FAIL"), adversarial: undefined };
  await writePrivateFile(join(record.path, ".agent-ops", "reviews", `${fingerprint}.${task.task.id}.reports.json`),
    `${JSON.stringify(failed)}\n`, record.path);
  const shown = await runReviewShowCommand({ cwd: root, taskId: task.task.id, deps: d });
  const text = (shown.data as { text: string }).text;
  assert.match(text, /Round 1 — primary \(agy\): FAIL/);
  assert.match(text, /Criterion failed/);
  assert.match(text, /Round 2 — adversarial .*NOT_RUN/);
  await appendFile(join(record.path, "source.txt"), "changed after review\n");
  const dirtyScope = await resolveReviewScope({ root: record.path, runner: gitRunner(record.path) });
  const dirtyFingerprint = await calculateSourceFingerprint(record.path, dirtyScope, gitRunner(record.path));
  await writePrivateFile(join(record.path, ".agent-ops", "reviews", `${dirtyFingerprint}.${task.task.id}.reports.json`),
    `${JSON.stringify({ ...failed, sourceFingerprint: dirtyFingerprint })}\n`, record.path);
  const dirtyShown = await runReviewShowCommand({ cwd: root, taskId: task.task.id, deps: d });
  assert.match((dirtyShown.data as { text: string }).text, /Criterion failed/);
  await appendFile(join(record.path, "source.txt"), "changed again\n");
  const stale = await runReviewShowCommand({ cwd: root, taskId: task.task.id, deps: d });
  const staleText = (stale.data as { text: string }).text;
  assert.match(staleText, /No review for the current candidate/);
  assert.doesNotMatch(staleText, /Criterion failed/);
});
