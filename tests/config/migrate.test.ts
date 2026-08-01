import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  loadConfigFile
} from "../../runtime/src/config/load.js";
import {
  previewConfigMigration
} from "../../runtime/src/config/migrate.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      resolve("tests", "fixtures", "migrations", name),
      "utf8"
    )
  ) as unknown;
}

test("previews a pure sequential migration from v0 to v2", async () => {
  const input = await fixture("config-v0.json");
  const expected = await fixture("config-v2.json");
  const before = JSON.stringify(input);

  const preview = previewConfigMigration(input);

  assert.deepEqual(preview.migrated, expected);
  assert.deepEqual(preview.steps, [
    { fromVersion: 0, toVersion: 1 },
    { fromVersion: 1, toVersion: 2 }
  ]);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(preview.migrated, input);
});

test("loads migrated config without mutating the source file", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-config-"));
  try {
    const path = join(root, "config.json");
    const source = `${JSON.stringify(await fixture("config-v0.json"), null, 2)}\n`;
    await writeFile(path, source);

    const loaded = await loadConfigFile(path);

    assert.equal(loaded.config.schemaVersion, 2);
    assert.deepEqual(loaded.migration.steps, [
      { fromVersion: 0, toVersion: 1 },
      { fromVersion: 1, toVersion: 2 }
    ]);
    assert.equal(await readFile(path, "utf8"), source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unknown future schema versions", () => {
  assert.throws(
    () => previewConfigMigration({ schemaVersion: 3 }),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "CONFIG_SCHEMA_FUTURE"
  );
});

test("migrates every v1 config to Stop-disabled v2 without inferring consent", async () => {
  const input = (await fixture("config-v1.json")) as Record<string, unknown>;
  input.profiles = ["guardrails"];

  const preview = previewConfigMigration(input);

  assert.deepEqual(preview.migrated.features, {
    stopVerification: { enabled: false }
  });
  assert.equal(preview.migrated.schemaVersion, 2);
});
