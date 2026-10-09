import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
import { writePrivateFile } from "../../runtime/src/security/permissions.js";
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
      {id: "totals", description: "Receipt lists totals", status: "PASS", finishedAt: "2026-07-23T12:00:01Z", failureClass: null, exitCode: null, output: null},
      {id: "locale", description: "Tax follows the <b>locale</b>", status: "FAIL", finishedAt: "2026-10-07T02:00:00.000Z", failureClass: "exit-code", exitCode: 1, output: null},
      {id: "snapshots", description: "Snapshots still pass", status: null, finishedAt: null, failureClass: null, exitCode: null, output: null}
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

async function proofWorktree(prefix: string, criteria: {id: string; description: string}[]) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const child = join(root, ".worktrees", "session-proof");
  await mkdir(join(root, ".git"), {recursive: true});
  await mkdir(child, {recursive: true});
  await writeWorktreeRecord({schemaVersion: 1, name: "session-proof", branch: "agent-ops/session-proof", path: child,
    mainRoot: root, targetBranch: "main", base: "b".repeat(40), sessionId: "session-proof", createdAt: "2026-10-07T00:00:00.000Z"});
  const tasks = new TaskService(new FileTaskStore(join(child, ".agent-ops", "tasks", "state.json"), child), {completion: completionContext(child)});
  const created = await tasks.create({title: "Proof", criteria: criteria.map(c => ({...c, verifierIds: ["unit"]})), sessionId: "session-proof", policyConfigHash: calculateConfigHash(COMPLETION_CONFIG)});
  const git: OfficeGit = async (cwd, args) => {
    if (cwd === root && args[0] === "worktree") return {exitCode: 0, stdout: `worktree ${root}\n\nworktree ${child}\nbranch refs/heads/agent-ops/session-proof\n\n`};
    if (args[0] === "rev-list") return {exitCode: 0, stdout: "3\n"};
    return {exitCode: 0, stdout: ""};
  };
  return {root, child, tasks, created, git};
}

async function evidenceFile(child: string, taskId: string, name: string, value: Record<string, unknown>): Promise<string> {
  const reference = `.agent-ops/tasks/evidence/${taskId}/${name}.json`;
  await writePrivateFile(join(child, ...reference.split("/")), JSON.stringify(value), child);
  return reference;
}

