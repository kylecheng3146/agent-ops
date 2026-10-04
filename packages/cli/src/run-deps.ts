import {randomUUID} from "node:crypto";
import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {AgentOpsError} from "../../../runtime/src/fs/paths.js";
import {sha256} from "../../../runtime/src/fs/hash.js";
import {resolveCheckouts, ensureSessionWorktree, writeWorktreeRecord, sessionWorktreeName} from "../../../runtime/src/parallel/service.js";
import {createLaunchdDescriptor, LaunchdController, readBootIdentity, readGuiLoginIdentity} from "../../../runtime/src/run/macOS.js";
import {FileRunRepository, RunService, type RunState} from "../../../runtime/src/run/service.js";
import {readPrivateFile, writePrivateFile} from "../../../runtime/src/security/permissions.js";
import {collectChangeSurface} from "../../../runtime/src/verify/change-surface.js";
import {worktreeDependencies, gitRunner} from "./parallel-deps.js";
import type {RunCommandService} from "./commands/run.js";
import {NativeRunTransport} from "../../../runtime/src/run/transport.js";
import {ClaudeGoalHost} from "../../../runtime/src/run/hosts/claude.js";
import {CodexGoalHost} from "../../../runtime/src/run/hosts/codex.js";
import {RunSupervisor} from "../../../runtime/src/run/supervisor.js";
import {activeWallTimeMs} from "../../../runtime/src/run/scheduler.js";

