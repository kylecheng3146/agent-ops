import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { collectOfficeInput, worktreeMerged, type OfficeGit } from "../../runtime/src/office/collect.js";
import { recordOfficeSession } from "../../runtime/src/office/sessions.js";
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

test("each desk lists its criteria with the newest outcome, consistent with the n/m summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-office-criteria-"));
  const child = join(root, ".worktrees", "session-mixed");
  const commonDir = join(root, ".git");
  try {
    await mkdir(commonDir, {recursive: true});
    await mkdir(child, {recursive: true});
    await writeWorktreeRecord({schemaVersion: 1, name: "session-mixed", branch: "agent-ops/session-mixed", path: child,
      mainRoot: root, targetBranch: "main", base: "a".repeat(40), sessionId: "session-mixed", createdAt: "2026-10-07T00:00:00.000Z"});
    const tasks = new TaskService(new FileTaskStore(join(child, ".agent-ops", "tasks", "state.json"), child), {completion: completionContext(child)});
    const created = await tasks.create({title: "Mixed proof", criteria: [
      {id: "totals", description: "Receipt lists totals", verifierIds: ["unit"]},
      {id: "locale", description: "Tax follows the <b>locale</b>", verifierIds: ["unit"]},
      {id: "snapshots", description: "Snapshots still pass", verifierIds: ["unit"]}
    ], sessionId: "session-mixed", policyConfigHash: calculateConfigHash(COMPLETION_CONFIG)});
    const original = await passingCompletionEvidence(child, created, COMPLETION_CONFIG);
    const store = new FileEvidenceStore(child, child);
    const failed = await store.save(buildVerificationEvidence({taskId: created.task.id, criterionId: "locale",
      command: COMPLETION_CONFIG.verification.commands[0]!, config: COMPLETION_CONFIG, sourceFingerprint: "d".repeat(64), scope: "project",
      startedAt: "2026-10-07T02:00:00.000Z", finishedAt: "2026-10-07T02:00:00.000Z", status: "FAIL", exitCode: 1, testCount: 0,
      failureClass: "exit-code", toolVersions: {}}));
    // "snapshots" never ran: it must read as not verified, not as a failure.
    await tasks.recordEvidence(created.task.id, {totals: original.totals!, locale: [...original.locale!, failed]});
    const git: OfficeGit = async (cwd, args) => cwd === root && args[0] === "worktree"
      ? {exitCode: 0, stdout: `worktree ${root}\n\nworktree ${child}\nbranch refs/heads/agent-ops/session-mixed\n\n`}
      : {exitCode: 0, stdout: ""};
    const input = await collectOfficeInput(root, commonDir, git, Date.parse("2026-10-07T03:00:00.000Z"));
    const worktree = input.worktrees[0]!;
    assert.equal(worktree.title, "Mixed proof");
    assert.deepEqual(worktree.criteria, [
      {id: "totals", description: "Receipt lists totals", status: "PASS", finishedAt: "2026-07-23T12:00:01Z", failureClass: null, exitCode: null},
      {id: "locale", description: "Tax follows the <b>locale</b>", status: "FAIL", finishedAt: "2026-10-07T02:00:00.000Z", failureClass: "exit-code", exitCode: 1},
      {id: "snapshots", description: "Snapshots still pass", status: null, finishedAt: null, failureClass: null, exitCode: null}
    ]);
    const desk = buildOfficeSnapshot(input).lobby[0]!;
    assert.deepEqual(desk.criteria, worktree.criteria, "the snapshot desk carries the rows unchanged");
    assert.equal(desk.title, "Mixed proof");
    assert.equal(desk.criteria!.filter(row => row.status === "PASS").length, desk.progress!.passed, "PASS rows match the passed count");
    assert.equal(desk.criteria!.length, desk.progress!.total, "every criterion has a row");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("a desk without an attached task carries no criteria", () => {
  const snapshot = buildOfficeSnapshot({runs: [], reviews: [], now: Date.parse("2026-10-07T03:00:00.000Z"), worktrees: [{
    name: "bare", path: "/tmp/bare", branch: "agent-ops/bare", sessionId: "bare",
    diff: {files: 0, insertions: 0, deletions: 0, paths: [], recent: null}
  }]});
  assert.equal(snapshot.lobby[0]!.criteria, undefined);
});

test("collect hides a worktree already merged into its target, and only that one", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-office-merged-"));
  const commonDir = join(root, ".git");
  const base = "b".repeat(40), moved = "c".repeat(40);
  const trees = {merged: {head: moved, dirty: false}, fresh: {head: base, dirty: false}, dirty: {head: moved, dirty: true}};
  const now = Date.parse("2026-10-07T01:00:00.000Z");
  try {
    await mkdir(commonDir, {recursive: true});
    for (const name of Object.keys(trees)) {
      const path = join(root, ".worktrees", name);
      await mkdir(path, {recursive: true});
      await writeWorktreeRecord({schemaVersion: 1, name, branch: `agent-ops/${name}`, path, mainRoot: root,
        targetBranch: "main", base, sessionId: `session-${name}`, createdAt: "2026-10-07T00:00:00.000Z"});
      await recordOfficeSession({commonDir, projectRoot: root, sessionId: `session-${name}`, harness: "claude", event: "start", now});
    }
    const git: OfficeGit = async (cwd, args) => {
      if (cwd === root && args[0] === "worktree") {
        return {exitCode: 0, stdout: Object.keys(trees).map(name => `worktree ${join(root, ".worktrees", name)}\n`).join("\n")};
      }
      const tree = trees[basename(cwd) as keyof typeof trees];
      if (args[0] === "rev-parse") return {exitCode: 0, stdout: tree.head + "\n"};
      if (args[0] === "merge-base") return {exitCode: args[2] === moved && args[3] === "refs/heads/main" ? 0 : 1, stdout: ""};
      if (args[0] === "status") return {exitCode: 0, stdout: tree.dirty ? " M src/x.ts\n" : ""};
      return {exitCode: 0, stdout: ""};
    };
    // The merged worktree's session would otherwise come back as a (no worktree) room.
    const snapshot = buildOfficeSnapshot(await collectOfficeInput(root, commonDir, git, now));
    assert.deepEqual(snapshot.lobby.map(desk => desk.sessionId).sort(), ["session-dirty", "session-fresh"]);
    assert.equal(await worktreeMerged(git, join(root, ".worktrees", "merged"), base, "main"), true);
    assert.equal(await worktreeMerged(git, join(root, ".worktrees", "merged"), base, "bad branch"), false,
      "a branch outside the ref pattern never reaches git");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
