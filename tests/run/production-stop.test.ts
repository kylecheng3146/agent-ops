import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {productionRunContext} from "../../packages/cli/src/run-deps.js";
import {createRunState} from "../../runtime/src/run/service.js";
import {nativeProcessIdentity} from "../../runtime/src/run/transport.js";

test("production stop kills the registered proof group and closes budget even when launchd disable and bootout fail", {skip: process.platform !== "darwin"}, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-production-stop-"));
  const git = (args: string[]) => execFileSync("git", args, {cwd: root, stdio: ["ignore", "pipe", "pipe"]});
  let bootout = 0;
  const launchd = {supported: true, writeDescriptor: async () => {}, bootstrap: async () => {}, enableRestart: async () => {}, wake: async () => {},
    disableRestart: async () => {throw new Error("injected launchd disable failure");}, bootout: async () => {bootout++; throw new Error("injected bootout failure");}};
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {detached: true, stdio: "ignore"});
  try {
    git(["init", "-q", "-b", "main"]); git(["config", "user.name", "Run fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(root, "product.txt"), "fixture\n"); git(["add", "."]); git(["commit", "-qm", "Fixture"]);
    const context = await productionRunContext(root, {launchd});
    const identity = await nativeProcessIdentity(child.pid!);
    assert.ok(identity);
    const state = createRunState({root, commonDir: context.commonDir, targetBranch: "main", goal: "Stop every executor", host: "codex", ownerSessionId: "owner"});
    const startMs = Date.now() - 100;
    await context.repository.create({...state, proofProcess: {processId: child.pid!, processIdentity: identity},
      budget: {...state.budget, activeIntervals: [{startMs, endMs: null}]}});
    await assert.rejects(context.service.stop(state.runId), {code: "RUN_SUPERVISOR_DISABLE_FAILED"});
    const saved = (await context.repository.read(state.runId))!;
    assert.equal(saved.status, "paused"); assert.equal(saved.disableRestart, true);
    assert.equal(saved.proofProcess, null); assert.ok(saved.budget.accumulatedMs >= 100);
    assert.ok(saved.budget.activeIntervals.every(i => i.endMs !== null));
    assert.equal(await nativeProcessIdentity(child.pid!), null);
    assert.equal(bootout, 1);
    assert.equal(saved.events.at(-1)!.code, "RUN_SUPERVISOR_DISABLE_FAILED");
  } finally {
    try {process.kill(-child.pid!, "SIGKILL");} catch {}
    await rm(root, {recursive: true, force: true});
  }
});
