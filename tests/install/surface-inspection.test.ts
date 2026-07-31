import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectHarnessSurfaces } from "../../runtime/src/install/surface-inspection.js";

const FIXTURE_ROOT = "tests/fixtures/harness-surfaces";

async function copyFixture(
  root: string,
  source: string,
  target: string
): Promise<void> {
  await mkdir(join(root, target, ".."), { recursive: true });
  await writeFile(
    join(root, target),
    await readFile(join(FIXTURE_ROOT, source), "utf8")
  );
}

test("inventories managed, foreign, missing, and external surfaces without values", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-surfaces-"));
  try {
    await copyFixture(root, "claude-settings.json", ".claude/settings.json");
    await copyFixture(root, "codex-hooks.json", ".codex/hooks.json");
    await copyFixture(
      root,
      "opencode-plugin.js",
      ".opencode/plugins/agent-ops.js"
    );

    const statuses = await inspectHarnessSurfaces({
      root,
      scope: "project",
      harness: ["claude", "codex", "opencode"],
      profiles: ["guardrails"]
    });
    const byKey = new Map(
      statuses.map((status) => [
        `${status.harness}/${status.surfaceId}`,
        status
      ])
    );

    assert.deepEqual(
      byKey.get("claude/claude-settings"),
      {
        harness: "claude",
        surfaceId: "claude-settings",
        path: ".claude/settings.json",
        status: "managed",
        managedHandlerCount: 1,
        foreignHandlerCount: 1
      }
    );
    assert.equal(byKey.get("claude/project-local")?.status, "missing");
    assert.equal(byKey.get("claude/user-settings")?.status, "unknown");
    assert.deepEqual(
      byKey.get("codex/codex-hooks"),
      {
        harness: "codex",
        surfaceId: "codex-hooks",
        path: ".codex/hooks.json",
        status: "managed",
        managedHandlerCount: 1,
        foreignHandlerCount: 1
      }
    );
    assert.equal(byKey.get("opencode/opencode-plugin")?.status, "managed");
    assert.equal(
      JSON.stringify(statuses).includes("foreign-hook-command"),
      false
    );
    assert.equal(
      JSON.stringify(statuses).includes("foreign-permission-entry"),
      false
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe or inaccessible surface files become UNKNOWN", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-surfaces-"));
  const outside = await mkdtemp(join(tmpdir(), "agent-ops-surfaces-outside-"));
  try {
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(outside, "hooks.json"), "{}\n");
    await symlink(
      join(outside, "hooks.json"),
      join(root, ".codex", "hooks.json")
    );
    const statuses = await inspectHarnessSurfaces({
      root,
      scope: "project",
      harness: ["codex"],
      profiles: ["core"]
    });
    assert.equal(statuses[0]?.status, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
