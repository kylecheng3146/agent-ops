import assert from "node:assert/strict";
import {mkdtemp, readdir, rm, stat, writeFile, mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {activityDirectory, beginActivity, readActivities, withActivity} from "../../runtime/src/office/activity.js";

test("an activity record is written privately with allowlisted fields, follows its updates and goes when it ends", async () => {
  const commonDir = await mkdtemp(join(tmpdir(), "agent-ops-activity-"));
  try {
    const handle = await beginActivity(commonDir, {kind: "review", root: "/repo/.worktrees/a", taskId: "task-1", sessionId: "s-1",
      targets: ["agy", "codex"], token: "ghp_secret", command: "rm -rf /"} as never);
    const names = await readdir(activityDirectory(commonDir));
    assert.equal(names.length, 1);
    assert.match(names[0]!, new RegExp(`^review-${process.pid}-\\d+\\.json$`, "u"));
    assert.equal((await stat(join(activityDirectory(commonDir), names[0]!))).mode & 0o777, 0o600, "private to the user");
    let [record] = await readActivities(commonDir);
    assert.deepEqual(Object.keys(record!).sort(), ["kind", "pid", "root", "sessionId", "startedAt", "targets", "taskId"], "only allowlisted fields, no token or command");
    assert.deepEqual(record!.targets, ["agy", "codex"]);
    await handle.update({round: 2, target: "codex"});
    [record] = await readActivities(commonDir);
    assert.equal(record!.round, 2);
    assert.equal(record!.target, "codex");
    await handle.end();
    assert.deepEqual(await readActivities(commonDir), [], "the record goes with the work");
    await assert.rejects(withActivity(commonDir, {kind: "finish", root: "/repo", worktree: "w"}, async () => {
      assert.equal((await readActivities(commonDir))[0]?.worktree, "w");
      throw new Error("merge conflict");
    }), /merge conflict/u);
    assert.deepEqual(await readActivities(commonDir), [], "a throwing command removes its record too");
  } finally {
    await rm(commonDir, {recursive: true, force: true});
  }
});

test("dead processes, malformed files and mismatched names are ignored", async () => {
  const commonDir = await mkdtemp(join(tmpdir(), "agent-ops-activity-stale-"));
  try {
    const directory = activityDirectory(commonDir);
    await mkdir(directory, {recursive: true});
    const record = (pid: number, kind = "verify") => JSON.stringify({kind, pid, root: "/repo", startedAt: "2026-10-09T00:00:00.000Z"});
    await writeFile(join(directory, "verify-4194999-1.json"), record(4194999), {mode: 0o600});
    await writeFile(join(directory, `verify-${process.pid}-2.json`), "{not json", {mode: 0o600});
    await writeFile(join(directory, `finish-${process.pid}-3.json`), record(process.pid, "verify"), {mode: 0o600});
    await writeFile(join(directory, `verify-${process.pid}-4.json`), record(process.pid), {mode: 0o600});
    const live = await readActivities(commonDir, pid => pid === process.pid);
    assert.equal(live.length, 1, "only the live, well-formed, consistently named record");
    assert.equal(live[0]!.kind, "verify");
  } finally {
    await rm(commonDir, {recursive: true, force: true});
  }
});

test("activity records are fail-open: an unwritable place never changes the work or its result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-ops-activity-blocked-"));
  try {
    const blocked = join(dir, "not-a-directory");
    await writeFile(blocked, "a file where the common dir should be");
    const handle = await beginActivity(blocked, {kind: "verify", root: "/repo"});
    await handle.update({taskId: "task-2"});
    await handle.end();
    assert.equal(await withActivity(blocked, {kind: "finish", root: "/repo"}, async () => "merged"), "merged");
    await assert.rejects(withActivity(blocked, {kind: "finish", root: "/repo"}, async () => { throw new Error("finish failed"); }), /finish failed/u,
      "the work's own error passes through unchanged");
    assert.equal(await withActivity(undefined, {kind: "verify", root: "/repo"}, async () => 7), 7, "no common dir, no record, same result");
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});