test("the newest review report becomes the desk review, redacted and capped", async () => {
  const {root, child, created, git} = await proofWorktree("agent-ops-office-review-", [{id: "only", description: "Only"}, {id: "other", description: "Other"}]);
  try {
    const taskId = created.task.id, reviews = join(child, ".agent-ops", "reviews");
    const token = "ghp_" + "A".repeat(36);
    const finding = (n: number) => ({severity: "important", blocking: true, title: "T".repeat(500) + n, details: `uses password=hunter2 in step ${n} ` + "d".repeat(2000),
      locations: [], evidence: [], recommendation: "r".repeat(900), criterionIds: ["only"]});
    const report = (status: string, createdAt: string, extra: Record<string, unknown> = {}) => JSON.stringify({schemaVersion: 2, sourceFingerprint: "c".repeat(64), taskId,
      status, harness: "codex", plannedTargets: ["codex", "claude"], attempts: [], preflight: [], createdAt, ...extra});
    await writePrivateFile(join(reviews, `${"1".repeat(64)}.${taskId}.reports.json`), report("PASS", "2026-10-07T01:00:00.000Z",
      {report: {summary: "looks fine", results: [], findings: [], residualRisks: [], changedFilesInspected: [], supportingFilesInspected: []}}), child);
    await writePrivateFile(join(reviews, `${"2".repeat(64)}.${taskId}.reports.json`), report("FAIL", "2026-10-07T02:00:00.000Z", {
      report: {summary: "S".repeat(3000) + " " + token, results: [], findings: Array.from({length: 12}, (_, n) => finding(n)), residualRisks: [], changedFilesInspected: [], supportingFilesInspected: []},
      adversarial: {target: "claude", refuted: false, report: {summary: "upheld", results: [], findings: [], residualRisks: [], changedFilesInspected: [], supportingFilesInspected: []}}}), child);
    // Newer but oversized: ignored.
    await writePrivateFile(join(reviews, `${"3".repeat(64)}.${taskId}.reports.json`), report("PASS", "2026-10-07T03:00:00.000Z", {pad: "x".repeat(600 * 1024)}), child);
    // Newer but a symbolic link to a file outside: never read.
    await writeFile(join(root, "outside.json"), report("PASS", "2026-10-07T04:00:00.000Z"));
    await symlink(join(root, "outside.json"), join(reviews, `${"4".repeat(64)}.${taskId}.reports.json`));
    const desk = buildOfficeSnapshot(await collectOfficeInput(root, join(root, ".git"), git, Date.parse("2026-10-07T05:00:00.000Z"))).lobby[0]!;
    const review = desk.review!;
    assert.equal(review.status, "FAIL", "the newest readable report wins");
    assert.equal(review.createdAt, "2026-10-07T02:00:00.000Z");
    assert.deepEqual(review.rounds.map(round => round.target), ["codex", "claude"]);
    assert.equal(review.refuted, false);
    const first = review.rounds[0]!;
    assert.ok(Buffer.byteLength(first.summary) <= 1024, "summary is capped");
    assert.equal(first.findings.length, 10, "at most ten findings a round");
    for (const item of first.findings) {
      assert.ok(Buffer.byteLength(item.title) <= 300 && Buffer.byteLength(item.details) <= 1024 && Buffer.byteLength(item.recommendation) <= 512, "finding fields are capped");
      assert.doesNotMatch(item.details, /hunter2/u, "secrets are redacted again on read");
      assert.equal(item.blocking, true);
    }
    assert.doesNotMatch(JSON.stringify(review), new RegExp(token, "u"), "tokens never reach the snapshot");
    assert.equal(desk.base, "b".repeat(12), "the base commit, shortened");
    assert.equal(desk.ahead, 3, "commits past the base");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("failing acceptance output reaches the desk as a redacted tail; tampered or linked artifacts are never read", async () => {
  const {root, child, tasks, created, git} = await proofWorktree("agent-ops-office-output-", [
    {id: "replayed", description: "Replayed"}, {id: "tampered", description: "Tampered"}, {id: "linked", description: "Linked"}, {id: "plain", description: "Plain"}]);
  try {
    const taskId = created.task.id, token = "ghp_" + "B".repeat(36), store = new FileEvidenceStore(child, child), command = COMPLETION_CONFIG.verification.commands[0]!;
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    const artifactOf = async (content: string) => { const path = `.agent-ops/tasks/acceptance/${sha(content)}.json`; await writePrivateFile(join(child, ...path.split("/")), content, child); return path; };
    const replayed = await artifactOf(JSON.stringify({schemaVersion: 1,
      output: {stdout: "noise line\n".repeat(500) + "secret " + token + "\n", stderr: "expected \"1.234,56 €\"\nreceived \"1234,56 €\""}}));
    const tampered = await artifactOf(JSON.stringify({output: {stdout: "ORIGINAL", stderr: ""}}));
    await writePrivateFile(join(child, ...tampered.split("/")), JSON.stringify({output: {stdout: "EDITED AFTERWARDS", stderr: ""}}), child);
    const outside = JSON.stringify({output: {stdout: "OUTSIDE FILE CONTENT", stderr: ""}});
    await writeFile(join(root, "outside.json"), outside);
    const linked = `.agent-ops/tasks/acceptance/${sha(outside)}.json`;
    await symlink(join(root, "outside.json"), join(child, ...linked.split("/")));
    const failing = (criterionId: string, executionArtifact?: string) => store.save(buildVerificationEvidence({taskId, criterionId, command, config: COMPLETION_CONFIG,
      sourceFingerprint: "d".repeat(64), scope: "project", startedAt: "2026-10-07T02:00:00.000Z", finishedAt: "2026-10-07T02:00:00.000Z",
      status: "FAIL", exitCode: 1, testCount: 0, failureClass: "test-failure", toolVersions: {},
      ...(executionArtifact === undefined ? {} : {taskContractHash: "f".repeat(64), acceptance: {criterionContractHash: "1".repeat(64), phase: "candidate" as const,
        commit: "c".repeat(40), pairedCommit: "c".repeat(40), bindingHash: "2".repeat(64), materialDigest: "3".repeat(64), executionDigest: "4".repeat(64),
        executionArtifact, checks: [{checkId: "k", status: "FAIL" as const, failureClass: "test-failure"}]}})}));
    await tasks.recordEvidence(taskId, {replayed: [await failing("replayed", replayed)], tampered: [await failing("tampered", tampered)],
      linked: [await failing("linked", linked)], plain: [await failing("plain")]});
    const desk = buildOfficeSnapshot(await collectOfficeInput(root, join(root, ".git"), git, Date.parse("2026-10-07T03:00:00.000Z"))).lobby[0]!;
    const rows = Object.fromEntries(desk.criteria!.map(row => [row.id, row]));
    assert.deepEqual(Object.values(rows).map(row => row.status), ["FAIL", "FAIL", "FAIL", "FAIL"], "every criterion loaded as failing");
    const output = rows.replayed!.output!;
    assert.ok(output.includes("received \"1234,56 €\""), "the failure text is shown");
    assert.ok(Buffer.byteLength(output) <= 2048 && output.startsWith("…"), "only the last 2 KiB");
    assert.doesNotMatch(output, new RegExp(token, "u"), "tokens are redacted again");
    assert.equal(rows.tampered!.output, null, "an artifact that no longer matches its hash name is not shown");
    assert.equal(rows.linked!.output, null, "a symbolic link is never followed");
    assert.equal(rows.plain!.output, null, "plain command evidence has no output");
    assert.doesNotMatch(JSON.stringify(desk), /OUTSIDE FILE CONTENT|EDITED AFTERWARDS/u);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
