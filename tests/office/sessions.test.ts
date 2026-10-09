import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {
  OFFICE_SESSION_RETENTION_MS,
  OFFICE_SESSION_STALE_MS,
  readOfficeSessions,
  recordOfficeSession
} from "../../runtime/src/office/sessions.js";

test("session registry keeps idle turns and prunes stale active sessions", async () => {
  const commonDir = await mkdtemp(join(tmpdir(), "agent-ops-office-sessions-"));
  try {
    const started = Date.parse("2026-10-07T00:00:00.000Z");
    await recordOfficeSession({
      commonDir,
      projectRoot: "/repo",
      sessionId: "session-a",
      harness: "claude",
      event: "start",
      now: started
    });
    await recordOfficeSession({
      commonDir,
      projectRoot: "/repo",
      sessionId: "session-a",
      harness: "claude",
      event: "stop",
      now: started + 1
    });
    assert.equal((await readOfficeSessions(commonDir, started + OFFICE_SESSION_STALE_MS + 1))[0]?.status, "idle");
    assert.equal((await readOfficeSessions(commonDir, started + OFFICE_SESSION_STALE_MS + 2)).length, 0,
      "an idle session that never ended leaves with the active TTL");

    await recordOfficeSession({
      commonDir,
      projectRoot: "/repo",
      sessionId: "session-b",
      harness: "codex",
      event: "start",
      now: started
    });
    const visible = await readOfficeSessions(commonDir, started + OFFICE_SESSION_STALE_MS + 1);
    assert.deepEqual(visible.map(record => record.sessionId), ["session-a"]);
  } finally {
    await rm(commonDir, {recursive: true, force: true});
  }
});

test("a started session is idle until it shows activity", async () => {
  const commonDir = await mkdtemp(join(tmpdir(), "agent-ops-office-start-"));
  try {
    const record = (event: "start" | "activity" | "stop" | "end", now: number) => recordOfficeSession({
      sessionId: "s", harness: "claude", projectRoot: "/repo", commonDir, event, now});
    const status = async (now: number) => (await readOfficeSessions(commonDir, now))[0]?.status;
    await record("start", 1_000);
    assert.equal(await status(1_001), "idle", "a window waiting at its prompt is not working");
    await record("activity", 2_000);
    assert.equal(await status(2_001), "active");
    await record("stop", 3_000);
    assert.equal(await status(3_001), "idle");
    await record("end", 4_000);
    assert.equal(await status(4_001), "idle");
  } finally {
    await rm(commonDir, {recursive: true, force: true});
  }
});

test("a session's end closes its room until it starts again", async () => {
  const commonDir = await mkdtemp(join(tmpdir(), "agent-ops-office-end-"));
  try {
    const record = (event: "start" | "activity" | "end", now: number) => recordOfficeSession({
      sessionId: "s", harness: "claude", projectRoot: "/repo", commonDir, event, now});
    await record("start", 1_000);
    await record("end", 2_000);
    const ended = (await readOfficeSessions(commonDir, 3_000))[0]!;
    assert.deepEqual([ended.status, ended.completedAt], ["idle", new Date(2_000).toISOString()]);
    assert.equal((await readOfficeSessions(commonDir, 2_000 + OFFICE_SESSION_RETENTION_MS - 1)).length, 1, "an ended room stays recent");
    assert.equal((await readOfficeSessions(commonDir, 2_000 + OFFICE_SESSION_RETENTION_MS)).length, 0);
    await record("start", 4_000);
    assert.equal((await readOfficeSessions(commonDir, 5_000))[0]!.completedAt, undefined);
  } finally {
    await rm(commonDir, {recursive: true, force: true});
  }
});
