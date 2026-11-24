import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentOpsConfig } from "../../../../runtime/src/contracts.js";
import { AgentOpsError } from "../../../../runtime/src/fs/paths.js";
import { respondQa, showQa } from "../../../../runtime/src/qa/decisions.js";
import { qaDeliveryError, type QaDeliveryResult } from "../../../../runtime/src/qa/delivery.js";
import { qaCommonDirectory, qaDeliveryTree, qaDeliveryVersion } from "../../../../runtime/src/qa/gate.js";
import { stopQa, type QaProcessProbe } from "../../../../runtime/src/qa/session.js";
import { qaCurrentVersion, qaStatus, renderQaStatus, type QaStatus } from "../../../../runtime/src/qa/status.js";
import { FileQaStore } from "../../../../runtime/src/qa/store.js";
import { FileRunRepository } from "../../../../runtime/src/run/service.js";
import { taskContractHash } from "../../../../runtime/src/task/contract.js";
import { FileTaskStore, type StoredTaskRecord } from "../../../../runtime/src/task/store.js";
import type { ParsedArgs, QaAction } from "../args.js";
import { errorEnvelope, okEnvelope, type CliEnvelope } from "../output.js";
import type { DeliveryQaInput } from "../qa-delivery.js";

const exec = promisify(execFile);

export interface QaCommandOptions {
  readonly args: ParsedArgs;
  readonly root: string;
  /** Production: runDeliveryQa. Only plan and run reach it; show, respond and stop never start a model. */
  readonly deliver: (input: DeliveryQaInput) => Promise<QaDeliveryResult | null>;
  /** Production: TaskService.adoptQa with repository context; makes QA required for an active root task. */
  readonly adopt: (taskId: string, expectedContractHash: string, reason: string) => Promise<StoredTaskRecord>;
  readonly loadConfig: () => Promise<AgentOpsConfig>;
  /** The source fingerprint verify uses; respond binds its decision to it. */
  readonly fingerprint: (base: string | undefined) => Promise<string>;
  /** Set when a registered run process (coordinator or worker) runs this command. */
  readonly inRun: boolean;
  readonly now?: () => string;
  readonly probe?: QaProcessProbe;
}

export interface QaCommandData {
  readonly action: QaAction;
  readonly taskId: string;
  readonly status: QaStatus;
  readonly show?: Awaited<ReturnType<typeof showQa>>;
  readonly result?: QaDeliveryResult;
  readonly text: string;
}

async function head(root: string): Promise<string | null> {
  return await exec("git", ["rev-parse", "HEAD"], {cwd: root}).then(r => r.stdout.trim(), () => null);
}

/** A native run that still owns this delivery: its supervisor is the only QA controller. */
async function owningRun(commonDir: string, taskIds: readonly string[]): Promise<string | null> {
  const runs = await new FileRunRepository(join(commonDir, "agent-ops", "runs"), commonDir).list();
  const owner = runs.find(run => run.status !== "complete" && run.status !== "failed" &&
    ((run.rootTaskId !== null && taskIds.includes(run.rootTaskId)) || run.tasks.some(t => taskIds.includes(t.taskId))));
  return owner?.runId ?? null;
}

