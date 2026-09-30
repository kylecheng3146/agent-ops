import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadEffectiveConfig,
  loadProjectHookConfig,
  projectConfigRoot
} from "../../packages/cli/src/context.js";
import { addWorktree } from "../../runtime/src/parallel/service.js";
import { CONFIG, deps, repository, write } from "./fixture.js";

const DISABLED = { ...CONFIG, features: { ...CONFIG.features, completionGate: { enabled: false } } };

async function withHome<T>(action: () => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "agent-ops-home-"));
  const previous = process.env.AGENT_OPS_HOME;
  process.env.AGENT_OPS_HOME = home;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.AGENT_OPS_HOME;
    else process.env.AGENT_OPS_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test("a worktree reads the main checkout's config, not its own copy", async () => {
  const root = await repository();
  try {
    const { record } = await addWorktree(deps(), { cwd: root, name: "alpha", sessionId: "session-one" });
    assert.equal(projectConfigRoot(record.path), root);

    // The copy a branch could edit, or that could go stale, decides nothing.
    await write(record.path, ".agent-ops/config.json", `${JSON.stringify(DISABLED)}\n`);
    await withHome(async () => {
      const hook = await loadProjectHookConfig(record.path);
      assert.equal(hook.kind, "loaded");
      assert.equal(hook.kind === "loaded" && hook.config.features.completionGate.enabled, true);
      assert.equal((await loadEffectiveConfig(record.path, "project")).config.features.completionGate.enabled, true);

      await unlink(join(record.path, ".agent-ops", "config.json"));
      const missing = await loadProjectHookConfig(record.path);
      assert.equal(missing.kind === "loaded" && missing.config.features.completionGate.enabled, true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("outside a worktree, or without a main config, the checkout's own config applies", async () => {
  const root = await repository();
  try {
    assert.equal(projectConfigRoot(root), root);
    assert.equal(projectConfigRoot(tmpdir()), tmpdir());

    const { record } = await addWorktree(deps(), { cwd: root, name: "beta", sessionId: "session-two" });
    await unlink(join(root, ".agent-ops", "config.json"));
    await write(record.path, ".agent-ops/config.json", `${JSON.stringify(DISABLED)}\n`);
    assert.equal(projectConfigRoot(record.path), record.path);
    await withHome(async () => {
      const own = await loadProjectHookConfig(record.path);
      assert.equal(own.kind === "loaded" && own.config.features.completionGate.enabled, false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
