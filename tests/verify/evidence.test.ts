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

import type {
  AgentOpsConfig,
  VerificationCommand
} from "../../runtime/src/contracts.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import {
  buildVerificationEvidence,
  FileEvidenceStore
} from "../../runtime/src/verify/evidence.js";

const SECRET = `ghp_${"a".repeat(24)}`;
const CONFIG: AgentOpsConfig = {
  schemaVersion: 1,
  profiles: ["core"],
  verification: { commands: [] },
  pathMappings: [],
  securityExceptions: []
};

function command(): VerificationCommand {
  return {
    id: "unit",
    command: "node",
    args: ["--test", `--token=${SECRET}`],
    cwd: ".",
    required: true,
    evidence: { kind: "test-count", minimum: 1 }
  };
}

test("builds validated evidence without retaining secret-bearing argv", () => {
  const evidence = buildVerificationEvidence({
    taskId: "task-one",
    criterionId: "criterion-one",
    command: command(),
    scope: "project",
    startedAt: "2026-07-23T12:00:00.000Z",
    finishedAt: "2026-07-23T12:00:01.000Z",
    exitCode: 0,
    testCount: 2,
    toolVersions: {
      node: "v22.14.0",
      helper: `token=${SECRET}`,
      [`tool-${SECRET}`]: "v1.0.0"
    },
    config: CONFIG
  });

  assert.equal(evidence.argv[0], "node");
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(SECRET));
  assert.match(evidence.argv[2] ?? "", /\[REDACTED_/);
  assert.match(evidence.toolVersions.helper ?? "", /\[REDACTED_/);
  assert.equal(
    Object.keys(evidence.toolVersions).some((key) =>
      key.includes(SECRET)
    ),
    false
  );
  assert.match(evidence.configHash, /^[a-f0-9]{64}$/);
});

test("persists validated evidence in an owner-only deterministic path", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-evidence-"));
  try {
    const evidence = buildVerificationEvidence({
      taskId: "task-one",
      criterionId: "criterion-one",
      command: command(),
      scope: "project",
      startedAt: "2026-07-23T12:00:00.000Z",
      finishedAt: "2026-07-23T12:00:01.000Z",
      exitCode: 0,
      testCount: 2,
      toolVersions: { node: "v22.14.0" },
      config: CONFIG
    });
    const store = new FileEvidenceStore(root, root);
    const first = await store.save(evidence);
    const second = await store.save(evidence);

    assert.equal(first, second);
    assert.match(
      first,
      /^\.agent-ops\/tasks\/evidence\/task-one\/unit-[a-f0-9]{16}\.json$/
    );
    const absolute = join(root, ...first.split("/"));
    assert.deepEqual(
      JSON.parse(await readFile(absolute, "utf8")) as unknown,
      evidence
    );
    if (process.platform !== "win32") {
      assert.equal((await lstat(absolute)).mode & 0o777, 0o600);
      assert.equal(
        (await lstat(join(absolute, ".."))).mode & 0o777,
        0o700
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid evidence before persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-evidence-"));
  try {
    const store = new FileEvidenceStore(root, root);
    await assert.rejects(
      store.save({
        schemaVersion: 1,
        taskId: "INVALID",
        criterionId: "criterion-one",
        commandId: "unit",
        argv: ["node", "--test"],
        cwd: ".",
        scope: "project",
        startedAt: "2026-07-23T12:00:00.000Z",
        finishedAt: "2026-07-23T12:00:01.000Z",
        exitCode: 0,
        testCount: 1,
        toolVersions: { node: "v22.14.0" },
        configHash: "a".repeat(64)
      }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "EVIDENCE_INVALID"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
