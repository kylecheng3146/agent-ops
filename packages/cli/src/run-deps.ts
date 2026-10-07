import {randomUUID} from "node:crypto";
import {execFile, spawn} from "node:child_process";
import {promisify} from "node:util";
import {mkdir, stat} from "node:fs/promises";
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
import {worktreeDependencies, gitRunner, trustStore} from "./parallel-deps.js";
import type {RunCommandService} from "./commands/run.js";
import {NativeRunTransport} from "../../../runtime/src/run/transport.js";
import {ClaudeGoalHost} from "../../../runtime/src/run/hosts/claude.js";
import {CodexGoalHost} from "../../../runtime/src/run/hosts/codex.js";
import {RunSupervisor} from "../../../runtime/src/run/supervisor.js";
import {activeWallTimeMs} from "../../../runtime/src/run/scheduler.js";
import {bindRunPolicy, readRunPolicy, runRuntimeHash, runPolicyAssessment} from "../../../runtime/src/run/policy.js";
import {repositoryTrustBinding} from "./context.js";
import {CLI_VERSION} from "./version.js";
import {calculateConfigHash, canonicalJson} from "../../../runtime/src/config/hash.js";
import type {FinishDependencies} from "../../../runtime/src/parallel/finish.js";
import {discoverPendingPolicyTransition, renewBoundPolicyTransition, currentPolicyArtifact, type PolicyTransitionJournal} from "../../../runtime/src/run/policy-transition.js";
import {nativeProcessIdentity} from "../../../runtime/src/run/transport.js";
import {redactSecrets} from "../../../runtime/src/security/redact.js";
import {RunControlService} from "../../../runtime/src/run/controls.js";
import {recordRunPhase} from "../../../runtime/src/run/phase.js";
import type {AdvancePhaseObserver} from "./commands/advance.js";

