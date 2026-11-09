import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {calculateConfigHash} from "../../../runtime/src/config/hash.js";
import {AgentOpsError} from "../../../runtime/src/fs/paths.js";
import {LearningAutomation, type LearningJob, type LearningOwner} from "../../../runtime/src/learning/automation.js";
import {digest} from "../../../runtime/src/learning/data.js";
import {EVALUATOR} from "../../../runtime/src/learning/experiment.js";
import {nativeProcessIdentity} from "../../../runtime/src/run/transport.js";
import {nativeProcessGroupAlive} from "../../../runtime/src/run/hosts/util.js";
import {followupRepositoryContext} from "./followup-deps.js";
import {worktreeDependencies} from "./parallel-deps.js";

export async function learningOwner(): Promise<LearningOwner> {
  const identity = await nativeProcessIdentity(process.pid);
  if (identity === null) throw new AgentOpsError("LEARNING_OWNER_UNAVAILABLE", "Cannot identify the automatic learning process; no provider call permitted.");
  return {pid: process.pid, identity, group: false};
}
export async function learningOwnerAlive(owner: LearningOwner): Promise<boolean> {
  const identity = await nativeProcessIdentity(owner.pid);
  if (identity === owner.identity) return true;
  // A dead leader may leave a slow provider in its owned process group. Never start a second trial over it.
  if (owner.group && process.platform !== "win32" && nativeProcessGroupAlive(owner.pid)) return true;
  try {process.kill(owner.pid, 0); return identity === null;} catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
export async function productionLearningAutomation(cwd: string, ownedGroup = false): Promise<LearningAutomation> {
  const context = await followupRepositoryContext(cwd), deps = worktreeDependencies();
  let controller: LearningAutomation;
  const launch = async (job: LearningJob): Promise<void> => {
    if (process.platform === "win32") throw new Error("BACKGROUND_UNSUPPORTED");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./learning-entry.js", import.meta.url)),
        context.mainRoot, job.id, job.token], {cwd: context.mainRoot, env: process.env,
        detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true});
      child.once("error", reject);
      child.once("spawn", () => {
        void (async () => {
          const identity = child.pid === undefined ? null : await nativeProcessIdentity(child.pid);
          if (identity === null || child.pid === undefined) throw new Error("OWNER_UNAVAILABLE");
          await controller.bind(job.id, job.token, {pid: child.pid, identity, group: true});
          await new Promise<void>((sent, failed) => child.send("start", error => error ? failed(error) : sent()));
          child.disconnect(); child.unref(); resolve();
        })().catch(error => {child.kill(); reject(error);});
      });
    });
  };
  controller = new LearningAutomation({...context, owner: async () => ({...await learningOwner(), group: ownedGroup}), alive: learningOwnerAlive, launch,
    authority: async config => {
      const trusted = await deps.trust.status(context.mainRoot, config) === "TRUSTED";
      return {allowed: trusted && process.platform !== "win32", reason: trusted ? "BACKGROUND_UNSUPPORTED" : "LEARNING_UNTRUSTED",
        fingerprint: digest({config: calculateConfigHash(config), evaluator: EVALUATOR, root: context.mainRoot, commonDir: context.commonDir})};
    }});
  return controller;
}
/** Advisory scheduling is separate from passive receipt/history import. No retries or fallback authority. */
export async function reconcileRepositoryLearning(cwd: string): Promise<string[]> {
  try {await (await productionLearningAutomation(cwd)).reconcile(); return [];}
  catch (error) {
    return error instanceof AgentOpsError && error.code === "WORKTREE_NOT_GIT" ? [] : ["learning: AUTOMATION_UNAVAILABLE; existing baseline retained; inspect learn list."];
  }
}
