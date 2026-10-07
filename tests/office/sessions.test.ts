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
    assert.equal((await readOfficeSessions(commonDir, started + OFFICE_SESSION_RETENTION_MS + 2)).length, 0);

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
