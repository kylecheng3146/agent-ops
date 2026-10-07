import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {AgentOpsError} from "../../../runtime/src/fs/paths.js";
import {nativeProcessIdentity, NativeRunTransport} from "../../../runtime/src/run/transport.js";
import {ClaudeGoalHost} from "../../../runtime/src/run/hosts/claude.js";
import {CodexGoalHost} from "../../../runtime/src/run/hosts/codex.js";
import {activeWallTimeMs} from "../../../runtime/src/run/scheduler.js";
import {runPolicyContext} from "./context.js";

/** Native-issued proof commands use the same dormant group as final evidence. */
export async function runOwnedLocalProof(argv: readonly string[]): Promise<number | null> {
  if (!["verify", "review", "batch"].includes(argv[0] ?? "") || argv.includes("--help") || process.env.AGENT_OPS_RUN_PROOF_PID !== undefined) return null;
  const context = await runPolicyContext(process.cwd());
  if (context === null) return null;
  const {repository, state, worker} = context;
  if (worker === undefined || !["running", "idle"].includes(worker.status) || worker.stopIntent !== null)
    throw new AgentOpsError("RUN_WORKER_STALE", "Local proof requires an active registered writer checkout.");
  if (worker.proofProcess != null) {
    const transport = new NativeRunTransport(state.host === "codex" ? new CodexGoalHost() : new ClaudeGoalHost(), repository);
    const existing = await transport.inspect({nativeSessionId: "worker-proof", nativeJobId: null, ...worker.proofProcess, instance: state.nativeInstance});
    if (existing.processAlive) throw new AgentOpsError("RUN_WORKER_PROOF_ACTIVE", "A registered proof command is already running for this worker.");
  }
  const remaining = state.budget.limitMs - activeWallTimeMs(state.budget.activeIntervals, Date.now());
  if (remaining <= 0) throw new AgentOpsError("RUN_BUDGET_EXHAUSTED", "No active run time remains for local proof.");
  const cli = fileURLToPath(new URL("./bin.js", import.meta.url));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./run-step-entry.js", import.meta.url)), cli, ...argv],
    {cwd: worker.worktree!, env: {...process.env, AGENT_OPS_RUN_ID: state.runId, AGENT_OPS_WORKER_ID: worker.workerId,
      AGENT_OPS_WORKER_GENERATION: String(worker.generation)}, detached: process.platform !== "win32", stdio: ["pipe", "inherit", "inherit"]});
  const completion = new Promise<number>((resolve, reject) => {child.once("error", reject); child.once("close", code => resolve(code ?? 1));});
  const kill = (): void => {if (child.pid !== undefined) try {process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");} catch {}};
  const deadline = setTimeout(kill, remaining);
  try {
    const identity = child.pid === undefined ? null : await nativeProcessIdentity(child.pid);
    if (identity === null) throw new AgentOpsError("RUN_PROCESS_IDENTITY_REQUIRED", "Cannot register an unidentified local proof process.");
    await repository.mutate(state.runId, current => {
      const saved = current.workers.find(w => w.workerId === worker.workerId);
      if (current.status !== "active" || current.disableRestart || current.awaitingResume || saved?.generation !== worker.generation ||
        !["running", "idle"].includes(saved.status) || saved.stopIntent !== null ||
        current.policyBinding?.artifactDigest !== state.policyBinding!.artifactDigest ||
        (saved.proofProcess != null && saved.proofProcess.processId !== worker.proofProcess?.processId))
        throw new AgentOpsError("RUN_WORKER_STALE", "Run stop or another proof command raced registration.");
      return {...current, workers: current.workers.map(w => w.workerId === worker.workerId ? {...w, proofProcess: {processId: child.pid!, processIdentity: identity}} : w)};
    });
    child.stdin.on("error", kill);
    child.stdin.end("start\n");
    return await completion;
  } catch (cause) {kill(); await completion.catch(() => {}); throw cause;}
  finally {
    clearTimeout(deadline);
    await repository.mutate(state.runId, current => ({...current, workers: current.workers.map(w => w.workerId === worker.workerId &&
      w.generation === worker.generation && w.proofProcess?.processId === child.pid ? {...w, proofProcess: null} : w)}));
  }
}
