import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectOfficeInput, type OfficeGit } from "../../runtime/src/office/collect.js";
import { buildOfficeSnapshot } from "../../runtime/src/office/snapshot.js";
import { writeWorktreeRecord } from "../../runtime/src/parallel/service.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import { buildVerificationEvidence, FileEvidenceStore } from "../../runtime/src/verify/evidence.js";
import { COMPLETION_CONFIG, completionContext, passingCompletionEvidence } from "../task/completion-fixture.js";

test("collect reads attached task proof from each managed worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-office-collect-"));
  const child = join(root, ".worktrees", "session-a");
  const commonDir = join(root, ".git");
  try {
    await mkdir(commonDir, {recursive: true});
    await mkdir(join(child, "src"), {recursive: true});
    await writeFile(join(child, "src", "change.ts"), "export {}\n");
    const tasks = new TaskService(new FileTaskStore(join(child, ".agent-ops", "tasks", "state.json"), child), {completion: completionContext(child)});
    const created = await tasks.create({title: "Office task", criteria: [
      {id: "criterion", description: "criterion", verifierIds: ["unit"]},
      {id: "criterion-two", description: "criterion two", verifierIds: ["unit"]}
    ], sessionId: "session-a", policyConfigHash: calculateConfigHash(COMPLETION_CONFIG)});
    const evidence = await passingCompletionEvidence(child, created, COMPLETION_CONFIG);
    await tasks.recordEvidence(created.task.id, evidence);
    await writeWorktreeRecord({schemaVersion: 1, name: "session-a", branch: "agent-ops/session-a", path: child,
      mainRoot: root, targetBranch: "main", base: "a".repeat(40), sessionId: "session-a", createdAt: "2026-10-07T00:00:00.000Z"});
    const git: OfficeGit = async (cwd, args) => {
      if (cwd === root && args[0] === "worktree" && args[1] === "list") {
        return {exitCode: 0, stdout: `worktree ${root}\n\nworktree ${child}\nbranch refs/heads/agent-ops/session-a\n\n`};
      }
      if (args[0] === "diff") return {exitCode: 0, stdout: "1\t0\tsrc/change.ts\0"};
      return {exitCode: 0, stdout: ""};
    };
    const active = await collectOfficeInput(root, commonDir, git, Date.parse("2026-10-07T01:00:00.000Z"));
    const activeWorktree = active.worktrees.find(item => item.sessionId === "session-a");
    assert.deepEqual(activeWorktree?.progress, {verify: "PASS", review: "PASS", passed: 2, total: 2});
    assert.equal(activeWorktree?.phase, "reviewing");
    assert.equal(activeWorktree?.status, "active");

    const completed = await tasks.complete(created.task.id, evidence);
    assert.equal(completed.status, "complete");
    const finished = await collectOfficeInput(root, commonDir, git, Date.parse(completed.completedAt!) + 2 * 60 * 60 * 1000 - 1);
    assert.equal(finished.worktrees.length, 1, "a completed desk remains just under two hours");
    assert.equal(finished.worktrees[0]!.completedAt, completed.completedAt);
    const expired = await collectOfficeInput(root, commonDir, git, Date.parse(completed.completedAt!) + 2 * 60 * 60 * 1000);
    assert.equal(buildOfficeSnapshot(expired).lobby.length, 0, "completed worktree desks leave after two hours");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("collects only the newest verification candidate and requires its review", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-office-current-proof-"));
  const child = join(root, ".worktrees", "session-current");
  const commonDir = join(root, ".git");
  try {
    await mkdir(commonDir, {recursive: true});
    await mkdir(child, {recursive: true});
    await writeWorktreeRecord({schemaVersion: 1, name: "session-current", branch: "agent-ops/session-current", path: child,
      mainRoot: root, targetBranch: "main", base: "a".repeat(40), sessionId: "session-current", createdAt: "2026-10-07T00:00:00.000Z"});
    const tasks = new TaskService(new FileTaskStore(join(child, ".agent-ops", "tasks", "state.json"), child), {completion: completionContext(child)});
    const created = await tasks.create({title: "Current proof", criteria: [
      {id: "criterion", description: "criterion", verifierIds: ["unit"]},
      {id: "criterion-two", description: "criterion two", verifierIds: ["unit"]}
    ], sessionId: "session-current", policyConfigHash: calculateConfigHash(COMPLETION_CONFIG)});
    const original = await passingCompletionEvidence(child, created, COMPLETION_CONFIG);
    await tasks.recordEvidence(created.task.id, original);
    const store = new FileEvidenceStore(child, child);
    const command = COMPLETION_CONFIG.verification.commands[0]!;
    const newer = async (status: "PASS" | "FAIL", fingerprint: string, finishedAt: string): Promise<string> =>
      await store.save(buildVerificationEvidence({taskId: created.task.id, criterionId: "criterion", command, config: COMPLETION_CONFIG,
        sourceFingerprint: fingerprint, scope: "project", startedAt: finishedAt, finishedAt,
        status, exitCode: status === "PASS" ? 0 : 1, testCount: status === "PASS" ? 1 : 0,
        failureClass: status === "PASS" ? "none" : "exit-code", toolVersions: {}}));
    const failed = await newer("FAIL", "b".repeat(64), "2026-10-07T02:00:00.000Z");
    await tasks.recordEvidence(created.task.id, {criterion: [...(original.criterion ?? []), failed]});
    const git: OfficeGit = async (cwd, args) => {
      if (cwd === root && args[0] === "worktree" && args[1] === "list") {
        return {exitCode: 0, stdout: `worktree ${root}\n\nworktree ${child}\nbranch refs/heads/agent-ops/session-current\n\n`};
      }
      if (args[0] === "diff") return {exitCode: 0, stdout: "1\t0\tsrc/change.ts\0"};
      return {exitCode: 0, stdout: ""};
    };
    const failedSnapshot = await collectOfficeInput(root, commonDir, git, Date.parse("2026-10-07T03:00:00.000Z"));
    assert.deepEqual(failedSnapshot.worktrees[0]?.progress, {verify: "FAIL", review: null, passed: 1, total: 2});

    const passed = await newer("PASS", "c".repeat(64), "2026-10-07T04:00:00.000Z");
    await tasks.recordEvidence(created.task.id, {criterion: [...(original.criterion ?? []), failed, passed]});
    const current = await collectOfficeInput(root, commonDir, git, Date.parse("2026-10-07T05:00:00.000Z"));
    assert.deepEqual(current.worktrees[0]?.progress, {verify: "PASS", review: null, passed: 2, total: 2});
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
