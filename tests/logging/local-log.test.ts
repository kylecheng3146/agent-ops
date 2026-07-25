import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendLocalLog,
  type LocalLogEvent
} from "../../runtime/src/logging/local-log.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";

test("writes only allowlisted redacted event fields with private permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-log-"));
  try {
    const path = join(root, "private", "events.ndjson");
    const syntheticHeader = [
      "Authorization",
      ": Bearer synthetic-header-value"
    ].join("");
    await appendLocalLog(
      path,
      {
        type: "trust-change",
        action: "grant",
        remoteIdentity: syntheticHeader,
        result: "changed"
      },
      { anchorDirectory: root, now: "2026-07-23T00:00:00Z" }
    );
    const content = await readFile(path, "utf8");
    assert.doesNotMatch(content, /synthetic-header-value/);
    assert.match(content, /"type":"trust-change"/);
    if (process.platform !== "win32") {
      assert.equal((await lstat(join(root, "private"))).mode & 0o777, 0o700);
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
    }

    await assert.rejects(
      appendLocalLog(
        path,
        {
          type: "diagnostic",
          code: "BAD",
          message: "safe",
          prompt: "must not persist"
        } as unknown as LocalLogEvent,
        { anchorDirectory: root }
      ),
      (error: unknown) =>
        error instanceof AgentOpsError && error.code === "LOG_EVENT_INVALID"
    );
    await assert.rejects(
      appendLocalLog(
        path,
        {
          type: "diagnostic",
          code: "RAW_CONTENT",
          message: "non-secret raw command output"
        } as unknown as LocalLogEvent,
        { anchorDirectory: root }
      ),
      (error: unknown) =>
        error instanceof AgentOpsError && error.code === "LOG_EVENT_INVALID"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prunes local logs by age and total bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-log-"));
  try {
    const path = join(root, "events.ndjson");
    await appendLocalLog(
      path,
      { type: "diagnostic", code: "OLD" },
      {
        now: "2026-07-20T00:00:00Z",
        anchorDirectory: root,
        maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
        maxBytes: 320
      }
    );
    for (let index = 0; index < 5; index += 1) {
      await appendLocalLog(
        path,
        {
          type: "diagnostic",
          code: `NEW-${index}`
        },
        {
          now: `2026-07-23T00:00:0${index}Z`,
          anchorDirectory: root,
          maxAgeMs: 24 * 60 * 60 * 1_000,
          maxBytes: 320
        }
      );
    }
    const content = await readFile(path, "utf8");
    assert.doesNotMatch(content, /"code":"OLD"/);
    assert.match(content, /"code":"NEW-4"/);
    assert.ok(Buffer.byteLength(content) <= 320);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent appends without dropping events", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-log-"));
  try {
    const path = join(root, "events.ndjson");
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        appendLocalLog(
          path,
          {
            type: "diagnostic",
            code: `EVENT-${index}`
          },
          {
            now: `2026-07-23T00:00:${String(index).padStart(2, "0")}Z`,
            anchorDirectory: root,
            maxBytes: 16_384
          }
        )
      )
    );

    const content = await readFile(path, "utf8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 12);
    for (let index = 0; index < 12; index += 1) {
      assert.match(content, new RegExp(`"code":"EVENT-${index}"`));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