export async function runQaCommand(options: QaCommandOptions): Promise<CliEnvelope<QaCommandData | null>> {
  const {args, root} = options;
  const action = args.action as QaAction, taskId = args.taskId!;
  const now = options.now ?? (() => new Date().toISOString());
  try {
    const records = (await new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root).read()).tasks;
    const record = records.find(r => r.task.id === taskId);
    if (record === undefined) throw new AgentOpsError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
    const commonDir = await qaCommonDirectory(root);
    const store = new FileQaStore(commonDir);
    // Model-free: the complete delivery version (HEAD, source fingerprint, config, contracts), as the delivery gate checks it.
    const current = {root, loadConfig: options.loadConfig, ...(args.base === undefined ? {} : {base: args.base})};
    const status = await qaStatus(store, records, taskId, current);
    const deliveryId = status.rootTaskId ?? taskId;
    const data = (extra: Partial<QaCommandData> = {}, text = renderQaStatus(status, taskId)): QaCommandData =>
      ({action, taskId, status, ...extra, text});
    if (action === "show") {
      // The current version lets show name which keys moved since the plan/seal; an unreadable checkout just omits that.
      const version = await qaCurrentVersion(records, taskId, current).catch(() => undefined);
      const show = status.rootTaskId === null ? undefined : await showQa(store, status.rootTaskId, version);
      const why = show === undefined ? "" : [
        show.explain.planChanged === null ? null : `\nPlan vs current: ${show.explain.planChanged.length === 0 ? "current" : `changed ${show.explain.planChanged.join(", ")}`}`,
        show.explain.sealChanged === null ? null : `\nSeal vs current: ${show.explain.sealChanged.length === 0 ? "current" : `changed ${show.explain.sealChanged.join(", ")}`}`,
        show.plan === null ? null : `\nPlanner host: ${show.plan.host}${show.plan.fallbackReason === null ? "" : ` (${show.plan.fallbackReason})`}`,
        show.explain.lastFailure === null ? null : `\nLast failure: ${show.explain.lastFailure.source} ${show.explain.lastFailure.reason}` +
          (show.explain.lastFailure.diagnostics === null ? "" : `; diagnostics ${show.explain.lastFailure.diagnostics}`)].filter(l => l !== null).join("");
      return okEnvelope("QA_SHOWN", data(show === undefined ? {} : {show}, renderQaStatus(status, taskId) + (show === undefined ? "" :
        `\nResults: PASS ${show.results.PASS}, FAIL ${show.results.FAIL}, UNKNOWN ${show.results.UNKNOWN}` +
        `\nUsage (host-reported only): input ${show.usage.inputTokens}, output ${show.usage.outputTokens}, total ${show.usage.totalTokens}, cost ${show.usage.costUsd}` +
        why + show.questions.filter(q => !q.answered).map(q => `\n? ${q.id}${q.required ? " (required)" : ""}: ${q.prompt}`).join(""))));
    }
    const runId = await owningRun(commonDir, [taskId, deliveryId]);
    if (action === "respond") {
      // Run agents relay questions with action=question; only a person types this command.
      if (options.inRun) throw new AgentOpsError("QA_ANSWER_NOT_HUMAN",
        "A run agent cannot answer QA questions; relay the question so a human runs agent-ops qa respond.");
      if (status.rootTaskId === null) throw new AgentOpsError("QA_NOT_ENROLLED", `${taskId} is not enrolled; QA has no questions for it.`);
      const tasks = qaDeliveryTree(records, deliveryId).map(r => r.task);
      const version = qaDeliveryVersion({tasks, config: await options.loadConfig(), candidateCommit: (await head(root)) ?? "",
        sourceFingerprint: await options.fingerprint(undefined)});
      const control = await respondQa({store, version, questionId: args.questionId!, answer: args.answer!,
        answeredBy: "human via agent-ops qa respond", now: now()});
      return okEnvelope("QA_ANSWER_RECORDED", data({}, `Recorded the human answer to ${args.questionId}; QA is ${control.state}.` +
        (runId === null ? "" : ` Run ${runId} owns this delivery: resume it with agent-ops run respond or agent-ops run status ${runId}.`)));
    }
    if (runId !== null) throw new AgentOpsError("QA_NATIVE_OWNED", `Run ${runId} owns QA for ${deliveryId}; its supervisor plans, runs and ` +
      `stops it. Use agent-ops run status ${runId} or agent-ops run stop ${runId}; never start a competing QA controller.`);
    if (action === "stop") {
      if (status.rootTaskId === null) throw new AgentOpsError("QA_NOT_ENROLLED", `${taskId} is not enrolled; there is no QA to stop.`);
      const control = await stopQa(store, deliveryId, now(), options.probe);
      return okEnvelope("QA_STOPPED", data({}, `QA for ${deliveryId} is ${control.state}; continuation stays off until an explicit qa plan or qa run. ` +
        "The isolated checkout is kept for diagnosis."));
    }
    let delivery = qaDeliveryTree(records, deliveryId)[0] ?? record;
    if (delivery.status !== "active") throw new AgentOpsError("QA_TASK_NOT_ACTIVE",
      `${deliveryId} is ${delivery.status}; finished deliveries are never re-judged by QA.`);
    if (status.rootTaskId === null) {
      if (action === "run") throw new AgentOpsError("QA_NOT_ENROLLED",
        `${taskId} is not enrolled, so QA is not required; adopt it first with agent-ops qa plan --task ${taskId} --yes.`);
      if (record.task.parentTaskId !== undefined) throw new AgentOpsError("QA_DELIVERY_ROOT_REQUIRED",
        "Subtasks keep local verification; adopt QA on their integrated delivery root.");
      delivery = await options.adopt(taskId, taskContractHash(record.task),
        "Explicit agent-ops qa plan adoption: independent QA becomes a required delivery gate for this task.");
    }
    const result = await options.deliver({root, taskId: deliveryId, explicit: true,
      ...(action === "plan" ? {planOnly: true, timing: delivery.task.qa?.late === true || await head(root) !== delivery.createdSourceCommit ? "late" as const : "early" as const,
        ...(args.replan === true ? {replan: {reason: args.reason!}} : {})}
        : args.base === undefined ? {} : {base: args.base})});
    if (result === null) throw new AgentOpsError("QA_NOT_ENROLLED", `${deliveryId} is not enrolled; QA is not required.`);
    const after = await qaStatus(store, (await new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root).read()).tasks, taskId, current);
    const text = `${renderQaStatus(after, taskId)}\nQA sessions started: ${result.sessions}.` +
      (action !== "plan" ? "" : args.replan === true ? `\nReplan reason: ${args.reason}` : result.sessions === 0 ? "\nThe current QA plan was reused; replace it with --replan --reason <text>." : "");
    if (action === "run" && result.state !== "passed") {
      const error = qaDeliveryError(result);
      return {code: error.code, status: "error", data: {action, taskId, status: after, result, text}, errors: [{code: error.code, message: error.message}]};
    }
    return okEnvelope(action === "plan" ? "QA_PLANNED" : "QA_PASSED", {action, taskId, status: after, result, text});
  } catch (error) {
    if (error instanceof AgentOpsError) return errorEnvelope(error.code, error.message);
    throw error;
  }
}
