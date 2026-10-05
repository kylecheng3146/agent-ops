import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {CodexGoalHost} from "../../runtime/src/run/hosts/codex.js";
import {parseArgs} from "../../packages/cli/src/args.js";
import {FileRunRepository, createRunState, RunService} from "../../runtime/src/run/service.js";
import {RunSupervisor} from "../../runtime/src/run/supervisor.js";
import {NativeRunTransport, nativeProcessIdentity} from "../../runtime/src/run/transport.js";
import type {NativeGoalHost, NativeGoalHandle} from "../../runtime/src/run/hosts/types.js";

test("run parser separates native start options from persistent control actions", () => {
  const args = parseArgs(["run", "Goal", "--host", "claude", "--time-budget", "60m", "--jobs", "2", "--wait"]);
  assert.equal(args.command, "run"); assert.equal(args.host, "claude");
  assert.equal(args.timeBudgetMs, 3600000); assert.equal(args.wait, true);
  assert.equal(parseArgs(["run", "stop", "run-12345678"]).runAction, "stop");
  assert.equal(parseArgs(["run", "respond", "run-12345678", "--question-id", "q1", "--answer", "yes"]).answer, "yes");
  for (const invalid of [["Goal"], ["Goal", "--host", "agy"], ["Goal", "--host", "codex", "--jobs", "3"],
    ["Goal", "--host", "codex", "--time-budget", "25h"], ["stop", "run-12345678", "--host", "codex"],
    ["respond", "run-12345678", "--question-id", "q1"], ["Goal", "--host", "codex", "--host", "claude"]])
    assert.throws(() => parseArgs(["run", ...invalid]));
});

test("Stop can reconcile a registered native group while the Codex handshake is still pending", {skip: process.platform === "win32"}, async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-startup-ownership-"));
  const repository = new FileRunRepository(join(root, "runs"), root);
  const state = createRunState({root, commonDir: root, targetBranch: "main", goal: "Own pending native startup", host: "codex", ownerSessionId: "owner", contractHash: "a".repeat(64)});
  await repository.create({...state, tasks: [{taskId: "task-one", dependencies: [], status: "ready", workerId: null,
    deliveryDigest: null, sourceCommit: null, blockedReason: null}]});
  const host = new CodexGoalHost({command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], requestTimeoutMs: 5000});
  const bridge = new NativeRunTransport(host, repository), supervisor = new RunSupervisor({repository, host: bridge});
  try {
    const registration = await supervisor.registerWorker(state.runId, {taskId: "task-one", ownerSessionId: "owner-one", worktree: root});
    const starting = supervisor.startWorker(state.runId, registration.workerId, registration.generation, "Goal");
    const rejected = assert.rejects(starting, {code: "RUN_NATIVE_START_FAILED"});
    let provisional;
    for (let i = 0; i < 100; i++) {
      provisional = (await repository.read(state.runId))!.workers[0]!;
      if (provisional.processId !== null) break;
      await delay(20);
    }
    assert.ok(provisional?.processId); assert.equal(provisional.status, "starting");
    assert.equal(provisional.nativeSessionId, "owner-one"); assert.equal(provisional.nativeJobId, null);
    await new RunService(repository).stop(state.runId);
    const recoveredBridge = new NativeRunTransport(new CodexGoalHost(), repository);
    await new RunSupervisor({repository, host: recoveredBridge}).stopWorker(state.runId, registration.workerId, registration.generation, "stop");
    await rejected;
    assert.equal(await nativeProcessIdentity(provisional.processId), null);
    assert.equal((await repository.read(state.runId))!.workers[0]!.status, "stopped", "late startup failure cannot overwrite the stopped worker");
    await new RunService(repository).resume(state.runId);
    const reassigned = await supervisor.reassignWorker(state.runId, registration.workerId, registration.generation);
    assert.equal(reassigned.nativeSessionId, null, "a dead unopened Codex process must permit fresh initialization at the new lease");
    assert.equal(reassigned.generation, registration.generation + 1);
  } finally {
    const saved = (await repository.read(state.runId))?.workers[0];
    if (saved?.processId != null) try {process.kill(-saved.processId, "SIGKILL");} catch {}
    await rm(root, {recursive: true, force: true});
  }
});

test("native activation requires a persisted lease and rejects a stop racing activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-transport-"));
  const repository = new FileRunRepository(join(root, "runs"), root);
  const state = createRunState({root, commonDir: root, targetBranch: "main", goal: "Fixed goal", host: "codex", ownerSessionId: "session-test", contractHash: "a".repeat(64)});
  await repository.create(state);
  await repository.mutate(state.runId, current => ({...current, tasks: [{taskId: "task-one", dependencies: [], status: "ready", workerId: null,
    deliveryDigest: null, sourceCommit: null, blockedReason: null}]}));
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {stdio: "pipe"});
  let activated = 0;
  const action = {actionId: "action", accepted: true, nativeStatus: "active" as const, payload: null};
  const host: NativeGoalHost = {kind: "codex", start: async input => {
    assert.equal(input.objective, undefined);
    assert.equal(input.env?.AGENT_OPS_SESSION_ID, "owner-one");
    assert.equal(input.env?.CODEX_THREAD_ID, undefined);
    assert.equal(input.env?.AGENT_OPS_RUN_ID, state.runId);
    return {...input, kind: "codex", sessionId: "native-one", threadId: "thread-one", nativeVersion: "test", processId: child.pid!,
      process: child, startedAt: new Date().toISOString(), goalStatus: "unknown"};
  }, activate: async () => {activated++; return action;}, update: async () => action,
    observe: async function* () {}, interrupt: async () => action, stop: async () => {
      child.kill("SIGTERM"); await new Promise(resolve => child.once("exit", resolve)); return action;
    }, resume: async (_input, threadId) => {assert.equal(threadId, "thread-one"); throw new Error("resume observed");}};
  const bridge = new NativeRunTransport(host, repository, async () => {}, async () => child.exitCode === null && child.signalCode === null ? "process-instance-one" : null);
  const supervisor = new RunSupervisor({repository, host: bridge});
  try {
    const registration = await supervisor.registerWorker(state.runId, {taskId: "task-one", ownerSessionId: "owner-one", worktree: root});
    const worker = await supervisor.startWorker(state.runId, registration.workerId, registration.generation, "Goal");
    assert.equal(activated, 0);
    assert.ok((await repository.read(state.runId))!.workers[0]!.processIdentity);
    await bridge.activateRegistered(state.runId, worker, "Goal"); assert.equal(activated, 1);
    await assert.rejects(bridge.start({runId: state.runId, workerId: worker.workerId, taskId: worker.taskId,
      ownerSessionId: worker.ownerSessionId, generation: worker.generation + 1, worktree: root,
      contractHash: state.currentContractHash, goal: "Goal"}), /resume observed/u);
    await repository.mutate(state.runId, current => ({...current, status: "stopping", disableRestart: true}));
    await assert.rejects(bridge.activateRegistered(state.runId, worker, "Goal"), {code: "RUN_WORKER_STALE"});
    assert.equal(activated, 1);
    await assert.rejects(repository.mutate(state.runId, current => ({...current, goal: "Other", goalHash: "b".repeat(64)})));
  } finally {child.kill("SIGKILL"); await rm(root, {recursive: true, force: true});}
});
