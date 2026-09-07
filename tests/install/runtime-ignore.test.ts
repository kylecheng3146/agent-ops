import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyInstallPlan } from "../../runtime/src/install/apply.js";
import { commonHarnessAdapters } from "../../runtime/src/install/harness.js";
import { createInstallPlan } from "../../runtime/src/install/plan.js";
import { applyUpdatePlan, createUpdatePlan } from "../../runtime/src/install/update.js";
import { applyUninstallPlan, createUninstallPlan } from "../../runtime/src/install/uninstall.js";
import { collectChangeSurface } from "../../runtime/src/verify/change-surface.js";

for (const harness of ["codex", "claude", "agy", "opencode"] as const) {
  test(`${harness} core install ignores runtime but rejects forced tracking until untracked`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-ops-runtime-ignore-"));
    const git = (args: readonly string[]) => execFileSync("git", [...args], { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });
    const runner = { run: async (args: readonly string[]) => ({ exitCode: 0, stdout: git(args) }) };
    try {
      await applyInstallPlan(root, await createInstallPlan({ root, scope: "project", harness: [harness], profiles: ["core"], adapters: commonHarnessAdapters() }));
      for (const directory of ["tasks", "reviews"]) {
        await mkdir(join(root, ".agent-ops", directory), { recursive: true });
        await writeFile(join(root, ".agent-ops", directory, "runtime.json"), "{}\n");
      }
      git(["init"]);
      git(["add", "-A"]);
      assert.equal(git(["ls-files", "--", ".agent-ops/tasks/", ".agent-ops/reviews/"]).length, 0);
      assert.ok((await collectChangeSurface(runner)).paths.includes(".agent-ops/config.json"));
      git(["add", "-f", ".agent-ops/tasks/runtime.json"]);
      await assert.rejects(collectChangeSurface(runner), { code: "CHANGE_SURFACE_TRACKED_RUNTIME" });
      git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "tracked runtime"]);
      await assert.rejects(collectChangeSurface(runner), { code: "CHANGE_SURFACE_TRACKED_RUNTIME" });
      git(["rm", "-r", "--cached", "--ignore-unmatch", "--", ".agent-ops/tasks/", ".agent-ops/reviews/"]);
      // Finish the cleanup commit before producing proof; local runtime survives.
      await assert.rejects(collectChangeSurface(runner), { code: "CHANGE_SURFACE_TRACKED_RUNTIME" });
      git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "untrack runtime"]);
      assert.deepEqual((await collectChangeSurface(runner)).paths, []);
      assert.equal(await readFile(join(root, ".agent-ops/tasks/runtime.json"), "utf8"), "{}\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("legacy update adds runtime ignores; selective uninstall retains them; full uninstall preserves runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-runtime-migration-"));
  try {
    const options = { root, scope: "project" as const, harness: ["agy", "claude"] as ("agy" | "claude")[], profiles: ["core"] as "core"[], adapters: commonHarnessAdapters() };
    await applyInstallPlan(root, await createInstallPlan(options));
    const manifestPath = join(root, ".agent-ops/manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.artifacts = manifest.artifacts.filter((artifact: { id: string }) => artifact.id !== "runtime-ignore");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(createUpdatePlan({ root, adapters: commonHarnessAdapters(), targetVersion: "0.1.22" }), { code: "UNMANAGED_INSTALL_PATH" });
    assert.equal(await readFile(join(root, ".agent-ops/.gitignore"), "utf8"), "/tasks/\n/reviews/\n");
    await rm(join(root, ".agent-ops/.gitignore"));
    await applyUpdatePlan(root, await createUpdatePlan({ root, adapters: commonHarnessAdapters(), targetVersion: "0.1.22" }));
    assert.equal(await readFile(join(root, ".agent-ops/.gitignore"), "utf8"), "/tasks/\n/reviews/\n");
    await applyUninstallPlan(root, await createUninstallPlan(root, ["claude"]));
    assert.equal(await readFile(join(root, ".agent-ops/.gitignore"), "utf8"), "/tasks/\n/reviews/\n");
    await mkdir(join(root, ".agent-ops/tasks"), { recursive: true });
    await writeFile(join(root, ".agent-ops/tasks/state.json"), "{}\n");
    await applyUninstallPlan(root, await createUninstallPlan(root));
    await assert.rejects(readFile(join(root, ".agent-ops/.gitignore")), { code: "ENOENT" });
    assert.equal(await readFile(join(root, ".agent-ops/tasks/state.json"), "utf8"), "{}\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
