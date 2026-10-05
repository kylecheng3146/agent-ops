import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {mkdtemp, realpath, rm, writeFile, mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {productionRunContext} from "../../packages/cli/src/run-deps.js";
import {createRunState} from "../../runtime/src/run/service.js";
import {nativeProcessIdentity} from "../../runtime/src/run/transport.js";
import {loadEffectiveConfig, repositoryTrustBinding} from "../../packages/cli/src/context.js";
import {trustStore} from "../../packages/cli/src/parallel-deps.js";

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

test("Stop before background provisioning fences the assigned coordinator and explicit resume renews policy", {skip: process.platform !== "darwin"}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ops-early-stop-")));
  const original = {home: process.env.AGENT_OPS_HOME, path: process.env.PATH};
  let enabled = 0, wakes = 0;
  const launchd = {supported: true, writeDescriptor: async () => {}, bootstrap: async () => {},
    enableRestart: async () => {enabled++;}, wake: async () => {wakes++;}, disableRestart: async () => {}, bootout: async () => {}};
  try {
    process.env.AGENT_OPS_HOME = root;
    const git = (args: string[]) => execFileSync("git", args, {cwd: root, stdio: ["ignore", "pipe", "pipe"]});
    git(["init", "-q", "-b", "main"]); git(["config", "user.name", "Recovery fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(root, ".gitignore"), ".agent-ops/\n.worktrees/\nbin/\n");
    await writeFile(join(root, "product.txt"), "fixture\n"); git(["add", "."]); git(["commit", "-qm", "Fixture"]);
    await mkdir(join(root, ".agent-ops"));
    await writeFile(join(root, ".agent-ops/config.json"), JSON.stringify({schemaVersion: 3, profiles: ["core"], verification: {commands: []},
      features: {completionGate: {enabled: false}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: [], worktree: {mode: "auto", setup: []}}));
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/codex"), "#!/bin/sh\nprintf 'fixture-codex-version\\n'\n", {mode: 0o700});
    process.env.PATH = join(root, "bin") + ":" + original.path;
    const config = (await loadEffectiveConfig(root, "project")).config;
    await trustStore().grant(await repositoryTrustBinding(root, config, "0.5.3"));
    const context = await productionRunContext(root, {launchd});
    const started = await context.service.start({root, commonDir: context.commonDir, targetBranch: "main", host: "codex", ownerSessionId: "fixture",
      goal: "Preserve explicit Stop before setup"});
    assert.equal(started.state.workers[0]!.status, "assigned");
    const digest = started.state.policyBinding!.artifactDigest;
    const stopped = await context.service.stop(started.state.runId);
    assert.equal(stopped.state.workers[0]!.status, "stopped");
    assert.ok(stopped.state.workers[0]!.stopIntent!.confirmedDeadAt);
    const resumed = await context.service.resume(started.state.runId);
    assert.equal(resumed.state.status, "active"); assert.equal(resumed.state.disableRestart, false);
    assert.notEqual(resumed.state.policyBinding!.artifactDigest, digest);
    assert.equal(resumed.state.goalHash, started.state.goalHash);
    assert.equal(resumed.state.nativeInstance, "fixture-codex-version");
    assert.equal(enabled, 1); assert.equal(wakes, 1);
    assert.deepEqual(resumed.state.budget.activeIntervals, stopped.state.budget.activeIntervals);
  } finally {
    if (original.home === undefined) delete process.env.AGENT_OPS_HOME; else process.env.AGENT_OPS_HOME = original.home;
    if (original.path === undefined) delete process.env.PATH; else process.env.PATH = original.path;
    await rm(root, {recursive: true, force: true});
  }
});