/** Worktree construction happens before a native lease exists; it must never write global trust. */
export async function runWorktreeDependencies(deps: FinishDependencies, state: RunState): Promise<FinishDependencies> {
  const policy = await readRunPolicy(state, await runRuntimeHash());
  if (policy === null || (await trustStore().status(policy.baseTrustBinding)).status !== "TRUSTED")
    throw new AgentOpsError("RUN_REPO_UNTRUSTED", "Run worktree setup requires the original trusted repository and current scoped policy.");
  const status: FinishDependencies["trust"]["status"] = async (_root, config) =>
    calculateConfigHash(config) === state.policyBinding!.configHash ? "TRUSTED" : "STALE";
  return {...deps, loadConfig: async () => policy.config,
    runSetup: async (root, step) => {
      const index = (policy.config.worktree?.setup ?? []).findIndex(s => canonicalJson({...s, timeoutMs: s.timeoutMs ?? 600000}) === canonicalJson(step));
      if (index < 0) throw new AgentOpsError("RUN_SETUP_UNAUTHORIZED", "Setup must select an exact fixed policy capability.");
      const repository = new FileRunRepository(join(state.commonDir, "agent-ops/runs"), state.commonDir);
      const current = (await repository.read(state.runId))!;
      const coordinator = current.workers.find(w => w.workerId === current.coordinatorId)!;
      const command = canonicalJson(step), resource = canonicalJson({checkout: root, capabilityId: "setup:" + index});
      const approved = await runPolicyAssessment(current, policy, "setup:" + index);
      await new RunControlService(repository).recordAuthorization(state.runId, {authorizationId: "setup:" + index + ":" + sha256(resource) + ":" + current.policyBinding!.artifactDigest,
        workerId: coordinator.workerId, generation: coordinator.generation, nativeSessionId: coordinator.nativeSessionId, operation: "worktree-setup",
        command, resource, commandDigest: sha256(command), resourceDigest: sha256(resource), reason: approved?.reason ?? "The original user trust authorizes this fixed repository setup capability in an isolated checkout.",
        result: "auto-approved", source: approved === null ? "repo-trust" : "coordinator-policy-review", policyArtifactDigest: current.policyBinding!.artifactDigest,
        policyConfigHash: current.policyBinding!.configHash, runtimeHash: current.policyBinding!.runtimeHash, expiresAt: current.policyBinding!.expiresAt});
      const remaining = current.budget.limitMs - activeWallTimeMs(current.budget.activeIntervals, Date.now());
      if (remaining <= 0) throw new AgentOpsError("RUN_BUDGET_EXHAUSTED", "No active time remains for setup.");
      const child = spawn(process.execPath, [fileURLToPath(new URL("./run-step-entry.js", import.meta.url)),
        fileURLToPath(new URL("./run-setup-entry.js", import.meta.url)), state.commonDir, state.runId, root, String(index), state.policyBinding!.artifactDigest],
        {cwd: root, env: process.env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"]});
      let output = "";
      const completion = new Promise<number | null>((resolve, reject) => {child.once("error", reject); child.once("close", resolve);});
      const kill = () => {if (child.pid !== undefined) try {process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");} catch {}};
      child.stdout.on("data", chunk => {output += chunk.toString(); if (Buffer.byteLength(output) > 2 * 1024 * 1024) kill();});
      child.stderr.resume();
      const deadline = setTimeout(kill, Math.min(remaining, step.timeoutMs ?? 600000) + 3000);
      try {
        const identity = child.pid === undefined ? null : await nativeProcessIdentity(child.pid);
        if (identity === null) throw new AgentOpsError("RUN_PROCESS_IDENTITY_REQUIRED", "Cannot register setup process identity.");
        await repository.mutate(state.runId, saved => {
          if (saved.status !== "active" || saved.disableRestart || saved.proofProcess != null || saved.policyBinding?.artifactDigest !== state.policyBinding!.artifactDigest)
            throw new AgentOpsError("RUN_SETUP_STALE", "Stop or another proof process raced setup registration.");
          return {...saved, proofProcess: {processId: child.pid!, processIdentity: identity}};
        });
        child.stdin.on("error", kill); child.stdin.end("start\n");
        const exitCode = await completion;
        const result = exitCode === 0 ? JSON.parse(output) as {exitCode: number; output: string} :
          {exitCode: exitCode ?? 1, output: "Registered setup interrupted, timed out or failed. " + redactSecrets(output)};
        const artifact = canonicalJson({runId: state.runId, command, resource, policyArtifactDigest: current.policyBinding!.artifactDigest, result});
        const digest = sha256(artifact);
        await writePrivateFile(join(state.commonDir, "agent-ops/runs", state.runId, "setup", digest + ".json"), artifact, state.commonDir);
        await repository.appendEvent(state.runId, {type: "diagnostic", code: result.exitCode === 0 ? "RUN_SETUP_PASSED" : "RUN_SETUP_FAILED", workerId: coordinator.workerId,
          taskId: coordinator.taskId, detail: canonicalJson({digest, capabilityId: "setup:" + index})});
        return {exitCode: result.exitCode, output: redactSecrets(result.output)};
      } catch (cause) {kill(); await completion.catch(() => {}); throw cause;}
      finally {
        clearTimeout(deadline);
        await repository.mutate(state.runId, saved => ({...saved, ...(saved.proofProcess?.processId === child.pid ? {proofProcess: null} : {})}));
      }
    }, trust: {status,
    grant: async (root, config) => {if (await status(root, config) !== "TRUSTED") throw new AgentOpsError("RUN_POLICY_UNTRUSTED", "Cannot grant an unassessed worktree policy.");},
    revoke: async () => {}}};
}

/** Explicit recovery can renew an expired bound journal, including the bind-before-journal crash gap. */
export async function renewPendingRunPolicy(repository: FileRunRepository, runId: string, journal: PolicyTransitionJournal): Promise<PolicyTransitionJournal> {
  if (journal.stages.at(-1)!.stage !== "bound") return journal;
  const now = Date.now(), runtimeHash = await runRuntimeHash();
  let current = (await repository.read(runId))!;
  const expected = journal.newPolicyArtifact!;
  const policy = (await readRunPolicy(current, runtimeHash, now, true))!;
  const bound = (await readRunPolicy({...current, policyBinding: expected}, runtimeHash, now, true))!;
  let digest = current.policyBinding!.artifactDigest, ancestor = policy;
  for (let depth = 0; digest !== expected.artifactDigest && depth < 128; depth++) {
    if (calculateConfigHash(ancestor.config) !== expected.configHash || ancestor.runtimeHash !== expected.runtimeHash ||
        canonicalJson(ancestor.baseTrustBinding) !== canonicalJson(bound.baseTrustBinding) || ancestor.previousDigest === null)
      throw new AgentOpsError("RUN_POLICY_TRANSITION_STALE", "Pending renewal must match the exact immutable bound policy lineage.");
    digest = ancestor.previousDigest;
    const source = await readPrivateFile(join(current.commonDir, "agent-ops/runs", runId, "policies", digest + ".json"), current.commonDir);
    if (source === null || sha256(source) !== digest)
      throw new AgentOpsError("RUN_POLICY_CHANGED", "Historical renewal artifact is missing or changed.");
    const {expiresAt} = JSON.parse(source) as {expiresAt: string};
    ancestor = (await readRunPolicy({...current, policyBinding: {...expected, artifactDigest: digest, expiresAt}}, runtimeHash, now, true))!;
  }
  if (digest !== expected.artifactDigest)
    throw new AgentOpsError("RUN_POLICY_TRANSITION_STALE", "Pending renewal lineage exceeds its recovery bound.");
  if (Date.parse(current.policyBinding!.expiresAt) <= now) {
    const lastResume = Math.max(0, ...current.controls.filter(c => c.action === "resume" && c.actor === "user").map(c => Date.parse(c.requestedAt)));
    if (lastResume < Date.parse(journal.stages.at(-1)!.at))
      throw new AgentOpsError("RUN_POLICY_RECOVERY_REQUIRED", "Expired transition execution requires explicit resume.");
    const previousDigest = current.policyBinding!.artifactDigest;
    current = await bindRunPolicy(repository, runId, {config: policy.config, runtimeHash: policy.runtimeHash,
      baseTrustBinding: policy.baseTrustBinding, expectedDigest: previousDigest, now});
    const fresh = (await readRunPolicy(current, runtimeHash, now))!;
    if (fresh.previousDigest !== previousDigest)
      throw new AgentOpsError("RUN_POLICY_TRANSITION_STALE", "Renewal changed the immutable policy lineage.");
  } else if (current.policyBinding!.artifactDigest === expected.artifactDigest) return journal;
  return await renewBoundPolicyTransition(repository, runId, journal.transitionId, {
    renewedPolicyArtifact: currentPolicyArtifact(current)!, expectedJournalDigest: journal.artifactDigest, now: new Date(now).toISOString()});
}

/** The supervisor's final proof reports its stages into the run it belongs to. */
export async function runPhaseObserver(cwd: string, runId: string, workerId: string): Promise<AdvancePhaseObserver> {
  const {commonDir} = await resolveCheckouts(worktreeDependencies(), cwd);
  const repository = new FileRunRepository(join(commonDir, "agent-ops", "runs"), commonDir);
  return async (phase, progress) => await recordRunPhase(repository, runId, workerId, phase, progress);
}

export const runEntry = fileURLToPath(new URL("./run-entry.js", import.meta.url));
export function runDescriptor(state: RunState) {
  return createLaunchdDescriptor({runId: state.runId, workerId: "supervisor", privateDirectory: join(state.commonDir, "agent-ops", "runs", state.runId),
    command: process.execPath, args: [runEntry, state.root, state.runId], cwd: state.root, pathEnvironment: process.env.PATH});
}
export async function productionRunContext(cwd: string, options: {launchd?: Pick<LaunchdController,
  "supported" | "writeDescriptor" | "bootstrap" | "enableRestart" | "wake" | "disableRestart" | "bootout">} = {}) {
  const deps = worktreeDependencies();
  const checkouts = await resolveCheckouts(deps, cwd);
  const target = await deps.git(checkouts.mainRoot, ["symbolic-ref", "--short", "HEAD"]);
  if (target.exitCode !== 0) throw new AgentOpsError("RUN_TARGET_REQUIRED", "Run requires a checked-out target branch.");
  const directory = join(checkouts.commonDir, "agent-ops", "runs");
  const repository = new FileRunRepository(directory, checkouts.commonDir);
  const service = new RunService(repository);
  const launchd = options.launchd ?? new LaunchdController();
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
      await bindRunPolicy(repository, result.state.runId, {config,
        baseTrustBinding: await repositoryTrustBinding(checkouts.mainRoot, config, CLI_VERSION), runtimeHash: await runRuntimeHash()});
      const workerId = `coordinator-${result.state.runId}`;
      const workerRoot = join(checkouts.mainRoot, ".worktrees", sessionWorktreeName(ownerSessionId));
      const now = new Date().toISOString();
      const state = await repository.mutate(result.state.runId, current => ({...current, phase: "planning",
        currentContractHash: current.goalHash,
        tasks: [{taskId: "planning-" + current.runId, dependencies: [], status: "ready", workerId,
          deliveryDigest: null, sourceCommit: null, blockedReason: null}],
        workers: [{workerId, taskId: "planning-" + current.runId, host: current.host, ownerSessionId,
          nativeSessionId: null, nativeJobId: null, worktree: workerRoot, processId: null, processIdentity: null,
          generation: 1, status: "assigned", leaseExpiresAt: null, heartbeatAt: null, stopIntent: null,
          nativeGoalState: "inactive", lastFailure: null, phase: "planning"}],
        budget: {...current.budget, activeIntervals: [{startMs: Date.parse(current.createdAt), endMs: null}], lastObservedAt: now}}));
      await mkdir(runDescriptor(state).privateDirectory, {recursive: true});
      await launchd.writeDescriptor(runDescriptor(state));
      await launchd.bootstrap(runDescriptor(state));
      return {state, message: `Run ${state.runId} started; background setup and native goal use ${workerRoot}.`};
    } catch (cause) {
      await repository.mutate(result.state.runId, current => ({...current, status: "failed", disableRestart: true}));
      throw cause;
    }
  };
  const resume: RunCommandService["resume"] = async runId => {
    const before = await service.status(runId);
    const runtimeHash = await runRuntimeHash();
    const policy = await readRunPolicy(before, before.policyBinding?.runtimeHash ?? runtimeHash, Date.now(), true);
    if (policy !== null && await deps.trust.status(checkouts.mainRoot, policy.baseConfig) !== "TRUSTED")
      throw new AgentOpsError("RUN_REPO_UNTRUSTED", "Resume requires the original repository trust binding to remain valid.");
    const pending = await discoverPendingPolicyTransition(repository, runId);
    if (pending !== null && runtimeHash !== before.policyBinding?.runtimeHash)
      throw new AgentOpsError("RUN_POLICY_RECOVERY_REQUIRED", "Recover the pending policy transition with its original executable runtime before upgrading it.");
    const version = before.integration !== null ? before.nativeInstance : (await promisify(execFile)(before.host, ["--version"], {timeout: 5000, maxBuffer: 8192})).stdout.trim();
    const transport = new NativeRunTransport(before.host === "codex" ? new CodexGoalHost() : new ClaudeGoalHost(), repository);
    const supervisor = new RunSupervisor({repository, host: transport});
    for (const worker of before.workers) await supervisor.stopWorker(runId, worker.workerId, worker.generation, "stop");
    if (before.proofProcess != null) {
      await transport.stop({nativeSessionId: "run-proof", nativeJobId: null, ...before.proofProcess, instance: before.nativeInstance, generation: 1, reason: "explicit resume reconciliation"});
      await repository.mutate(runId, s => ({...s, proofProcess: null}));
    }
    if (before.integration === null) for (const worker of before.workers.filter(w => w.worktree !== null)) {
      const exists = await stat(worker.worktree!).catch((cause: NodeJS.ErrnoException) => {if (cause.code === "ENOENT") return null; throw cause;});
      if (exists === null && before.rootTaskId === null && worker.workerId === before.coordinatorId) continue;
      if (exists === null || (await collectChangeSurface(gitRunner(worker.worktree!))).paths.length > 0)
        throw new AgentOpsError("RUN_RECOVERY_DIRTY", "Commit or preserve every writer checkout before explicit resume.");
    }
    const result = await service.resume(runId);
    try {
    if (pending !== null) await renewPendingRunPolicy(repository, runId, pending);
    if (policy !== null && pending === null) await bindRunPolicy(repository, runId, {config: policy.config, runtimeHash, resumeRuntime: true,
      baseTrustBinding: policy.baseTrustBinding, expectedDigest: before.policyBinding!.artifactDigest});
    const login = await readGuiLoginIdentity();
    const state = await repository.mutate(runId, current => ({...current,
      bootIdentity: awaitBoot, loginDomain: login, nativeInstance: version}));
    await launchd.enableRestart(runDescriptor(state)); await launchd.wake(runDescriptor(state));
    return {...result, state};
    } catch (cause) {
      await repository.mutate(runId, current => ({...current, status: "paused", awaitingResume: true, disableRestart: true}));
      throw new AgentOpsError("RUN_SUPERVISOR_RESUME_FAILED", "Supervisor could not be resumed; inspect run status and launchd diagnostics.", {cause});
    }
  };
  const awaitBoot = await readBootIdentity();
  const stop: RunCommandService["stop"] = async (runId, reason) => {
    const result = await service.stop(runId, reason);
    // Disable native/background continuation before asking the active supervisor to stop writers.
    let disableError: unknown;
    try {await launchd.disableRestart(runDescriptor(result.state), reason ?? "user requested stop");}
    catch (cause) {disableError = cause;}
    // The control command also reconciles saved process identities: a crashed
    // supervisor must not leave an owned native group alive after user Stop.
    const transport = new NativeRunTransport(result.state.host === "codex" ? new CodexGoalHost() : new ClaudeGoalHost(), repository);
    const supervisor = new RunSupervisor({repository, host: transport});
    for (const worker of result.state.workers) {
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
    try {await launchd.bootout(runDescriptor(result.state));}
    catch (cause) {disableError ??= cause;}
    const state = await repository.mutate(runId, current => ({...current, status: "paused", budget: {...current.budget,
      accumulatedMs: activeWallTimeMs(current.budget.activeIntervals, Date.now()), lastObservedAt: new Date().toISOString(),
      activeIntervals: current.budget.activeIntervals.map(interval => ({...interval, endMs: interval.endMs ?? Date.now()}))}}));
    if (disableError !== undefined) {
      await repository.appendEvent(runId, {type: "diagnostic", code: "RUN_SUPERVISOR_DISABLE_FAILED", workerId: null, taskId: null,
        detail: "Registered process death was confirmed; launchd disable failed. Ledger restart intent remains disabled."});
      throw new AgentOpsError("RUN_SUPERVISOR_DISABLE_FAILED", "Owned executors stopped, but launchd disable failed; inspect background diagnostics.", {cause: disableError});
    }
    return {state, message: `Run ${runId} stopped; registered native process death was confirmed.`};
  };
  const respond: RunCommandService["respond"] = async (runId, questionId, answer) => {
    const state = await service.status(runId);
    if (!state.questions.some(q => q.questionId === questionId && q.answeredAt === null))
      throw new AgentOpsError("RUN_QUESTION_NOT_FOUND", "An unanswered question is required.");
    await writePrivateFile(join(state.commonDir, "agent-ops", "runs", state.runId, "answers", sha256(questionId) + ".json"),
      JSON.stringify({questionId, answer: answer.trim()}), state.commonDir);
    const result = await service.respond(runId, questionId, answer);
    try {
      const resumed = await resume(runId);
      return {...result, state: resumed.state};
    } catch (cause) {
      await repository.mutate(runId, saved => ({...saved, status: "paused", awaitingResume: true, disableRestart: true}));
      throw cause;
    }
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
