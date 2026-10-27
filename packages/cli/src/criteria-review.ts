import {homedir} from "node:os";
import {join} from "node:path";
import {AgentOpsError} from "../../../runtime/src/fs/paths.js";
import type {AgentTask} from "../../../runtime/src/contracts.js";
import {runCriteriaReview, readCriteriaReview, renderCriteriaReview, revisionReviewDue, type CriteriaReviewTrigger, type CriteriaReviewView} from "../../../runtime/src/review/criteria.js";
import {registeredRunProofRunner} from "../../../runtime/src/verify/spawn.js";
import {appendLocalLog} from "../../../runtime/src/logging/local-log.js";
import {localStatePaths} from "../../../runtime/src/security/permissions.js";
import {TaskService} from "../../../runtime/src/task/service.js";
import {FileTaskStore} from "../../../runtime/src/task/store.js";
import {loadEffectiveConfig, runPolicyContext} from "./context.js";

async function parentScope(root: string, task: AgentTask): Promise<AgentTask | undefined> {
  const read = async (path: string, id: string): Promise<AgentTask> =>
    (await new TaskService(new FileTaskStore(join(path, ".agent-ops/tasks/state.json"), path)).status({taskId: id})).task;
  if (task.parentTaskId !== undefined) return await read(root, task.parentTaskId);
  if (task.surface !== undefined && "covers" in task.surface) {
    const run = await runPolicyContext(root);
    const coordinator = run?.state.workers.find(worker => worker.workerId === run.state.coordinatorId);
    if (run?.state.rootTaskId != null && coordinator?.worktree != null) return await read(coordinator.worktree, run.state.rootTaskId);
  }
  return undefined;
}
export async function criteriaReviewStatus(root: string, task: AgentTask): Promise<CriteriaReviewView | null> {
  return await readCriteriaReview(root, task, await parentScope(root, task).catch(() => undefined));
}

/** Only production creation/explicit review installs this hook; TaskService stays model-free. */
export async function reviewCreatedCriteria(root: string, task: AgentTask, rerun = false, trigger?: CriteriaReviewTrigger): Promise<CriteriaReviewView> {
  const controller = new AbortController();
  const interrupt = (signal: "SIGINT" | "SIGTERM"): void => {controller.abort(signal);};
  const int = (): void => interrupt("SIGINT"), term = (): void => interrupt("SIGTERM");
  process.once("SIGINT", int); process.once("SIGTERM", term);
  try {
    const config = await loadEffectiveConfig(root, "project").catch(() => undefined);
    const role = config?.config.reviewRoles?.find(role => role.role === "independent-review");
    const host = process.env.AGENT_OPS_HOST;
    const target = role?.targets.find(target => target !== host) ?? role?.targets[0];
    const parent = await parentScope(root, task).catch(() => undefined);
    process.stderr.write(`Criteria advisory for ${task.id}: waiting for one independent reviewer (no time budget; Ctrl-C cancels).\n`);
    let result = await runCriteriaReview({root, task, parent, target, model: role?.model, effort: role?.effort,
      rerun, ...(trigger === undefined ? {} : {trigger}), signal: controller.signal, runner: registeredRunProofRunner(),
      unavailableCode: config === undefined ? "CRITERIA_REVIEW_CONFIG_UNAVAILABLE" : target === undefined && role !== undefined ? "CRITERIA_REVIEW_NO_INDEPENDENT_TARGET" : "CRITERIA_REVIEW_UNCONFIGURED",
      log: async (report, path) => {
        const state = localStatePaths(process.env.AGENT_OPS_HOME ?? homedir());
        await appendLocalLog(join(state.logDirectory, "events.ndjson"), {type: "criteria-review", taskId: task.id,
          attemptId: report.attemptId, status: report.status, code: report.code, durationMs: report.durationMs,
          invocations: report.invocations, recommendations: report.advice?.recommendations.length ?? 0,
          report: path, usage: {...report.usage}}, {anchorDirectory: state.anchorDirectory});
      }});
    const latest = await new TaskService(new FileTaskStore(join(root, ".agent-ops/tasks/state.json"), root)).status({taskId: task.id}).catch(() => undefined);
    const currentView = latest === undefined ? null : await criteriaReviewStatus(root, latest.task);
    if (currentView?.report.attemptId === result.report.attemptId) result = {...result, stale: currentView.stale};
    if (controller.signal.aborted) throw new AgentOpsError("CRITERIA_REVIEW_CANCELLED", "Criteria review cancelled; stop before implementation.");
    process.stderr.write(renderCriteriaReview(result) + "\n");
    return result;
  } finally {process.removeListener("SIGINT", int); process.removeListener("SIGTERM", term);}
}

/** A revise that changed what the advice judged reruns it once; otherwise it reports the current advisory. */
export async function reviewRevisedCriteria(root: string, task: AgentTask): Promise<CriteriaReviewView | null> {
  const view = await criteriaReviewStatus(root, task);
  return revisionReviewDue(view) ? await reviewCreatedCriteria(root, task, true, "revise") : view;
}
