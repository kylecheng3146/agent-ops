import {stat} from "node:fs/promises";
import {recoverRunIntegrationAfterCleanup, validateRunIntegrationReceipt} from "../../../runtime/src/run/integration.js";
import {pendingFindingPins} from "../../../runtime/src/run/ratchet.js";
import {resolveReviewScope} from "../../../runtime/src/review/scope.js";
import {writeNoChangeDelivery, integrateSessionChildren} from "../../../runtime/src/parallel/integrate.js";
import {recordNativeRunUsage, recordReviewRunUsage, recordSavedReviewRunUsage} from "../../../runtime/src/run/usage.js";
import {recordNativeRunAuthorization} from "../../../runtime/src/run/authorization.js";
import {observeRunFailure} from "../../../runtime/src/run/verification.js";
import {compareFailureObservations, type FailureObservation} from "../../../runtime/src/run/convergence.js";
import {RunControlService} from "../../../runtime/src/run/controls.js";
import {beginPolicyTransition, markPolicyTransitionStage, completePolicyTransition, discoverPendingPolicyTransition,
  type PolicyTransitionJournal} from "../../../runtime/src/run/policy-transition.js";
import {readReviewReportArtifact, type ReviewReportArtifact} from "../../../runtime/src/review/attestation.js";
import {execFile, spawn} from "node:child_process";
import {promisify} from "node:util";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import {AgentOpsError, resolveContainedPath} from "../../../runtime/src/fs/paths.js";
import {bindRunPolicy, readRunPolicy, runRuntimeHash, validateRunPolicyChange, type RunPolicyApproval} from "../../../runtime/src/run/policy.js";
import {sha256} from "../../../runtime/src/fs/hash.js";
import {calculateConfigHash, canonicalJson} from "../../../runtime/src/config/hash.js";
import {ClaudeGoalHost} from "../../../runtime/src/run/hosts/claude.js";
import {CodexGoalHost} from "../../../runtime/src/run/hosts/codex.js";
import {FileRunRepository, type RunState, type RunWorkerRecord} from "../../../runtime/src/run/service.js";
import {RunSupervisor} from "../../../runtime/src/run/supervisor.js";
import {NativeRunTransport, nativeProcessIdentity} from "../../../runtime/src/run/transport.js";
import {workerPlan, type RunWorkerPlan} from "../../../runtime/src/run/planning.js";
import {RunScheduler} from "../../../runtime/src/run/scheduler.js";
import {activeWallTimeMs} from "../../../runtime/src/run/scheduler.js";
import {readBootIdentity, readGuiLoginIdentity, LaunchdController} from "../../../runtime/src/run/macOS.js";
import {readPrivateFile, writePrivateFile, withPrivateFileLock} from "../../../runtime/src/security/permissions.js";
import {TaskService} from "../../../runtime/src/task/service.js";
import {FileTaskStore} from "../../../runtime/src/task/store.js";
import {taskContractHash, treeContractHash} from "../../../runtime/src/task/contract.js";
import {readWorktreeRecord, writeWorktreeRecord, addWorktree, ensureSessionWorktree} from "../../../runtime/src/parallel/service.js";
import {collectChangeSurface} from "../../../runtime/src/verify/change-surface.js";
import {runDescriptor, runWorktreeDependencies, renewPendingRunPolicy} from "./run-deps.js";
import {worktreeDependencies, gitRunner} from "./parallel-deps.js";
import {readFinishedReview} from "./commands/review-show.js";
import type {FinishReceipt} from "../../../runtime/src/parallel/receipt.js";
import type {AcceptanceCriterion} from "../../../runtime/src/contracts.js";

const exec = promisify(execFile);
const plain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const active = (worker: RunWorkerRecord) => ["assigned", "starting", "running", "idle", "handing-off"].includes(worker.status);
const cli = fileURLToPath(new URL("./bin.js", import.meta.url));

/** Recheck after confirmed death and after verification, before publishing the frozen SHA. */
export async function assertRunDeliverySnapshot(root: string, taskId: string, head: string, contract: string, tasks: TaskService): Promise<void> {
  const runner = gitRunner(root);
  const actual = await runner.run(["rev-parse", "HEAD"]);
  if (actual.exitCode !== 0 || actual.stdout.toString().trim() !== head ||
    (await collectChangeSurface(runner)).paths.length > 0 || await tasks.treeContract(taskId) !== contract)
    throw new AgentOpsError("RUN_DELIVERY_CHANGED", "Worker source or contract changed while stopping or verifying; take a new handoff snapshot.");
}