export const runEntry = fileURLToPath(new URL("./run-entry.js", import.meta.url));
export function runDescriptor(state: RunState) {
  return createLaunchdDescriptor({runId: state.runId, workerId: "supervisor", privateDirectory: join(state.commonDir, "agent-ops", "runs", state.runId),
    command: process.execPath, args: [runEntry, state.root, state.runId], cwd: state.root, pathEnvironment: process.env.PATH});
}
export async function productionRunContext(cwd: string) {
  const deps = worktreeDependencies();
  const checkouts = await resolveCheckouts(deps, cwd);
  const target = await deps.git(checkouts.mainRoot, ["symbolic-ref", "--short", "HEAD"]);
  if (target.exitCode !== 0) throw new AgentOpsError("RUN_TARGET_REQUIRED", "Run requires a checked-out target branch.");
  const directory = join(checkouts.commonDir, "agent-ops", "runs");
  const repository = new FileRunRepository(directory, checkouts.commonDir);
  const service = new RunService(repository);
  const launchd = new LaunchdController();
  const start: RunCommandService["start"] = async input => {
    if (!launchd.supported) throw new AgentOpsError("RUN_BACKGROUND_UNSUPPORTED", "Background native runs currently require macOS.");
    if (checkouts.currentRoot !== checkouts.mainRoot) throw new AgentOpsError("WORKTREE_NESTED", "Start a run from the main checkout.");
    if ((await collectChangeSurface(gitRunner(checkouts.mainRoot))).paths.length > 0)
      throw new AgentOpsError("RUN_TARGET_DIRTY", "Commit or preserve the target's current edits before starting an isolated run.");
    const config = await deps.loadConfig(checkouts.mainRoot);
    if (await deps.trust.status(checkouts.mainRoot, config) !== "TRUSTED")
      throw new AgentOpsError("RUN_REPO_UNTRUSTED", "The run requires current repository verifier trust.");
    const ownerSessionId = randomUUID();
    const result = await service.start({...input, root: checkouts.mainRoot, commonDir: checkouts.commonDir,
      targetBranch: target.stdout.trim(), ownerSessionId, bootIdentity: await readBootIdentity(), loginDomain: await readGuiLoginIdentity()});
    try {
      const record = await ensureSessionWorktree(deps, {cwd: checkouts.mainRoot, sessionId: ownerSessionId});
      const workerId = `coordinator-${result.state.runId}`;
      await writeWorktreeRecord({...record, runId: result.state.runId, coordinatorId: result.state.coordinatorId, workerId, ownerSessionId, workerGeneration: 1});
      const now = new Date().toISOString();
      const state = await repository.mutate(result.state.runId, current => ({...current,
        currentContractHash: current.goalHash,
        tasks: [{taskId: "planning-" + current.runId, dependencies: [], status: "ready", workerId,
          deliveryDigest: null, sourceCommit: null, blockedReason: null}],
        workers: [{workerId, taskId: "planning-" + current.runId, host: current.host, ownerSessionId,
          nativeSessionId: null, nativeJobId: null, worktree: record.path, processId: null, processIdentity: null,
          generation: 1, status: "assigned", leaseExpiresAt: null, heartbeatAt: null, stopIntent: null,
          nativeGoalState: "inactive", lastFailure: null}],
        budget: {...current.budget, activeIntervals: [{startMs: Date.parse(current.createdAt), endMs: null}], lastObservedAt: now}}));
      await mkdir(runDescriptor(state).privateDirectory, {recursive: true});
      await writePrivateFile(join(record.path, ".agent-ops", "tasks", "run-goal.json"), JSON.stringify({runId: state.runId,
        goal: state.goal, goalHash: state.goalHash, host: state.host, jobs: state.jobs, ownerSessionId}), record.path);
      await launchd.writeDescriptor(runDescriptor(state));
      await launchd.bootstrap(runDescriptor(state));
      return {state, message: `Run ${state.runId} started in ${record.path}.`};
    } catch (cause) {
      await repository.mutate(result.state.runId, current => ({...current, status: "failed", disableRestart: true}));
      throw cause;
    }
  };
  const resume: RunCommandService["resume"] = async runId => {
    const result = await service.resume(runId);
    const login = await readGuiLoginIdentity();
    const state = await repository.mutate(runId, current => ({...current,
      bootIdentity: awaitBoot, loginDomain: login}));
    await launchd.enableRestart(runDescriptor(state));
    try {await launchd.wake(runDescriptor(state));} catch (cause) {
      await repository.mutate(runId, current => ({...current, status: "paused", awaitingResume: true}));
      throw new AgentOpsError("RUN_SUPERVISOR_RESUME_FAILED", "Supervisor could not be resumed; inspect run status and launchd diagnostics.", {cause});
    }
    return {...result, state};
  };
  const awaitBoot = await readBootIdentity();
  const stop: RunCommandService["stop"] = async (runId, reason) => {
    const result = await service.stop(runId, reason);
    // Disable native/background continuation before asking the active supervisor to stop writers.
    await launchd.disableRestart(runDescriptor(result.state), reason ?? "user requested stop");
    // The control command also reconciles saved process identities: a crashed
    // supervisor must not leave an owned native group alive after user Stop.
    const transport = new NativeRunTransport(result.state.host === "codex" ? new CodexGoalHost() : new ClaudeGoalHost(), repository);
    const supervisor = new RunSupervisor({repository, host: transport});
    for (const worker of result.state.workers.filter(worker => worker.nativeSessionId !== null)) {
      try {await supervisor.stopWorker(runId, worker.workerId, worker.generation, "stop");}
      catch (cause) {
        const current = (await repository.read(runId))!;
        const saved = current.workers.find(w => w.workerId === worker.workerId);
        if (saved?.generation !== worker.generation || saved.stopIntent?.confirmedDeadAt == null) throw cause;
      }
    }
    const proof = (await repository.read(runId))!.proofProcess;
    if (proof != null) {
      await transport.stop({nativeSessionId: "run-proof", nativeJobId: null, ...proof,
        instance: result.state.nativeInstance, generation: 1, reason: "user requested stop"});
      await repository.mutate(runId, current => ({...current,
        ...(current.proofProcess?.processId === proof.processId ? {proofProcess: null} : {})}));
    }
    await launchd.bootout(runDescriptor(result.state));
    const state = await repository.mutate(runId, current => ({...current, status: "paused", budget: {...current.budget,
      accumulatedMs: activeWallTimeMs(current.budget.activeIntervals, Date.now()), lastObservedAt: new Date().toISOString(),
      activeIntervals: current.budget.activeIntervals.map(interval => ({...interval, endMs: interval.endMs ?? Date.now()}))}}));
    return {state, message: `Run ${runId} stopped; registered native process death was confirmed.`};
  };
  const respond: RunCommandService["respond"] = async (runId, questionId, answer) => {
    const state = await service.status(runId);
    if (!state.questions.some(q => q.questionId === questionId && q.answeredAt === null))
      throw new AgentOpsError("RUN_QUESTION_NOT_FOUND", "An unanswered question is required.");
    await writePrivateFile(join(state.commonDir, "agent-ops", "runs", state.runId, "answers", sha256(questionId) + ".json"),
      JSON.stringify({questionId, answer: answer.trim()}), state.commonDir);
    const result = await service.respond(runId, questionId, answer);
    await launchd.wake(runDescriptor(result.state));
    return result;
  };
  return {...checkouts, targetBranch: target.stdout.trim(), ownerSessionId: randomUUID(), repository,
    service: {start, resume, stop, respond, status: service.status.bind(service), logs: service.logs.bind(service)},
    waitForCompletion: async (runId: string): Promise<RunState> => {
      for (;;) {
        const state = await service.status(runId);
        if (!["active", "stopping"].includes(state.status)) return state;
        await delay(1000);
      }
    }};
}
