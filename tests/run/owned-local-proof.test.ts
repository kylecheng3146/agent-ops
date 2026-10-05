import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {mkdtemp, realpath, rm, writeFile, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import test from "node:test";
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

test("native-issued local verify is registered before execution and Stop cancels every descendant", {skip: process.platform !== "darwin"}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ops-local-proof-")));
  const commonDir = join(root, ".git");
  const home = process.env.AGENT_OPS_HOME;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    process.env.AGENT_OPS_HOME = root;
    const git = (args: string[]) => execFileSync("git", args, {cwd: root, stdio: ["ignore", "pipe", "pipe"]}).toString().trim();
    git(["init", "-q", "-b", "main"]); git(["config", "user.name", "Proof fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(root, ".gitignore"), ".agent-ops/\n");
    await writeFile(join(root, "product.txt"), "Fixture\n"); git(["add", "."]); git(["commit", "-qm", "Fixture"]);
    const waitScript = "const fs=require('node:fs'),cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('.agent-ops/tasks/local-proof-started.json',JSON.stringify({pid:process.pid,descendant:child.pid}));setInterval(()=>{},1000);";
    const config: AgentOpsConfig = {schemaVersion: 3, profiles: ["core"], features: {completionGate: {enabled: false}, stopVerification: {enabled: false}},
      verification: {commands: [{id: "wait", command: process.execPath, args: ["-e", waitScript], cwd: ".", required: true, evidence: {kind: "exit-code"}}]},
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
    child = spawn(process.execPath, [join(process.cwd(), ".tmp/test-dist/packages/cli/src/bin.js"), "verify", "--task", task.task.id, "--json"],
      {cwd: root, env: {...process.env, AGENT_OPS_HOME: root, AGENT_OPS_RUN_ID: state.runId, AGENT_OPS_WORKER_ID: state.coordinatorId,
        AGENT_OPS_WORKER_GENERATION: "1", AGENT_OPS_SESSION_ID: "owner"}, stdio: ["ignore", "pipe", "pipe"]});
    let diagnostics = "";
    child.stdout!.on("data", chunk => {diagnostics += chunk.toString();});
    child.stderr!.on("data", chunk => {diagnostics += chunk.toString();});
    const closed = new Promise(resolve => child!.once("close", resolve));
    let marker: {pid: number; descendant: number} | null = null;
    for (let i = 0; i < 100; i++) {try {marker = JSON.parse(await readFile(join(root, ".agent-ops/tasks/local-proof-started.json"), "utf8")); break;} catch {await delay(50);}}
    assert.ok(marker, "fixed verifier must execute after registration: " + diagnostics);
    const proof = (await repository.read(state.runId))!.workers[0]!.proofProcess;
    assert.ok(proof); assert.notEqual(proof.processId, marker.pid);
    const transport = new NativeRunTransport(new CodexGoalHost(), repository);
    await new RunSupervisor({repository, host: transport}).stopWorker(state.runId, state.coordinatorId, 1, "stop");
    await closed;
    assert.equal(await nativeProcessIdentity(marker.pid), null); assert.equal(await nativeProcessIdentity(marker.descendant), null);
    assert.equal((await repository.read(state.runId))!.workers[0]!.proofProcess, null);
    assert.equal((await taskService.status({taskId: task.task.id})).status, "active", "cancellation cannot become completion evidence");
  } finally {
    child?.kill("SIGKILL");
    if (home === undefined) delete process.env.AGENT_OPS_HOME; else process.env.AGENT_OPS_HOME = home;
    await rm(root, {recursive: true, force: true});
  }
});