/** The launchd process owns leases. Native turn completion never completes a run. */
export async function superviseNativeRun(root: string, runId: string): Promise<void> {
  const deps = worktreeDependencies();
  const common = await deps.git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.exitCode !== 0) throw new AgentOpsError("RUN_REPOSITORY_INVALID", "Cannot locate the run's Git common directory.");
  const commonDir = common.stdout.trim();
  const directory = join(commonDir, "agent-ops", "runs");
  const repository = new FileRunRepository(directory, commonDir);
  const initial = await repository.read(runId);
  if (initial === null || initial.root !== root || initial.commonDir !== commonDir)
    throw new AgentOpsError("RUN_REPOSITORY_INVALID", "Supervisor root must match the saved canonical run identity.");
  await withPrivateFileLock(join(directory, runId, "supervisor.lock"), commonDir, async () => {
    let state = (await repository.read(runId))!;
    const launchd = new LaunchdController();
    async function blockStartup(code: string, paused = false, closedAt = Date.now(), preserveStatus = false): Promise<void> {
      await repository.mutate(runId, current => ({...current, ...(preserveStatus ? {} : {status: paused ? "paused" as const : "blocked" as const, awaitingResume: paused}), disableRestart: true}));
      await repository.appendEvent(runId, {type: "diagnostic", code, workerId: null, taskId: null,
        detail: "Startup refused; current native ownership and worktrees are preserved for reconciliation."});
      try {await launchd.disableRestart(runDescriptor(state), code);}
      catch {await repository.appendEvent(runId, {type: "diagnostic", code: "RUN_SUPERVISOR_DISABLE_FAILED",
        workerId: null, taskId: null, detail: "Launchd disable failed; stopping registered executors under the persisted disabled intent."});}
      const savedTransport = new NativeRunTransport(state.host === "codex"
        ? new CodexGoalHost({nativeVersion: state.nativeInstance}) : new ClaudeGoalHost({nativeVersion: state.nativeInstance}), repository);
      const savedSupervisor = new RunSupervisor({repository, host: savedTransport});
      for (const worker of state.workers)
        await savedSupervisor.stopWorker(runId, worker.workerId, worker.generation, "crash");
      if (state.proofProcess != null) await savedTransport.stop({nativeSessionId: "run-proof", nativeJobId: null,
        ...state.proofProcess, instance: state.nativeInstance, generation: 1, reason: code});
      await repository.mutate(runId, current => ({...current, proofProcess: null, budget: {...current.budget,
        accumulatedMs: activeWallTimeMs(current.budget.activeIntervals, closedAt), lastObservedAt: new Date().toISOString(),
        activeIntervals: current.budget.activeIntervals.map(interval => ({...interval, endMs: interval.endMs ?? Math.max(interval.startMs, closedAt)}))}}));
    }
    if (state.disableRestart || state.status === "complete") {
      await blockStartup("RUN_DISABLED_RECONCILED", false, Date.now(), true);
      return;
    }
    const boot = await readBootIdentity();
    const login = await readGuiLoginIdentity();
    if (state.bootIdentity !== boot || state.loginDomain !== login) {
      await blockStartup("RUN_BOOT_OR_LOGIN_CHANGED", true,
        state.bootIdentity !== boot ? Date.parse(state.budget.lastObservedAt) : Date.now());
      return;
    }
    const lastResume = Math.max(0, ...state.controls.filter(c => c.action === "resume" && c.actor === "user").map(c => Date.parse(c.requestedAt)));
    const restarts = state.events.filter(e => e.code === "RUN_SUPERVISOR_START" && Date.parse(e.at) >= lastResume && Date.now() - Date.parse(e.at) < 300000).length;
    if (restarts >= 3) {
      await blockStartup("RUN_RESTART_STORM");
      return;
    }
    await repository.appendEvent(runId, {type: "status", code: "RUN_SUPERVISOR_START", workerId: null, taskId: null, detail: null});
    let version: string;
    try {
      version = state.integration !== null ? state.nativeInstance ?? "recovery"
        : (await exec(state.host, ["--version"], {timeout: 5000, maxBuffer: 8192})).stdout.trim();
      if (version.length === 0 || (state.nativeInstance !== null && state.nativeInstance !== version))
        throw new AgentOpsError("RUN_NATIVE_VERSION_CHANGED", "Native version drift prevents automatic writer restart.");
    } catch (cause) {
      await blockStartup(cause instanceof AgentOpsError ? cause.code : "RUN_NATIVE_UNAVAILABLE"); return;
    }
    state = await repository.mutate(runId, current => ({...current, nativeInstance: version}));
    const transport = new NativeRunTransport(state.host === "codex" ? new CodexGoalHost({nativeVersion: version}) : new ClaudeGoalHost({nativeVersion: version}), repository,
      async event => {
        await recordNativeRunUsage(repository, event);
        try {await recordNativeRunAuthorization(repository, event);}
        catch (cause) {
          await repository.appendEvent(runId, {type: "diagnostic", code: cause instanceof AgentOpsError ? cause.code : "RUN_AUTHORIZATION_FAILED",
            workerId: event.workerId, taskId: null, detail: "Native authorization could not be accepted; no alternate permission path is allowed."});
          await repository.mutate(runId, current => ({...current, status: "blocked", disableRestart: true}));
        }
        if (event.nativeStatus === "usageLimited" || event.nativeStatus === "budgetLimited") {
          await repository.mutate(runId, current => ({...current,
            status: event.nativeStatus === "usageLimited" || event.nativeStatus === "budgetLimited" ? "budget-limited" : "blocked",
            disableRestart: true}));
        }
        if (["completed", "error", "closed"].includes(event.type)) await repository.appendEvent(runId, {type: "diagnostic",
          code: event.type === "completed" ? "RUN_NATIVE_COMPLETION_UNPROVEN" : "RUN_NATIVE_" + event.type.toUpperCase(),
          workerId: event.workerId, taskId: null, detail: "Native lifecycle observation; current agent-ops proof is still required."});
      });
    const supervisor = new RunSupervisor({repository, host: transport});
    const scheduler = new RunScheduler({repository});
    async function instructions(worker: RunWorkerRecord, diagnostic?: string): Promise<string> {
      const current = (await repository.read(runId))!;
      const answers = [];
      for (const question of current.questions.filter(q => q.answeredAt !== null)) {
        const source = await readPrivateFile(join(directory, runId, "answers", sha256(question.questionId) + ".json"), commonDir);
        if (source === null) throw new AgentOpsError("RUN_ANSWER_MISSING", "A recorded answer artifact is missing.");
        const answer: unknown = JSON.parse(source);
        if (!plain(answer) || answer.questionId !== question.questionId || typeof answer.answer !== "string" ||
          sha256(answer.answer) !== question.answerDigest) throw new AgentOpsError("RUN_ANSWER_CHANGED", "The saved answer no longer matches its recorded digest.");
        answers.push({questionId: question.questionId, prompt: question.prompt, answer: answer.answer});
      }
      const content = {runId, workerId: worker.workerId, generation: worker.generation, contractHash: current.currentContractHash,
        originalGoal: current.goal, answers, rootTaskId: current.rootTaskId, taskId: worker.taskId, cli, ownerSessionId: worker.ownerSessionId,
        policyConfigHash: current.policyBinding?.configHash,
        instructions: ["Keep the original goal fixed. Read this repository's AGENTS.md and use its existing verifier authority.",
          "Plan 2–5 substantive acceptance criteria. Submit a plan request before changing product files; the supervisor creates the task with the fixed goal.",
          "For every mechanically testable requirement use a configured acceptance runner; explicit review-only fallback requires a recorded reason and fresh goal review.",
          "Implement, commit and verify. Repair failed checks and pin mechanically testable review findings into regression criteria. Never disable a mandatory policy verifier.",
          "Only registered run workers may write. Use isolated worktrees and supervisor-issued leases; do not launch an unregistered writing subagent.",
          "Commit product changes before revising the contract. A contract revision stops existing generations; dirty recovery preserves the checkout and blocks takeover.",
          "Write one request atomically to .agent-ops/tasks/run-request.json; wait for matching run-response.json before another request.",
          "Requests require requestId (unique alphanumeric or hyphen, max 64), workerId, generation and current contractHash.",
          "Plan fields: action=plan,title,intent,criteria. Worker fields: action=worker,title,intent,criteria,dependencies (known worker task IDs; omit all acceptance baselines until dependencies are delivered).",
          "Only the coordinator may change execution policy: submit action=policy, configFile (relative proposed JSON), expectedPolicyHash, approvals (each changed capabilityId command:<id>/runner:<id>/setup:<index>, classification=non-dangerous, reason assessing the entire fixed definition including setup/build). Commit source changes and wait until every writer is clean before requesting policy synchronization. Never use init/update/trust grant to create permanent execution authorization. Explicit native or organization denial must not be bypassed.",
          "Worker task baselines are frozen after dependency commits enter its checkout. Handoff fields: action=handoff,sourceFiles (explicit existing source paths when unchanged). Question fields: action=question,prompt. Coordinator finalize fields: action=finalize.",
          "The supervisor, after stopping writers, runs final verification, two fresh reviews and finish. A native completed goal is never final proof."], diagnostic};
      const path = join(worker.worktree!, ".agent-ops", "tasks", "run-instructions.json");
      await writePrivateFile(path, JSON.stringify(content, null, 2), worker.worktree!);
      return "Read .agent-ops/tasks/run-instructions.json and carry its immutable original goal through the evidence loop. Submit a plan if rootTaskId is null; otherwise implement and repair the assigned task. A child requests handoff after local green; the coordinator waits for all child deliveries, then requests finalization. Never substitute native goal completion for agent-ops evidence.";
    }
    async function start(worker: RunWorkerRecord, diagnostic?: string): Promise<void> {
      if (await discoverPendingPolicyTransition(repository, runId) !== null)
        throw new AgentOpsError("RUN_POLICY_TRANSITION_PENDING", "Finish policy synchronization before acquiring a new writer generation.");
      if (worker.worktree === null) throw new AgentOpsError("RUN_WORKTREE_MISSING", "Worker has no isolated checkout.");
      const config = await deps.loadConfig(worker.worktree);
      if (await deps.trust.status(worker.worktree, config) !== "TRUSTED")
        throw new AgentOpsError("RUN_REPO_UNTRUSTED", "Native activation requires current run policy, runtime and repository trust.");
      if (worker.status !== "assigned") {
        if ((await collectChangeSurface(gitRunner(worker.worktree))).paths.length > 0)
          throw new AgentOpsError("RUN_RECOVERY_DIRTY", "A crashed writer left an uncommitted checkout; preserve it for explicit recovery.");
        if (worker.nativeSessionId !== null) {
          const observation = await transport.inspect({nativeSessionId: worker.nativeSessionId, nativeJobId: worker.nativeJobId,
            processId: worker.processId, processIdentity: worker.processIdentity, instance: state.nativeInstance});
          if (observation.processAlive) await supervisor.stopWorker(runId, worker.workerId, worker.generation, "crash");
        }
        worker = await supervisor.reassignWorker(runId, worker.workerId, worker.generation);
      }
      const record = await readWorktreeRecord(worker.worktree!);
      if (record === null || record.runId !== runId || record.workerId !== worker.workerId)
        throw new AgentOpsError("RUN_WORKTREE_OWNERSHIP", "The worker checkout is not registered to this run.");
      await writeWorktreeRecord({...record, workerGeneration: worker.generation});
      const goal = await instructions(worker, diagnostic);
      const running = await supervisor.startWorker(runId, worker.workerId, worker.generation, goal);
      try {await transport.activateRegistered(runId, running, goal);}
      catch (cause) {
        await supervisor.stopWorker(runId, running.workerId, running.generation, "crash");
        throw cause;
      }
    }
    async function schedule(): Promise<void> {
      const current = (await repository.read(runId))!;
      for (const node of await scheduler.next(runId)) {
        if (node.planDigest === undefined || node.taskId === current.rootTaskId) continue;
        const existing = current.workers.find(worker => worker.taskId === node.taskId);
        if (existing !== undefined && existing.worktree !== null &&
            (await deps.tasks(existing.worktree).list()).some(r => r.task.id === node.taskId)) continue;
        const planPath = join(directory, runId, "plans", node.taskId + ".json");
        const source = await readPrivateFile(planPath, commonDir);
        if (source === null || sha256(source) !== node.planDigest) throw new AgentOpsError("RUN_PLAN_CHANGED", "Deferred worker plan is missing or changed.");
        const plan = workerPlan(JSON.parse(source), node.taskId, current);
        const ownerSessionId = existing?.ownerSessionId ?? (await import("node:crypto")).randomUUID();
        const registration = existing ?? await supervisor.registerWorker(runId, {taskId: node.taskId, ownerSessionId});
        try {
          const coordinator = current.workers[0]!;
          const from = (await deps.git(coordinator.worktree!, ["rev-parse", "HEAD"])).stdout.trim();
          const name = runId + "-" + sha256(node.taskId).slice(0, 8);
          const plannedRoot = join(root, ".worktrees", name);
          await repository.mutate(runId, saved => {
            if (saved.status !== "active" || saved.disableRestart)
              throw new AgentOpsError("RUN_START_DISABLED", "Stop fenced child provisioning before checkout creation.");
            return {...saved, workers: saved.workers.map(w => w.workerId === registration.workerId ? {...w, worktree: plannedRoot} : w)};
          });
          const preserved = await readWorktreeRecord(plannedRoot);
          if (preserved !== null && (preserved.runId !== runId || preserved.workerId !== registration.workerId))
            throw new AgentOpsError("RUN_WORKTREE_OWNERSHIP", "Preserved child checkout belongs to another worker.");
          const workerRoot = preserved?.path ?? (await addWorktree(await runWorktreeDependencies(deps, (await repository.read(runId))!), {cwd: root, name,
            sessionId: current.ownerSessionId, agentId: registration.workerId, from, targetBranch: current.targetBranch,
            runOwnership: {runId, coordinatorId: current.coordinatorId, workerId: registration.workerId, ownerSessionId, generation: registration.generation}})).record.path;
          await ensureSetup(workerRoot);
          for (const dependency of node.dependencies) {
            const delivered = current.tasks.find(task => task.taskId === dependency);
            if (delivered?.sourceCommit == null || delivered.status !== "delivered") throw new AgentOpsError("RUN_DEPENDENCY_UNDELIVERED", "Dependency version is not a frozen delivery.");
            const merge = await deps.git(workerRoot, ["merge", "--no-edit", delivered.sourceCommit]);
            if (merge.exitCode !== 0) {await deps.git(workerRoot, ["merge", "--abort"]); throw new AgentOpsError("RUN_DEPENDENCY_CONFLICT", "Dependency commits conflict; preserve the child checkout.");}
          }
          const config = await deps.loadConfig(workerRoot);
          const service = new TaskService(new FileTaskStore(join(workerRoot, ".agent-ops", "tasks", "state.json"), workerRoot), {
            generateId: () => node.taskId, completion: {root: workerRoot, gitRunner: gitRunner(workerRoot), loadConfig: async () => config}});
          await service.create({title: plan.title, intent: plan.intent, criteria: plan.criteria, goal: current.goal,
            sessionId: ownerSessionId, policyConfigHash: calculateConfigHash(config)});
          await start((await repository.read(runId))!.workers.find(w => w.workerId === registration.workerId)!);
        } catch (cause) {
          const latest = (await repository.read(runId))!;
          if (latest.status !== "active" || latest.disableRestart) {
            const saved = latest.workers.find(w => w.workerId === registration.workerId)!;
            await supervisor.stopWorker(runId, saved.workerId, saved.generation, "stop");
            return;
          }
          await repository.appendEvent(runId, {type: "diagnostic", code: cause instanceof AgentOpsError ? cause.code : "RUN_WORKER_START_FAILED",
            workerId: registration.workerId, taskId: node.taskId, detail: "Child provisioning failed; the registered checkout and setup artifacts are preserved."});
          await scheduler.blockTaskAndDependents(runId, node.taskId, cause instanceof AgentOpsError ? cause.code : "RUN_WORKER_START_FAILED", true);
          await repository.mutate(runId, saved => saved.status !== "active" || saved.disableRestart ? saved :
            {...saved, workers: saved.workers.map(w => w.workerId === registration.workerId ? {...w, status: "blocked"} : w)});
        }
      }
    }
    async function advance(saved: RunState): Promise<{status: string; code: string; data?: unknown}> {
      return await step(root, ["task", "advance", "--task", saved.rootTaskId!, "--session", saved.ownerSessionId, "--yes"], saved);
    }
    async function recoverIntegration(saved: RunState): Promise<string> {
      const coordinator = saved.workers.find(worker => worker.workerId === saved.coordinatorId);
      if (coordinator?.worktree == null) throw new AgentOpsError("RUN_WORKTREE_MISSING", "Recovery requires the saved coordinator identity.");
      let absent = false;
      try {await stat(coordinator.worktree);}
      catch (cause) {if ((cause as NodeJS.ErrnoException).code === "ENOENT") absent = true; else throw cause;}
      if (absent) return (await recoverRunIntegrationAfterCleanup(commonDir, runId, deps.git)).receiptPath;
      const result = await advance(saved);
      if (result.status !== "ok" || !plain(result.data) || typeof result.data.receipt !== "string")
        throw new AgentOpsError("RUN_INTEGRATION_RECOVERY_REQUIRED", "Recover the sealed transaction before allowing any writer to resume.");
      return result.data.receipt;
    }
    async function step(cwd: string, args: readonly string[], saved: RunState): Promise<{status: string; code: string; data?: unknown}> {
      const remaining = saved.budget.limitMs - activeWallTimeMs(saved.budget.activeIntervals, Date.now());
      if (remaining <= 0) throw new AgentOpsError("RUN_BUDGET_EXHAUSTED", "No active time remains for final proof.");
      return await new Promise((resolve, reject) => {
        const env: NodeJS.ProcessEnv = {...process.env, AGENT_OPS_HOST: saved.host,
          AGENT_OPS_SESSION_ID: saved.workers.find(worker => worker.worktree === cwd)?.ownerSessionId ?? saved.ownerSessionId,
          AGENT_OPS_RUN_ID: saved.runId,
          AGENT_OPS_WORKER_ID: saved.workers.find(worker => worker.worktree === cwd)?.workerId ?? saved.coordinatorId,
          AGENT_OPS_WORKER_GENERATION: String(saved.workers.find(worker => worker.worktree === cwd)?.generation ?? saved.workers.find(worker => worker.workerId === saved.coordinatorId)?.generation)};
        delete env.CODEX_THREAD_ID;
        delete env.AGENT_OPS_AGENT_ID;
        delete env.CODEX_SANDBOX_NETWORK_DISABLED;
        const child = spawn(process.execPath, [fileURLToPath(new URL("./run-step-entry.js", import.meta.url)), cli, ...args, "--json"],
          {cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"]});
        let output = "";
        let closed = false;
        let escalation: ReturnType<typeof setTimeout> | undefined;
        const terminate = (): void => {
          if (child.pid === undefined || escalation !== undefined) return;
          try {process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");} catch {}
          escalation = setTimeout(() => {
            if (!closed) try {process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL");} catch {}
          }, 3000);
        };
        const timeout = setTimeout(terminate, remaining);
        const registration = (async () => {
          const identity = child.pid === undefined ? null : await nativeProcessIdentity(child.pid);
          if (identity === null || closed) {terminate(); return;}
          await repository.mutate(runId, current => {
            if (current.status !== "active" || current.disableRestart) {
              terminate(); throw new AgentOpsError("RUN_PROOF_STOPPED", "Stop raced final proof registration.");
            }
            return {...current, proofProcess: {processId: child.pid!, processIdentity: identity}};
          });
          child.stdin.end("start\n");
        })();
        child.stdin.on("error", terminate);
        void registration.catch(() => terminate());
        let checking = false;
        const control = setInterval(() => {
          if (checking) return;
          checking = true;
          void repository.read(runId).then(current => {
            if (current === null || current.disableRestart || current.status !== "active") terminate();
          }).catch(terminate).finally(() => {checking = false;});
        }, 250);
        child.stdout.on("data", chunk => {output += chunk.toString(); if (Buffer.byteLength(output) > 4 * 1024 * 1024) terminate();});
        child.stderr.resume();
        child.once("error", cause => {closed = true; clearTimeout(timeout); clearInterval(control); reject(cause);});
        child.once("close", async () => {
          closed = true;
          clearTimeout(timeout);
          clearTimeout(escalation);
          clearInterval(control);
          try {
            await registration;
            await repository.mutate(runId, current => ({...current,
              ...(current.proofProcess?.processId === child.pid ? {proofProcess: null} : {})}));
            const result = JSON.parse(output) as unknown;
            if (!plain(result) || !["ok", "error"].includes(String(result.status)) || typeof result.code !== "string") throw new Error();
            const coordinatorRoot = saved.workers[0]?.worktree;
            if (result.status === "error" && coordinatorRoot != null)
              await recordSavedReviewRunUsage(repository, runId, coordinatorRoot);
            if (plain(result.data) && plain(result.data.result) && typeof result.data.result.sourceFingerprint === "string" &&
              typeof result.data.result.taskId === "string") {
              const artifact = await readReviewReportArtifact(cwd, result.data.result.sourceFingerprint, result.data.result.taskId);
              if (artifact !== null) await recordReviewRunUsage(repository, runId, artifact);
            }
            resolve(result as {status: string; code: string; data?: unknown});
          } catch {reject(new AgentOpsError("RUN_FINAL_PROOF_INTERRUPTED", "Final gate did not return a complete result; inspect target and receipt before retrying."));}
        });
      });
    }
    async function stopAll(reason: "stop" | "budget" | "crash", closeBudget = true): Promise<void> {
      const current = (await repository.read(runId))!;
      for (const worker of current.workers.filter(active))
        await supervisor.stopWorker(runId, worker.workerId, worker.generation, reason);
      if (!closeBudget) return;
      await repository.mutate(runId, saved => ({...saved, budget: {...saved.budget,
        accumulatedMs: activeWallTimeMs(saved.budget.activeIntervals, Date.now()), lastObservedAt: new Date().toISOString(),
        activeIntervals: saved.budget.activeIntervals.map(interval => ({...interval, endMs: interval.endMs ?? Date.now()}))}}));
    }
    async function ensureSetup(workerRoot: string): Promise<void> {
      const current = (await repository.read(runId))!;
      const scoped = await runWorktreeDependencies(deps, current), config = await scoped.loadConfig(workerRoot);
      const setupHash = sha256(JSON.stringify(config.worktree?.setup ?? []));
      const complete = await readPrivateFile(join(workerRoot, ".agent-ops/tasks/run-setup-complete.json"), workerRoot);
      if (complete !== null && JSON.parse(complete).setupHash === setupHash) return;
      const attemptPath = join(workerRoot, ".agent-ops/tasks/run-setup-attempt.json");
      const attempt = await readPrivateFile(attemptPath, workerRoot);
      if (attempt !== null && (complete === null || JSON.parse(attempt).setupHash === setupHash) &&
          lastResume <= Date.parse(JSON.parse(attempt).startedAt))
        throw new AgentOpsError("RUN_SETUP_RECOVERY_REQUIRED", "Interrupted setup requires explicit resume before replaying commands.");
      if ((await collectChangeSurface(gitRunner(workerRoot))).paths.length > 0)
        throw new AgentOpsError("RUN_RECOVERY_DIRTY", "Preserve setup source changes before recovery.");
      await writePrivateFile(attemptPath, JSON.stringify({startedAt: new Date().toISOString(), setupHash}), workerRoot);
      for (const step of config.worktree?.setup ?? []) {
        const result = await scoped.runSetup(workerRoot, {...step, timeoutMs: step.timeoutMs ?? 600000});
        if (result.exitCode !== 0) throw new AgentOpsError("RUN_SETUP_RECOVERY_REQUIRED", "Registered setup failed; its artifact and checkout are preserved.");
      }
      await writePrivateFile(join(workerRoot, ".agent-ops/tasks/run-setup-complete.json"), JSON.stringify({setupHash}), workerRoot);
    }
    async function synchronizePolicy(): Promise<void> {
      const current = (await repository.read(runId))!;
      const policy = await readRunPolicy(current, await runRuntimeHash());
      if (policy === null) return;
      for (const worker of current.workers.filter(w => w.worktree !== null && w.status !== "delivered")) {
        if (await readPrivateFile(join(worker.worktree!, ".agent-ops/tasks/worktree.json"), worker.worktree!) === null) continue;
        const configPath = join(worker.worktree!, ".agent-ops/config.json");
        const previous = await readPrivateFile(configPath, worker.worktree!);
        if (previous === null || calculateConfigHash(JSON.parse(previous)) !== current.policyBinding!.configHash) {
          if ((await collectChangeSurface(gitRunner(worker.worktree!))).paths.length > 0)
            throw new AgentOpsError("RUN_POLICY_DIRTY", "Policy synchronization preserves uncommitted worker edits for explicit recovery.");
          await writePrivateFile(configPath, JSON.stringify(policy.config, null, 2) + "\n", worker.worktree!);
          const tracked = await deps.git(worker.worktree!, ["ls-files", "--error-unmatch", ".agent-ops/config.json"]);
          if (tracked.exitCode === 0) {
            if ((await deps.git(worker.worktree!, ["add", "--", ".agent-ops/config.json"])).exitCode !== 0 ||
                (await deps.git(worker.worktree!, ["commit", "-m", "Synchronize run verifier policy", "--", ".agent-ops/config.json"])).exitCode !== 0)
              throw new AgentOpsError("RUN_POLICY_SYNC_FAILED", "Could not commit the scoped policy synchronization.");
          }
        }
        await ensureSetup(worker.worktree!);
        const tasks = new TaskService(new FileTaskStore(join(worker.worktree!, ".agent-ops/tasks/state.json"), worker.worktree!), {
          completion: {root: worker.worktree!, gitRunner: gitRunner(worker.worktree!), loadConfig: async () => policy.config}});
        for (const record of (await tasks.list()).filter(r => r.status === "active" && r.supersededBy === undefined))
          if (record.policyConfigHash !== current.policyBinding!.configHash) await tasks.revise(record.task.id, {
            expectedContractHash: taskContractHash(record.task), criteria: record.task.criteria,
            reason: "Run execution policy changed; preserve the original goal and baselines, and require fresh proof.",
            diagnostics: ["run-policy:" + current.policyBinding!.artifactDigest]
          });
      }
      if (current.rootTaskId !== null) {
        const coordinator = current.workers.find(w => w.workerId === current.coordinatorId)!;
        const contract = await deps.tasks(coordinator.worktree!).treeContract(current.rootTaskId);
        await repository.mutate(runId, saved => ({...saved, currentContractHash: contract,
          contractRevision: saved.contractRevision + (saved.currentContractHash === contract ? 0 : 1)}));
      }
    }
    async function transitionPolicy(journal: PolicyTransitionJournal): Promise<readonly string[]> {
      const proposal = await readPrivateFile(join(directory, runId, "policy-proposals", journal.transitionId + ".json"), commonDir);
      if (proposal === null || "policy-" + sha256(proposal) !== journal.transitionId)
        throw new AgentOpsError("RUN_POLICY_PROPOSAL_CHANGED", "Policy proposal is missing or changed; preserve the pending journal.");
      const input = JSON.parse(proposal) as {config: import("../../../runtime/src/contracts.js").AgentOpsConfig; approvals: RunPolicyApproval[]};
      await stopAll("stop", false);
      let current = (await repository.read(runId))!;
      for (const writer of current.workers.filter(w => w.worktree !== null && w.status !== "delivered"))
        if ((await collectChangeSurface(gitRunner(writer.worktree!))).paths.length > 0)
          throw new AgentOpsError("RUN_POLICY_DIRTY", "Every writer must commit before a policy transition.");
      if (journal.stages.at(-1)!.stage === "prepared") {
        journal = await markPolicyTransitionStage(repository, runId, journal.transitionId, {stage: "fenced"});
      }
      if (journal.stages.at(-1)!.stage === "fenced") {
        if (current.policyBinding!.artifactDigest === journal.oldPolicyArtifact!.artifactDigest) {
          const coordinator = current.workers.find(w => w.workerId === current.coordinatorId)!;
          const old = (await readRunPolicy(current, await runRuntimeHash(), Date.now(), true))!;
          if (current.rootTaskId !== null && journal.deliveredMarkers.length > 0) {
            const record = await readWorktreeRecord(coordinator.worktree!);
            if (record === null) throw new AgentOpsError("RUN_WORKTREE_MISSING", "Policy transition requires the registered coordinator.");
            await integrateSessionChildren({...deps, loadConfig: async () => old.config}, record, current.rootTaskId, journal.deliveredMarkers.map(w => w.workerId));
          }
          await bindRunPolicy(repository, runId, {config: input.config, approvals: input.approvals, baseTrustBinding: old.baseTrustBinding,
            runtimeHash: old.runtimeHash, expectedDigest: current.policyBinding!.artifactDigest});
        } else if (current.policyBinding!.configHash !== calculateConfigHash(input.config))
          throw new AgentOpsError("RUN_POLICY_TRANSITION_STALE", "Policy no longer matches the pending assessment.");
        journal = await markPolicyTransitionStage(repository, runId, journal.transitionId, {stage: "bound"});
      }
      if (journal.stages.at(-1)!.stage === "bound") {
        journal = await renewPendingRunPolicy(repository, runId, journal);
        await synchronizePolicy();
        current = (await repository.read(runId))!;
        const coordinator = current.workers.find(w => w.workerId === current.coordinatorId)!;
        const control = new RunControlService(repository);
        const policy = (await readRunPolicy(current, await runRuntimeHash()))!;
        for (const assessment of policy.approvals) {
          const [kind, id] = assessment.capabilityId.split(":");
          const capability = kind === "command" ? policy.config.verification.commands.find(c => c.id === id) :
            kind === "runner" ? policy.config.verification.acceptanceRunners?.find(c => c.id === id) : policy.config.worktree?.setup?.[Number(id)];
          const command = canonicalJson(capability), resource = canonicalJson({repository: root, capabilityId: assessment.capabilityId});
          await control.recordAuthorization(runId, {authorizationId: journal.transitionId + ":" + assessment.capabilityId,
            workerId: coordinator.workerId, generation: coordinator.generation, nativeSessionId: coordinator.nativeSessionId,
            operation: "policy-capability", command, resource, commandDigest: sha256(command), resourceDigest: sha256(resource),
            reason: assessment.reason, result: "auto-approved", source: "coordinator-policy-review", policyConfigHash: current.policyBinding!.configHash,
            runtimeHash: current.policyBinding!.runtimeHash, expiresAt: current.policyBinding!.expiresAt, policyArtifactDigest: current.policyBinding!.artifactDigest});
        }
        journal = await markPolicyTransitionStage(repository, runId, journal.transitionId, {stage: "synchronized",
          contractHash: current.currentContractHash, contractRevision: current.contractRevision, taskIds: current.tasks.map(t => t.taskId)});
      }
      await completePolicyTransition(repository, runId, journal.transitionId);
      current = (await repository.read(runId))!;
      if (Date.parse(current.policyBinding!.expiresAt) <= Date.now()) {
        const old = (await readRunPolicy(current, await runRuntimeHash(), Date.now(), true))!;
        await bindRunPolicy(repository, runId, {config: old.config, runtimeHash: old.runtimeHash,
          baseTrustBinding: old.baseTrustBinding, expectedDigest: current.policyBinding!.artifactDigest});
      }
      return journal.resumeIds.map(w => w.workerId);
    }
    async function repair(worker: RunWorkerRecord, code: string, message: string): Promise<void> {
      const current = (await repository.read(runId))!;
      const saved = current.workers.find(w => w.workerId === worker.workerId)!;
      const localTasks = await new TaskService(new FileTaskStore(join(worker.worktree!, ".agent-ops", "tasks", "state.json"), worker.worktree!)).list();
      const pins = await pendingFindingPins(worker.worktree!, localTasks, worker.taskId);
      const observation = await observeRunFailure(current, worker.worktree!, localTasks, worker.taskId, code, pins);
      const failed = observation.checks.find(check => check.status !== "PASS");
      const previousPath = join(directory, runId, "failure-observations", worker.workerId + ".json");
      const previous = await readPrivateFile(previousPath, commonDir);
      const priorDigest = previous === null ? null : JSON.parse(previous).digest as string;
      if (priorDigest !== null && !/^[a-f0-9]{64}$/u.test(priorDigest)) throw new AgentOpsError("RUN_FAILURE_OBSERVATION_CHANGED", "Failure observation pointer is invalid.");
      const prior = priorDigest === null ? null : await readPrivateFile(join(directory, runId, "failure-observations", priorDigest + ".json"), commonDir);
      if (priorDigest !== null && (prior === null || sha256(prior) !== priorDigest)) throw new AgentOpsError("RUN_FAILURE_OBSERVATION_CHANGED", "Failure observation is missing or changed.");
      const usefulProgress = prior !== null && compareFailureObservations(JSON.parse(prior) as FailureObservation, observation).usefulProgress;
      const content = canonicalJson(observation), digest = sha256(content);
      await writePrivateFile(join(directory, runId, "failure-observations", digest + ".json"), content, commonDir);
      await writePrivateFile(previousPath, canonicalJson({digest}), commonDir);
      const result = await supervisor.recordFailure(runId, worker.workerId, worker.generation, {
        checkId: failed?.checkId ?? code, pinId: failed?.pinId ?? null, phase: failed?.phase ?? "native", failureClass: failed?.failureClass ?? code,
        fingerprint: observation.failureKey ?? sha256(canonicalJson({taskId: worker.taskId, code})), progressDigest: observation.progressDigest,
        diagnosticDigest: sha256(message), round: (saved.lastFailure?.round ?? 0) + 1, usefulProgress});
      if (result.noProgress) {
        await scheduler.blockTaskAndDependents(runId, worker.taskId, code);
        if (worker.workerId === current.coordinatorId)
          await repository.mutate(runId, state => ({...state, status: "blocked", disableRestart: true}));
        return;
      }
      const latest = result.state.workers.find(w => w.workerId === worker.workerId)!;
      if (["fenced", "stopped"].includes(latest.status)) await start(latest, message);
      else await supervisor.sendRepair(runId, worker.workerId, worker.generation, message);
    }
    async function acceptReceipt(current: RunState, path: string): Promise<void> {
      const source = await readPrivateFile(path, commonDir);
      if (source === null) throw new AgentOpsError("RUN_RECEIPT_REQUIRED", "Final receipt is missing.");
      const receipt = JSON.parse(source) as FinishReceipt;
      const latest = (await repository.read(runId))!;
      if (latest.integration === null || latest.integration.receiptPath !== path || latest.integration.receiptDigest !== sha256(source))
        throw new AgentOpsError("RUN_INTEGRATION_RECEIPT_INVALID", "Receipt must be the exact sealed receipt of the current run transaction.");
      validateRunIntegrationReceipt(latest.integration, receipt);
      await recoverRunIntegrationAfterCleanup(commonDir, runId, deps.git);
      if (receipt.sessionId !== current.ownerSessionId ||
        !receipt.tasks.some(record => record.task.id === current.rootTaskId && record.task.goal === current.goal) ||
        receipt.tasks.some(record => record.status !== "complete") ||
        Object.values(receipt.verification).some(seal => sha256(JSON.stringify(seal.value)) !== seal.digest) ||
        Object.entries(receipt.executionArtifacts ?? {}).some(([path, seal]) => typeof seal.value !== "string" ||
          sha256(JSON.stringify(seal.value)) !== seal.digest || path !== ".agent-ops/tasks/acceptance/" + sha256(seal.value) + ".json") ||
        Object.values(receipt.historicalReviews ?? {}).some(seal => typeof seal.value !== "string" || sha256(JSON.stringify(seal.value)) !== seal.digest) ||
        Object.values(receipt.reviews).some(seals => sha256(JSON.stringify(seals.attestation.value)) !== seals.attestation.digest ||
          sha256(JSON.stringify(seals.report.value)) !== seals.report.digest))
        throw new AgentOpsError("RUN_RECEIPT_TARGET_CHANGED", "Receipt is not complete proof for the current run and target.");
      await readFinishedReview(deps, root, commonDir, path);
      for (const history of Object.values(receipt.historicalReviews ?? {}))
        await recordReviewRunUsage(repository, runId, JSON.parse(history.value as string) as ReviewReportArtifact);
      for (const review of Object.values(receipt.reviews))
        await recordReviewRunUsage(repository, runId, review.report.value as ReviewReportArtifact);
      const finalContract = treeContractHash(receipt.tasks.map(record => record.task));
      await repository.mutate(runId, current => ({...current, currentContractHash: finalContract,
        contractRevision: current.contractRevision + (current.currentContractHash === finalContract ? 0 : 1)}));
      await supervisor.finalize(runId, {targetCommit: receipt.candidateHead, candidateCommit: receipt.candidateHead,
        verificationPass: true, reviewPass: true, taskStateComplete: true, receiptWritten: true, receiptDigest: sha256(source)});
      try {
        await stopAll("stop");
        await launchd.disableRestart(runDescriptor(current), "verified final integration completed");
      } catch {
        await repository.appendEvent(runId, {type: "diagnostic", code: "RUN_COMPLETE_CLEANUP_PENDING",
          workerId: null, taskId: null, detail: "Final receipt is valid; background cleanup needs reconciliation. Restart remains disabled."});
      }
    }
    try {
      if (!state.budget.activeIntervals.some(interval => interval.endMs === null))
        await repository.mutate(runId, current => ({...current, budget: {...current.budget,
          activeIntervals: [...current.budget.activeIntervals, {startMs: Date.now(), endMs: null}]}}));
      if (state.proofProcess != null) {
        await transport.stop({nativeSessionId: "run-proof", nativeJobId: null, ...state.proofProcess,
          instance: state.nativeInstance, generation: 1, reason: "reconcile interrupted evidence process"});
        await repository.mutate(runId, current => ({...current, proofProcess: null}));
      }
      await stopAll("crash", false);
      state = (await repository.read(runId))!;
      if (state.rootTaskId === null) {
        const coordinator = state.workers.find(w => w.workerId === state.coordinatorId)!;
        let record = await readWorktreeRecord(coordinator.worktree!);
        if (record === null) {
          record = await ensureSessionWorktree(await runWorktreeDependencies(deps, state), {cwd: root, sessionId: state.ownerSessionId,
            runOwnership: {runId, coordinatorId: state.coordinatorId, workerId: coordinator.workerId, ownerSessionId: coordinator.ownerSessionId, generation: coordinator.generation}});
        } else {await ensureSetup(record.path);}
        await repository.mutate(runId, current => ({...current, workers: current.workers.map(w => w.workerId === coordinator.workerId ? {...w, worktree: record!.path} : w)}));
        await writePrivateFile(join(record.path, ".agent-ops/tasks/run-goal.json"), JSON.stringify({runId, goal: state.goal, goalHash: state.goalHash}), record.path);
        state = (await repository.read(runId))!;
      }
      if (state.integration !== null) {
        let receipt = state.integration.receiptPath;
        if (state.integration.status !== "cleaned") {
          receipt = await recoverIntegration(state);
        }
        if (receipt === null) throw new AgentOpsError("RUN_RECEIPT_REQUIRED", "Recovered integration has no final receipt.");
        await acceptReceipt(state, receipt);
        return;
      }
      const pendingPolicy = await discoverPendingPolicyTransition(repository, runId);
      if (pendingPolicy !== null) await transitionPolicy(pendingPolicy);
      else if (state.policyBinding !== undefined) await synchronizePolicy();
      state = (await repository.read(runId))!;
      for (const worker of state.workers.filter(w => active(w) || w.status === "stopped")) {
        if (worker.workerId !== state.coordinatorId && (worker.worktree === null ||
            !(await deps.tasks(worker.worktree).list()).some(r => r.task.id === worker.taskId))) continue;
        try {await start(worker);}
        catch (cause) {
          await repository.appendEvent(runId, {type: "diagnostic", code: cause instanceof AgentOpsError ? cause.code : "RUN_RECOVERY_FAILED",
            workerId: worker.workerId, taskId: worker.taskId, detail: "Writer recovery refused; preserve its checkout until the prerequisite is corrected."});
          if (worker.nativeSessionId !== null) await supervisor.stopWorker(runId, worker.workerId, worker.generation, "crash");
          await scheduler.blockTaskAndDependents(runId, worker.taskId, cause instanceof AgentOpsError ? cause.code : "RUN_RECOVERY_FAILED");
          await repository.mutate(runId, current => ({...current,
            ...(worker.workerId === current.coordinatorId ? {status: "blocked" as const, disableRestart: true} : {}),
            workers: current.workers.map(w => w.workerId === worker.workerId ? {...w, status: "blocked"} : w)}));
        }
      }
      for (;;) {
        state = (await repository.read(runId))!;
        if (state.rootTaskId !== null && state.workers[0]?.worktree !== null) {
          const coordinatorRoot = state.workers[0]!.worktree!;
          const tasks = new TaskService(new FileTaskStore(join(coordinatorRoot, ".agent-ops", "tasks", "state.json"), coordinatorRoot));
          const rootTask = await tasks.status({taskId: state.rootTaskId});
          if (rootTask.task.goal !== state.goal) throw new AgentOpsError("RUN_GOAL_CHANGED", "The task tree no longer binds the immutable user goal.");
          const contract = await tasks.treeContract(state.rootTaskId);
          if (contract !== state.currentContractHash) {
            const writers = state.workers.filter(active).map(worker => worker.workerId);
            await stopAll("stop", false);
            state = await repository.mutate(runId, current => ({...current, currentContractHash: contract, contractRevision: current.contractRevision + 1}));
            for (const id of writers) {
              const worker = state.workers.find(worker => worker.workerId === id)!;
              await start(worker, "Contract changed. Preserve the original goal and rerun proof for the current criteria. Old generations and native completion are unproven.");
            }
          }
        }
        if (state.disableRestart || ["stopping", "paused", "budget-limited", "blocked"].includes(state.status)) {
          await stopAll(state.status === "budget-limited" ? "budget" : "stop");
          return;
        }
        const elapsed = activeWallTimeMs(state.budget.activeIntervals, Date.now());
        if (elapsed >= state.budget.limitMs) {
          await repository.mutate(runId, current => ({...current, status: "budget-limited", disableRestart: true}));
          await launchd.disableRestart(runDescriptor(state), "active run time budget exhausted");
          await stopAll("budget"); return;
        }
        await repository.mutate(runId, current => ({...current, budget: {...current.budget,
          accumulatedMs: activeWallTimeMs(current.budget.activeIntervals, Date.now()), lastObservedAt: new Date().toISOString()}}));
        await schedule();
        state = (await repository.read(runId))!;
        for (const worker of state.workers.filter(w => ["running", "idle"].includes(w.status))) {
          await supervisor.heartbeat(runId, worker.workerId, worker.generation);
          const observation = await supervisor.observeWorker(runId, worker.workerId, worker.generation);
          if (!observation.processAlive) {
            try {await repair(worker, "RUN_NATIVE_EXITED", "Native process exited without a verified delivery. Resume the assigned task and provide the current evidence.");}
            catch (cause) {
              await scheduler.blockTaskAndDependents(runId, worker.taskId, cause instanceof AgentOpsError ? cause.code : "RUN_RECOVERY_FAILED");
              await repository.mutate(runId, state => ({...state,
                ...(worker.workerId === state.coordinatorId ? {status: "blocked" as const, disableRestart: true} : {}),
                workers: state.workers.map(w => w.workerId === worker.workerId ? {...w, status: "blocked"} : w)}));
            }
            continue;
          }
          const requestPath = join(worker.worktree!, ".agent-ops", "tasks", "run-request.json");
          const source = await readPrivateFile(requestPath, worker.worktree!);
          if (source === null || Buffer.byteLength(source) > 128 * 1024) {
            if (observation.nativeGoalState === "complete") await repair(worker, "RUN_NATIVE_COMPLETION_UNPROVEN",
              "Native completion has no agent-ops delivery or final receipt. Read run-instructions.json, complete the evidence loop and submit handoff or finalize.");
            continue;
          }
          async function rejectRequest(code: string): Promise<void> {
            const digest = sha256(source!);
            const diagnostic = join(directory, runId, "invalid-requests", worker.workerId + "-" + worker.generation + "-" + digest + ".json");
            if (await readPrivateFile(diagnostic, commonDir) === null) {
              await writePrivateFile(diagnostic, canonicalJson({code, workerId: worker.workerId, generation: worker.generation, requestDigest: digest}), commonDir);
              await repository.appendEvent(runId, {type: "diagnostic", code, workerId: worker.workerId, taskId: worker.taskId,
                detail: "Supervisor request is malformed or stale; a diagnostic response is available in the current checkout."});
            }
            await writePrivateFile(join(worker.worktree!, ".agent-ops/tasks/run-response.json"), JSON.stringify({code,
              workerId: worker.workerId, generation: worker.generation, error: "Read current run-instructions.json and replace the malformed or stale request atomically."}), worker.worktree!);
            if (observation.nativeGoalState === "complete") await repair(worker, code,
              "A malformed or stale request cannot establish completion. Read current run-instructions.json and replace run-request.json atomically.");
          }
          let request: unknown;
          try {request = JSON.parse(source);} catch {await rejectRequest("RUN_REQUEST_INVALID"); continue;}
          if (!plain(request) || typeof request.requestId !== "string" || !/^[A-Za-z0-9-]{1,64}$/u.test(request.requestId)) {
            await rejectRequest("RUN_REQUEST_INVALID"); continue;
          }
          if (request.workerId !== worker.workerId || request.generation !== worker.generation) {
            await rejectRequest("RUN_REQUEST_STALE"); continue;
          }
          const donePath = join(directory, runId, "requests", sha256(request.requestId) + ".json");
          const requestDigest = sha256(canonicalJson(request));
          const completed = await readPrivateFile(donePath, commonDir);
          if (completed !== null) {
            const cached: unknown = JSON.parse(completed);
            const response = plain(cached) && cached.requestDigest === requestDigest ? cached.response :
              {requestId: request.requestId, code: "RUN_REQUEST_ID_CONFLICT", error: "A request ID cannot be reused for different content."};
            await writePrivateFile(join(worker.worktree!, ".agent-ops", "tasks", "run-response.json"), JSON.stringify(response), worker.worktree!);
            if (observation.nativeGoalState === "complete") await repair(worker, "RUN_NATIVE_COMPLETION_UNPROVEN",
              "The previous request response is available, but current delivery or final proof is still missing. Continue the assigned goal and submit a new request.");
            continue;
          }
          const current = (await repository.read(runId))!;
          let response: unknown;
          try {
            if (current.status !== "active" || request.contractHash !== current.currentContractHash)
              throw new AgentOpsError("RUN_CONTRACT_CHANGED", "Request must bind the current run contract.");
            const fields = request.action === "policy" ? ["configFile", "expectedPolicyHash", "approvals"] : request.action === "plan" ? ["title", "intent", "criteria"] : request.action === "question" ? ["prompt"] : request.action === "worker" ? ["title", "intent", "criteria", "dependencies"] :
              request.action === "handoff" || request.action === "finalize" ? ["sourceFiles"] : [];
            if (Object.keys(request).some(key => !["requestId", "workerId", "generation", "contractHash", "action", ...fields].includes(key)))
              throw new AgentOpsError("RUN_REQUEST_INVALID", "Unknown request fields are not accepted.");
            if (request.action === "policy") {
              if (worker.workerId !== current.coordinatorId || current.policyBinding === undefined ||
                request.expectedPolicyHash !== current.policyBinding.configHash || typeof request.configFile !== "string" || !Array.isArray(request.approvals))
                throw new AgentOpsError("RUN_POLICY_STALE", "Only the coordinator can assess the current run execution policy.");
              const path = await resolveContainedPath(worker.worktree!, request.configFile);
              const source = await readPrivateFile(path, worker.worktree!);
              if (source === null || Buffer.byteLength(source) > 128 * 1024) throw new AgentOpsError("RUN_POLICY_INVALID", "Proposed policy must be bounded private JSON.");
              const policy = await readRunPolicy(current, await runRuntimeHash());
              if (policy === null) throw new AgentOpsError("RUN_POLICY_INVALID", "Run has no original policy binding.");
              const candidate = validateRunPolicyChange(policy.config, JSON.parse(source), request.approvals as RunPolicyApproval[]);
              const proposal = canonicalJson({config: candidate, approvals: request.approvals, oldArtifactDigest: current.policyBinding.artifactDigest});
              const transitionId = "policy-" + sha256(proposal);
              await writePrivateFile(join(directory, runId, "policy-proposals", transitionId + ".json"), proposal, commonDir);
              const journal = await beginPolicyTransition(repository, runId, {transitionId,
                expectedOldArtifactDigest: current.policyBinding.artifactDigest, expectedContractHash: current.currentContractHash});
              const writers = await transitionPolicy(journal);
              const changed = (await repository.read(runId))!;
              for (const id of writers) await start(changed.workers.find(w => w.workerId === id)!,
                "Execution policy was assessed and synchronized. Read the current instructions, preserve original baselines, and obtain fresh evidence. Authorization expires with this run.");
              response = {requestId: request.requestId, code: "RUN_POLICY_SYNCHRONIZED", policyConfigHash: changed.policyBinding!.configHash,
                contractHash: changed.currentContractHash};
            } else if (request.action === "plan") {
              if (current.rootTaskId !== null || typeof request.title !== "string" || typeof request.intent !== "string" || !Array.isArray(request.criteria))
                throw new AgentOpsError("RUN_PLAN_INVALID", "Initial plan requires a title, intent and valid criteria.");
              const config = await deps.loadConfig(worker.worktree!);
              const service = new TaskService(new FileTaskStore(join(worker.worktree!, ".agent-ops", "tasks", "state.json"), worker.worktree!),
                {completion: {root: worker.worktree!, gitRunner: gitRunner(worker.worktree!), loadConfig: async () => config}});
              const task = await service.create({title: request.title, intent: request.intent, goal: current.goal,
                criteria: request.criteria as AcceptanceCriterion[], sessionId: worker.ownerSessionId, policyConfigHash: calculateConfigHash(config)});
              await repository.mutate(runId, saved => ({...saved, rootTaskId: task.task.id, currentContractHash: treeContractHash([task.task]),
                tasks: saved.tasks.map(node => node.taskId === worker.taskId ? {...node, taskId: task.task.id} : node),
                workers: saved.workers.map(w => w.workerId === worker.workerId ? {...w, taskId: task.task.id} : w)}));
              response = {requestId: request.requestId, code: "RUN_PLAN_CREATED", task: task.task, contractHash: treeContractHash([task.task])};
              await instructions((await repository.read(runId))!.workers.find(w => w.workerId === worker.workerId)!);
            } else if (request.action === "worker") {
              if (worker.workerId !== current.coordinatorId || current.rootTaskId === null)
                throw new AgentOpsError("RUN_COORDINATOR_REQUIRED", "Only the registered coordinator can plan child workers.");
              const taskId = "task-" + (await import("node:crypto")).randomUUID();
              const plan = workerPlan({title: request.title, intent: request.intent, criteria: request.criteria, dependencies: request.dependencies}, taskId, current);
              const {taskId: _id, ...specification} = plan;
              const content = JSON.stringify(specification);
              await writePrivateFile(join(directory, runId, "plans", taskId + ".json"), content, commonDir);
              await scheduler.addTasks(runId, [{taskId, dependencies: plan.dependencies, planDigest: sha256(content), status: "planned",
                workerId: null, deliveryDigest: null, sourceCommit: null, blockedReason: null}]);
              response = {requestId: request.requestId, code: "RUN_WORKER_PLANNED", taskId};
            } else if (request.action === "handoff") {
              if (worker.workerId === current.coordinatorId) throw new AgentOpsError("RUN_COORDINATOR_FINALIZE_REQUIRED", "Coordinator requests finalization after all children deliver.");
              const record = await readWorktreeRecord(worker.worktree!);
              if (record === null || (await collectChangeSurface(gitRunner(worker.worktree!))).paths.length > 0)
                throw new AgentOpsError("RUN_DELIVERY_DIRTY", "Local handoff requires a clean committed checkout.");
              const tasks = new TaskService(new FileTaskStore(join(worker.worktree!, ".agent-ops", "tasks", "state.json"), worker.worktree!));
              const contract = await tasks.treeContract(worker.taskId);
              const head = (await deps.git(worker.worktree!, ["rev-parse", "HEAD"])).stdout.trim();
              if (head === record.base) {
                const scope = await resolveReviewScope({root: worker.worktree!, runner: gitRunner(worker.worktree!), base: head,
                  noChangePaths: request.sourceFiles as string[]});
                await tasks.recordEvidence(worker.taskId, {}, undefined, scope.changedFiles);
              }
              const deliveryDigest = sha256(JSON.stringify({runId, workerId: worker.workerId, generation: worker.generation, contract, head}));
              const handoff = {workerId: worker.workerId, generation: worker.generation, deliveryDigest, contractDigest: contract, sourceCommit: head};
              await supervisor.beginHandoff(runId, handoff);
              const observation = await transport.inspect({nativeSessionId: worker.nativeSessionId!, nativeJobId: worker.nativeJobId,
                processId: worker.processId, processIdentity: worker.processIdentity, instance: current.nativeInstance});
              await supervisor.confirmHandoff(runId, handoff, {processDead: !observation.processAlive});
              await assertRunDeliverySnapshot(worker.worktree!, worker.taskId, head, contract, tasks);
              const artifactRefs: string[] = [];
              for (const localTask of (await tasks.list()).filter(task => task.supersededBy === undefined && task.status !== "archived")) {
                if (head === record.base)
                  await tasks.recordEvidence(localTask.task.id, {}, undefined, (await tasks.status({taskId: worker.taskId})).noChangePaths);
                const result = await step(worker.worktree!, ["verify", "--task", localTask.task.id, "--base", record.base], current);
                if (result.status !== "ok") throw new AgentOpsError(result.code, "Local verifier did not pass. Preserve the failed check diagnostics for repair.");
                artifactRefs.push(...Object.values((await tasks.status({taskId: localTask.task.id})).evidence).flat());
              }
              await assertRunDeliverySnapshot(worker.worktree!, worker.taskId, head, contract, tasks);
              if (head === record.base) {
                const scope = await resolveReviewScope({root: worker.worktree!, runner: gitRunner(worker.worktree!), base: head,
                  noChangePaths: (await tasks.status({taskId: worker.taskId})).noChangePaths});
                await writeNoChangeDelivery(record, {schemaVersion: 1, deliveryKind: "no-change", sourceCommit: head,
                  deliveryDigest, contractDigest: contract, artifactRefs, reviewScope: JSON.stringify(scope), runId,
                  workerId: worker.workerId, generation: worker.generation});
              }
              await supervisor.publishDelivery(runId, handoff, {noChange: head === record.base, artifactRefs});
              await scheduler.markDelivered(runId, worker.taskId, deliveryDigest, head);
              response = {requestId: request.requestId, code: "RUN_WORKER_DELIVERED", taskId: worker.taskId, sourceCommit: head};
            } else if (request.action === "question") {
              if (typeof request.prompt !== "string" || request.prompt.trim().length === 0 || request.prompt.length > 4096)
                throw new AgentOpsError("RUN_QUESTION_INVALID", "Question must be bounded and substantive.");
              await stopAll("stop");
              await repository.mutate(runId, saved => ({...saved, status: "awaiting-input", questions: [...saved.questions,
                {questionId: request.requestId as string, prompt: request.prompt as string, askedAt: new Date().toISOString(), answeredAt: null, answerDigest: null}]}));
              response = {requestId: request.requestId, code: "RUN_AWAITING_INPUT"};
            } else if (request.action === "finalize") {
              if (worker.workerId !== current.coordinatorId || current.tasks.some(task => task.taskId !== current.rootTaskId && task.status !== "delivered"))
                throw new AgentOpsError("RUN_DELIVERIES_PENDING", "The coordinator must wait for every planned child delivery before final integration.");
              if (current.rootTaskId === null) throw new AgentOpsError("RUN_PLAN_REQUIRED", "Create the goal-bound task before requesting finalization.");
              const pending = await pendingFindingPins(worker.worktree!, await deps.tasks(worker.worktree!).list(), current.rootTaskId);
              if (pending.length > 0) {
                await writePrivateFile(join(worker.worktree!, ".agent-ops", "tasks", "run-pending-findings.json"), JSON.stringify({findings: pending}), worker.worktree!);
                throw new AgentOpsError("RUN_FINDING_RATCHET_REQUIRED", "Pin the blocking findings in run-pending-findings.json; mechanically testable findings require regression checks, and review-only fallback needs an explicit recorded reason.");
              }
              if (request.sourceFiles !== undefined) {
                const base = (await deps.git(root, ["rev-parse", current.targetBranch + "^{commit}"])).stdout.trim();
                const scope = await resolveReviewScope({root: worker.worktree!, runner: gitRunner(worker.worktree!), base,
                  noChangePaths: request.sourceFiles as string[]});
                await new TaskService(new FileTaskStore(join(worker.worktree!, ".agent-ops", "tasks", "state.json"), worker.worktree!))
                  .recordEvidence(current.rootTaskId, {}, undefined, scope.changedFiles);
              }
              await stopAll("stop", false);
              const result = await advance(current);
              if (result.status !== "ok") throw new AgentOpsError(result.code, "Final proof failed; inspect saved verifier and fresh review reports before repair.");
              const data = result.data;
              if (!plain(data) || typeof data.receipt !== "string") throw new AgentOpsError("RUN_RECEIPT_REQUIRED", "Finalization requires the receipt returned by the existing finish gate.");
              await acceptReceipt(current, data.receipt);
              response = {requestId: request.requestId, code: "RUN_COMPLETE", receipt: data.receipt};
            } else throw new AgentOpsError("RUN_ACTION_INVALID", "Unsupported supervisor request.");
          } catch (cause) {
            response = {requestId: request.requestId, code: cause instanceof AgentOpsError ? cause.code : "RUN_REQUEST_FAILED", error: cause instanceof AgentOpsError ? cause.message : "Request failed; inspect local diagnostics."};
            const latest = (await repository.read(runId))!;
            const stopped = latest.workers.find(w => w.workerId === worker.workerId);
            if (request.action === "finalize" && latest.integration !== null && (latest.integration.status !== "prepared" ||
              (await deps.git(root, ["rev-parse", latest.targetBranch + "^{commit}"])).stdout.trim() === latest.integration.candidate)) {
              const recovered = await recoverIntegration(latest);
              await acceptReceipt(latest, recovered);
              response = {requestId: request.requestId, code: "RUN_COMPLETE", receipt: recovered};
            } else if (request.action === "policy" && await discoverPendingPolicyTransition(repository, runId) !== null) {
              await repository.appendEvent(runId, {type: "diagnostic", code: "RUN_POLICY_RECOVERY_REQUIRED", workerId: worker.workerId, taskId: worker.taskId,
                detail: "Policy transition is preserved; explicit resume must reconcile the pending journal before any writer starts."});
              await repository.mutate(runId, state => ({...state, status: "paused", awaitingResume: true, disableRestart: true}));
              await stopAll("stop");
              await launchd.disableRestart(runDescriptor(latest), "pending policy transition needs reconciliation");
            } else if (["handoff", "finalize"].includes(String(request.action)) && latest.status === "active" && stopped !== undefined &&
              ["stopped", "fenced"].includes(stopped.status)) {
              await writePrivateFile(join(worker.worktree!, ".agent-ops", "tasks", "run-last-failure.json"), JSON.stringify(response), worker.worktree!);
              await repair(stopped, cause instanceof AgentOpsError ? cause.code : "RUN_PROOF_FAILED",
                "Evidence did not pass. Read run-last-failure.json and saved review/verification reports, fix substantive findings, then request a new evidence gate.");
            }
          }
          await writePrivateFile(donePath, JSON.stringify({requestDigest, response}), commonDir);
          const after = (await repository.read(runId))!;
          if (after.status === "complete") {
            await writePrivateFile(join(directory, runId, "final-response.json"), JSON.stringify(response), commonDir);
            return;
          }
          await writePrivateFile(join(worker.worktree!, ".agent-ops", "tasks", "run-response.json"), JSON.stringify(response), worker.worktree!);
          if ((await repository.read(runId))!.status === "awaiting-input") return;
        }
        await delay(1000);
      }
    } catch (cause) {
      await repository.appendEvent(runId, {type: "diagnostic", code: cause instanceof AgentOpsError ? cause.code : "RUN_SUPERVISOR_FAILED",
        workerId: null, taskId: null, detail: "Supervisor stopped; worktree and proof artifacts are preserved."});
      try {await stopAll("crash");}
      finally {
        await repository.mutate(runId, current => ({...current, status: current.status === "complete" ? "complete" : "blocked", disableRestart: true}));
        await launchd.disableRestart(runDescriptor(state), "supervisor could not safely recover");
      }
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new AgentOpsError("RUN_SUPERVISOR_ARGUMENTS", "Supervisor requires canonical repository root and run ID.");
  await superviseNativeRun(process.argv[2]!, process.argv[3]!);
}
