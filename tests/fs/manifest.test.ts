import assert from "node:assert/strict";
import test from "node:test";

import {
  formatInstallManifest,
  parseInstallManifest
} from "../../runtime/src/fs/manifest.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";

function legacy(harness: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    scope: "project",
    harness,
    artifacts: [
      {
        id: "config",
        path: ".agent-ops/config.json",
        hash: "b".repeat(64),
        owner: "agent-ops"
      }
    ],
    markers: []
  });
}

test("migrates a pre-0.1.5 single-harness manifest to a list", () => {
  assert.deepEqual(parseInstallManifest(legacy("both")).harness, [
    "codex",
    "claude"
  ]);
  assert.deepEqual(parseInstallManifest(legacy("codex")).harness, ["codex"]);
  assert.deepEqual(parseInstallManifest(legacy("claude")).harness, ["claude"]);
  assert.equal(parseInstallManifest(legacy("both")).schemaVersion, 2);
});

test("rejects a legacy manifest naming an unsupported harness", () => {
  assert.throws(
    () => parseInstallManifest(legacy("aider")),
    (error: unknown) =>
      error instanceof AgentOpsError && error.code === "MANIFEST_INVALID"
  );
});

test("writes only the current manifest shape", () => {
  const migrated = parseInstallManifest(legacy("both"));
  const written = JSON.parse(formatInstallManifest(migrated)) as {
    schemaVersion: number;
    harness: string[];
  };
  assert.equal(written.schemaVersion, 2);
  assert.deepEqual(written.harness, ["codex", "claude"]);
});
