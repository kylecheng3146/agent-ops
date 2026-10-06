import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {mkdtemp, realpath, rm, writeFile, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import test, {type TestContext} from "node:test";
import {calculateConfigHash} from "../../runtime/src/config/hash.js";
import type {AgentOpsConfig} from "../../runtime/src/contracts.js";
import {createRunState, FileRunRepository} from "../../runtime/src/run/service.js";
import {bindRunPolicy, runRuntimeHash} from "../../runtime/src/run/policy.js";
import {TaskService} from "../../runtime/src/task/service.js";
import {FileTaskStore} from "../../runtime/src/task/store.js";
import {writeWorktreeRecord} from "../../runtime/src/parallel/service.js";
import {FileTrustStore} from "../../runtime/src/security/trust.js";
import {localStatePaths} from "../../runtime/src/security/permissions.js";
import {NativeRunTransport, nativeProcessIdentity} from "../../runtime/src/run/transport.js";
import {CodexGoalHost} from "../../runtime/src/run/hosts/codex.js";
import {RunSupervisor} from "../../runtime/src/run/supervisor.js";
import {runWorktreeDependencies} from "../../packages/cli/src/run-deps.js";
import {worktreeDependencies} from "../../packages/cli/src/parallel-deps.js";
import {runOwnedLocalProof} from "../../packages/cli/src/owned-run-step.js";

async function exerciseLocalProof(t: TestContext, mode: "delayed" | "failure" | "stop-race") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ops-local-proof-")));
  const commonDir = join(root, ".git");
  const home = process.env.AGENT_OPS_HOME;
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<unknown> | undefined;
  let cleanup: (() => Promise<unknown>) | undefined;
  let marker: {pid: number; descendant: number} | null = null;
  const cwd = process.cwd();
  const ownedEnvironment = ["AGENT_OPS_RUN_ID", "AGENT_OPS_WORKER_ID", "AGENT_OPS_WORKER_GENERATION"].map(key => [key, process.env[key]] as const);
  try {
    process.env.AGENT_OPS_HOME = root;
    const git = (args: string[]) => execFileSync("git", args, {cwd: root, stdio: ["ignore", "pipe", "pipe"]}).toString().trim();
    git(["init", "-q", "-b", "main"]); git(["config", "user.name", "Proof fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(root, ".gitignore"), ".agent-ops/\n");
    await writeFile(join(root, "product.txt"), "Fixture\n"); git(["add", "."]); git(["commit", "-qm", "Fixture"]);
    const waitScript = mode === "stop-race" ? "require('node:fs').writeFileSync('.agent-ops/tasks/local-proof-started.json','activated');" :
      `setTimeout(()=>{const fs=require('node:fs'),cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('.agent-ops/tasks/local-proof-started.json',JSON.stringify({pid:process.pid,descendant:child.pid}));setInterval(()=>{},1000);},${mode === "delayed" ? 6000 : 0});`;
    const config: AgentOpsConfig = {schemaVersion: 3, profiles: ["core"], features: {completionGate: {enabled: false}, stopVerification: {enabled: false}},
      verification: {commands: [{id: "wait", command: process.execPath, args: ["-e", waitScript], cwd: ".", timeoutMs: 30000, required: true, evidence: {kind: "exit-code"}}]},
      pathMappings: [], securityExceptions: [], worktree: {mode: "auto", setup: [{command: process.execPath, args: ["-e", "console.log('setup complete')"]}]}};
    const taskService = new TaskService(new FileTaskStore(join(root, ".agent-ops/tasks/state.json"), root));
    const task = await taskService.create({title: "Owned proof", intent: "Check group cancellation", sessionId: "owner", policyConfigHash: calculateConfigHash(config),
      criteria: [{id: "one", description: "Proof is registered", verifierIds: ["wait"]}, {id: "two", description: "Cancellation stops descendants", verifierIds: ["wait"]}]});
    const repository = new FileRunRepository(join(commonDir, "agent-ops/runs"), commonDir);
    const state = createRunState({root, commonDir, goal: "Own all proof processes", targetBranch: "main", host: "codex", ownerSessionId: "owner"});
    await repository.create({...state, tasks: [{taskId: task.task.id, dependencies: [], status: "running", workerId: state.coordinatorId,
      deliveryDigest: null, sourceCommit: null, blockedReason: null}], workers: [{workerId: state.coordinatorId, taskId: task.task.id, host: "codex", ownerSessionId: "owner", nativeSessionId: "native-fixture", nativeJobId: "thread-fixture",
      worktree: root, processId: null, processIdentity: null, generation: 1, status: "stopped", leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: "active", lastFailure: null}],
      budget: {...state.budget, activeIntervals: [{startMs: Date.now(), endMs: null}]}});
    const binding = {canonicalPath: root, remoteIdentity: "local:fixture", configHash: calculateConfigHash(config), runtimeHash: "a".repeat(64)};
    await bindRunPolicy(repository, state.runId, {config, baseTrustBinding: binding, runtimeHash: await runRuntimeHash()});
    const local = localStatePaths(root); await new FileTrustStore(local.trustStore, local.anchorDirectory).grant(binding);
    await writeWorktreeRecord({schemaVersion: 1, name: "session-fixture", branch: "main", path: root, mainRoot: root, targetBranch: "main", base: git(["rev-parse", "HEAD"]),
      sessionId: "owner", createdAt: new Date().toISOString(), runId: state.runId, coordinatorId: state.coordinatorId, workerId: state.coordinatorId, ownerSessionId: "owner", workerGeneration: 1});
    // Exercise real registered setup too, before activating the writer.
    const scoped = await runWorktreeDependencies(worktreeDependencies(), (await repository.read(state.runId))!);
    const setup = await scoped.runSetup(root, {...config.worktree!.setup![0]!, timeoutMs: 600000});
    assert.equal(setup.exitCode, 0, setup.output); assert.ok(setup.output.includes("setup complete"));
    assert.equal((await repository.read(state.runId))!.proofProcess, null);
    assert.ok((await repository.read(state.runId))!.events.some(e => e.code === "RUN_SETUP_PASSED"));
    await writeFile(join(root, "product.txt"), "Changed fixture\n");
    await repository.mutate(state.runId, s => ({...s, workers: s.workers.map(w => ({...w, status: "running"}))}));
    const transport = new NativeRunTransport(new CodexGoalHost(), repository);
    const supervisor = new RunSupervisor({repository, host: transport});
    cleanup = async () => {
      const proof = (await repository.read(state.runId))!.workers[0]!.proofProcess;
      await supervisor.stopWorker(state.runId, state.coordinatorId, 1, "stop");
      if (proof != null) assert.equal(await nativeProcessIdentity(proof.processId), null);
      assert.equal((await repository.read(state.runId))!.workers[0]!.proofProcess ?? null, null);
    };
    if (mode === "stop-race") {
      process.chdir(root);
      process.env.AGENT_OPS_RUN_ID = state.runId;
      process.env.AGENT_OPS_WORKER_ID = state.coordinatorId;
      process.env.AGENT_OPS_WORKER_GENERATION = "1";
      const mutate = FileRunRepository.prototype.mutate;
      let fenced = false;
      t.mock.method(FileRunRepository.prototype, "mutate", async function (this: FileRunRepository, ...args: Parameters<FileRunRepository["mutate"]>) {
        if (!fenced && args[0] === state.runId) {fenced = true; await cleanup!();}
        return await mutate.apply(this, args);
      });
      const kill = process.kill;
      const killed: number[] = [];
      t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
        if (pid < 0 && signal === "SIGKILL") killed.push(-pid);
        return kill.call(process, pid, signal);
      });
      await assert.rejects(runOwnedLocalProof(["verify", "--task", task.task.id, "--json"]), {code: "RUN_WORKER_STALE"});
      assert.ok(fenced); assert.equal(killed.length, 1);
      assert.equal(await nativeProcessIdentity(killed[0]!), null);
      assert.equal((await repository.read(state.runId))!.workers[0]!.proofProcess ?? null, null);
      assert.deepEqual((await taskService.status({taskId: task.task.id})).evidence, {});
      await assert.rejects(readFile(join(root, ".agent-ops/tasks/local-proof-started.json")), {code: "ENOENT"});
      return;
    }
    child = spawn(process.execPath, [join(process.cwd(), ".tmp/test-dist/packages/cli/src/bin.js"), "verify", "--task", task.task.id, "--json"],
      {cwd: root, env: {...process.env, AGENT_OPS_HOME: root, AGENT_OPS_RUN_ID: state.runId, AGENT_OPS_WORKER_ID: state.coordinatorId,
        AGENT_OPS_WORKER_GENERATION: "1", AGENT_OPS_SESSION_ID: "owner"}, stdio: ["ignore", "pipe", "pipe"]});
    let diagnostics = "";
    child.stdout!.on("data", chunk => {diagnostics += chunk.toString();});
    child.stderr!.on("data", chunk => {diagnostics += chunk.toString();});
    let exited = false;
    child.on("error", cause => {diagnostics += String(cause); exited = true;});
    closed = new Promise(resolve => child!.once("close", (code, signal) => {diagnostics += `exit=${code}, signal=${signal}`; exited = true; resolve(code);}));
    const deadline = Date.now() + 30000;
    while (!exited && Date.now() < deadline) {
      try {marker = JSON.parse(await readFile(join(root, ".agent-ops/tasks/local-proof-started.json"), "utf8")); break;}
      catch (cause) {
        if (!(cause instanceof SyntaxError) && (cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        await delay(50);
      }
    }
    assert.ok(marker, "fixed verifier must execute after registration: " + diagnostics);
    const proof = (await repository.read(state.runId))!.workers[0]!.proofProcess;
    assert.ok(proof); assert.notEqual(proof.processId, marker.pid);
    if (mode === "failure") throw new Error("simulated fixture assertion failure");
    await cleanup();
    await closed;
    assert.equal(await nativeProcessIdentity(marker.pid), null); assert.equal(await nativeProcessIdentity(marker.descendant), null);
    assert.equal((await repository.read(state.runId))!.workers[0]!.proofProcess, null);
    assert.equal((await taskService.status({taskId: task.task.id})).status, "active", "cancellation cannot become completion evidence");
  } finally {
    try {await cleanup?.();}
    finally {
      child?.kill("SIGKILL");
      await closed;
      process.chdir(cwd);
      for (const [key, value] of ownedEnvironment) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}
      if (home === undefined) delete process.env.AGENT_OPS_HOME; else process.env.AGENT_OPS_HOME = home;
      if (marker !== null) {
        assert.equal(await nativeProcessIdentity(marker.pid), null);
        assert.equal(await nativeProcessIdentity(marker.descendant), null);
      }
      await rm(root, {recursive: true, force: true});
    }
  }
}

test("native-issued local verify is registered before execution and Stop cancels every descendant", {skip: process.platform !== "darwin"}, t => exerciseLocalProof(t, "delayed"));
test("a fixture assertion failure still cancels its registered proof and descendants", {skip: process.platform !== "darwin"}, async t => {
  await assert.rejects(exerciseLocalProof(t, "failure"), /simulated fixture assertion failure/u);
});
test("Stop between context lookup and local proof registration prevents activation", {skip: process.platform !== "darwin"}, t => exerciseLocalProof(t, "stop-race"));
