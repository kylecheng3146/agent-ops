import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRunState } from "../../runtime/src/run/service.js";
import { NOW, runFixture } from "./fixture.js";
import { buildOfficeSnapshot, narrate, type OfficeDiff } from "../../runtime/src/office/snapshot.js";
import { officeGit, readReviewSlots, worktreeDiff } from "../../runtime/src/office/collect.js";


function diff(paths: string[], recent = paths[0] ?? null): OfficeDiff {
  return {files: paths.length, insertions: 3, deletions: 1, paths, recent};
}

test("narration is inferred from changed paths only", () => {
  assert.equal(narrate(diff(["docs/en/spec/review.md"])), "writing docs");
  assert.equal(narrate(diff(["tests/office/a.test.ts"])), "writing tests");
  assert.equal(narrate(diff(["src/a.ts", "docs/b.md"], "src/a.ts")), "editing src/a.ts");
  assert.equal(narrate(diff([])), null);
  assert.equal(narrate(null), null);
});

test("snapshot aggregates runs, run worktrees, lobby desks and review slots", () => {
  const legacy = createRunState({root: "/repo", commonDir: "/repo/.git", targetBranch: "main", goal: "Old run",
    host: "codex", ownerSessionId: "o2", runId: "run-legacy-fixture", now: "2026-10-07T00:00:00.000Z"});
  const finished = {...createRunState({root: "/repo", commonDir: "/repo/.git", targetBranch: "main", goal: "Done long ago",
    host: "codex", ownerSessionId: "o3", runId: "run-finished-fixture", now: "2026-10-01T00:00:00.000Z"}), status: "complete" as const};
  const snapshot = buildOfficeSnapshot({now: NOW, runs: [runFixture(), legacy, finished],
    worktrees: [
      {name: "coord", path: "/repo/.worktrees/coord", branch: "b1", sessionId: "owner", runId: "run-office-fixture", diff: diff(["tests/x.test.ts", "src/y.ts"])},
      {name: "child", path: "/repo/.worktrees/child", branch: "b2", sessionId: "s2", runId: "run-office-fixture", diff: diff(["docs/z.md"])},
      {name: "session-1", path: "/repo/.worktrees/session-1", branch: "b3", sessionId: "s3", diff: diff(["src/app.ts"])}],
    reviews: [{slot: 0, since: "2026-10-07T00:50:00.000Z", taskId: "root", root: "/repo/.worktrees/coord"},
      {slot: 1, since: "2026-10-07T00:55:00.000Z", taskId: "other", root: "/elsewhere"}]});
  assert.deepEqual(snapshot.runs.map(r => r.runId), ["run-office-fixture", "run-legacy-fixture"]);
  const [run, old] = snapshot.runs;
  assert.equal(run!.title, "Goal: office view");
  assert.equal(run!.phase, "verifying");
  assert.equal(old!.phase, "unknown");
  assert.deepEqual(run!.budget, {limitMs: 3600000, usedMs: 1200000, remainingMs: 2400000});
  assert.deepEqual(run!.agents.map(a => [a.id, a.role, a.phase, a.worktree, a.narration]), [
    ["coordinator-run-office-fixture", "coordinator", "verifying", "coord", "writing tests"],
    ["w1", "worker", "unknown", "child", "writing docs"]]);
  assert.deepEqual(run!.agents[0]!.progress, {verify: "PASS", review: null, passed: 2, total: 6});
  assert.equal(run!.agents[0]!.diff!.files, 2);
  assert.deepEqual(run!.questions, [{questionId: "q-1", prompt: "Which port?"}]);
  assert.ok(run!.commands.includes(`agent-ops run respond run-office-fixture --question-id 'q-1' --answer "..."`));
  assert.ok(run!.commands.includes("agent-ops run resume run-office-fixture"));
  assert.ok(run!.commands.includes("agent-ops run stop run-office-fixture"));
  assert.deepEqual(run!.reviewers.map(r => r.slot), [0]);
  assert.deepEqual(snapshot.reviews.map(r => r.slot), [1]);
  assert.deepEqual(snapshot.lobby.map(d => [d.name, d.narration]), [["session-1", "editing src/app.ts"]]);
  assert.ok(snapshot.lobby[0]!.commands.includes("agent-ops worktree finish 'session-1'"));
});

test("worktree diff counts committed, uncommitted and untracked paths and finds the newest", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-office-diff-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, {cwd: root, encoding: "utf8"}).trim();
    git("init", "-q"); git("config", "user.email", "t@example.com"); git("config", "user.name", "T");
    await writeFile(join(root, "a.txt"), "a\n");
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "guide.md"), "one\ntwo\n");
    git("add", "."); git("commit", "-qm", "docs");
    await writeFile(join(root, "a.txt"), "b\n");
    await writeFile(join(root, "new.ts"), "x\n");
    const old = new Date("2000-01-01T00:00:00.000Z");
    await utimes(join(root, "a.txt"), old, old);
    await utimes(join(root, "new.ts"), old, old);
    const result = await worktreeDiff(officeGit, root, base);
    assert.deepEqual([...result.paths].sort(), ["a.txt", "docs/guide.md", "new.ts"]);
    assert.equal(result.files, 3);
    assert.equal(result.insertions, 3);
    assert.equal(result.deletions, 1);
    assert.equal(result.recent, "docs/guide.md");
    const injected = await worktreeDiff(officeGit, root, "--output=" + join(root, "pwned"));
    assert.deepEqual(injected.paths, ["new.ts"]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("only review slots held by a live process are reported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-ops-office-slots-"));
  try {
    await mkdir(join(dir, "agent-ops-review-slot-0.lock"));
    await writeFile(join(dir, "agent-ops-review-slot-0.lock", "owner.json"),
      JSON.stringify({pid: process.pid, at: NOW, token: "t", taskId: "task-1", root: "/repo/.worktrees/a"}));
    await mkdir(join(dir, "agent-ops-review-slot-1.lock"));
    await writeFile(join(dir, "agent-ops-review-slot-1.lock", "owner.json"), JSON.stringify({pid: 2 ** 22 + 12345, at: NOW}));
    assert.deepEqual(await readReviewSlots(dir), [{slot: 0, since: new Date(NOW).toISOString(), taskId: "task-1", root: "/repo/.worktrees/a"}]);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
