import assert from "node:assert/strict";
import {mkdtemp, rm, writeFile, readFile, mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {TaskService} from "../../runtime/src/task/service.js";
import {FileTaskStore} from "../../runtime/src/task/store.js";
import {DEFAULT_CONFIG} from "../../packages/cli/src/context.js";
import {createRunState, FileRunRepository} from "../../runtime/src/run/service.js";
import {runControlledStep, runCriteriaStep} from "../../packages/cli/src/run-entry.js";
import {nativeProcessIdentity} from "../../runtime/src/run/transport.js";

test("native advisory ignores an exhausted legacy budget, registers its process, and stop prevents writer activation", {skip: process.platform === "win32"}, async () => {
  const root = await mkdtemp(join(tmpdir(), "criteria-native-"));
  const repository = new FileRunRepository(join(root, "runs"), root);
  const initial = createRunState({root, commonDir: root, targetBranch: "main", goal: "Review before editing", host: "codex", ownerSessionId: "owner"});
  const state = {...initial, budget: {...initial.budget, limitMs: 1, accumulatedMs: 2, activeIntervals: [{startMs: Date.now() - 100, endMs: null}]}};
  const cli = fileURLToPath(new URL("../../packages/cli/src/bin.js", import.meta.url)), marker = join(root, "started");
  const prior = {path: process.env.PATH, home: process.env.AGENT_OPS_HOME};
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin/codex"), `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid, proofPid:Number(process.env.AGENT_OPS_RUN_PROOF_PID)})); setInterval(()=>{},1000);`, {mode: 0o700});
  process.env.PATH = join(root, "bin") + ":" + prior.path;
  process.env.AGENT_OPS_HOME = root;
  const tasks = new TaskService(new FileTaskStore(join(root, ".agent-ops/tasks/state.json"), root), {generateId: () => "task-root"});
  await tasks.create({title: "Review before writing", goal: state.goal, criteria: ["one", "two"].map(id => ({id, description: id + " behavior", verifierIds: ["unit"]}))});
  await writeFile(join(root, ".agent-ops/config.json"), JSON.stringify({...DEFAULT_CONFIG, reviewRoles: [{role: "independent-review", targets: ["codex"]}]}));
  await repository.create(state);
  try {
    let writerStarted = false;
    const pending = runCriteriaStep(repository, state.runId, root, "task-root", (cwd, args, saved) => runControlledStep(repository, cli, cwd, args, saved))
      .then(() => {writerStarted = true;});
    // Attach the rejection immediately; stopping below must prevent activation.
    const outcome = pending.then(() => null, error => error);
    let pid: number | undefined;
    for (let i = 0; i < 150; i++) {try {const value = JSON.parse(await readFile(marker, "utf8")); pid = value.pid; break;} catch {await delay(20);}}
    assert.ok(pid, "criteria process starts despite finite exhausted legacy budget");
    const running = (await repository.read(state.runId))!;
    assert.ok(running.proofProcess);
    assert.notEqual(running.proofProcess.processId, pid);
    assert.equal(running.proofProcess.processIdentity, await nativeProcessIdentity(running.proofProcess.processId));
    await repository.mutate(state.runId, current => ({...current, disableRestart: true}));
    assert.ok(await outcome, "run stop rejects pre-edit review instead of activating writer");
    assert.equal(writerStarted, false);
    assert.equal((await repository.read(state.runId))!.proofProcess, null);
    assert.equal(await nativeProcessIdentity(pid), null);
    await assert.rejects(runControlledStep(repository, cli, root, ["verify", "--task", "task-root"], state), {code: "RUN_BUDGET_EXHAUSTED"});
  } finally {
    if (prior.path === undefined) delete process.env.PATH; else process.env.PATH = prior.path;
    if (prior.home === undefined) delete process.env.AGENT_OPS_HOME; else process.env.AGENT_OPS_HOME = prior.home;
    await rm(root, {recursive: true, force: true});
  }
});

test("native advisory errors fail open while cancellation and existing process ownership are preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "criteria-native-errors-"));
  const repository = new FileRunRepository(join(root, "runs"), root);
  const state = createRunState({root, commonDir: root, targetBranch: "main", goal: "Scoped criteria", host: "codex", ownerSessionId: "owner"});
  await repository.create(state);
  try {
    const failed = await runCriteriaStep(repository, state.runId, root, "task-child", async () => {throw new Error("Transport unavailable");});
    assert.match(JSON.stringify(failed), /CRITERIA_REVIEW_NOT_RUN/);
    await assert.rejects(runCriteriaStep(repository, state.runId, root, "task-child", async () => ({status: "error", code: "CRITERIA_REVIEW_CANCELLED"})), {code: "RUN_CRITERIA_STOPPED"});
    const owner = {processId: process.pid, processIdentity: (await nativeProcessIdentity(process.pid))!};
    await repository.mutate(state.runId, current => ({...current, proofProcess: owner}));
    let started = false;
    const busy = await runCriteriaStep(repository, state.runId, root, "task-child", async () => {started = true; throw new Error();});
    assert.equal(started, false); assert.match(JSON.stringify(busy), /NOT_RUN/);
    assert.deepEqual((await repository.read(state.runId))!.proofProcess, owner);
  } finally {await rm(root, {recursive: true, force: true});}
});
