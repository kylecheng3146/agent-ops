import { readFile } from "node:fs/promises";

import { AgentOpsError, resolveContainedPath } from "../../../../runtime/src/fs/paths.js";
import {
  type RunHost,
  type RunLifecycleResult,
  type RunService,
  type RunState
} from "../../../../runtime/src/run/service.js";
import type { ParsedArgs } from "../args.js";
import { errorEnvelope, okEnvelope, type CliEnvelope } from "../output.js";

export type RunAction = "start" | "status" | "logs" | "resume" | "stop" | "respond";

/** ParsedArgs is extended by the root CLI wiring; keeping this view local lets
 * the command module remain usable while the parser/entrypoint is migrated. */
export interface RunParsedArgs extends ParsedArgs {
  readonly runAction?: RunAction;
  readonly goal?: string;
  readonly goalFile?: string;
  readonly runId?: string;
  readonly host?: RunHost;
  readonly timeBudgetMs?: number;
  readonly jobs?: number;
  readonly questionId?: string;
  readonly answer?: string;
  readonly answerFile?: string;
  readonly wait?: boolean;
}

export interface RunCommandService {
  readonly start: RunService["start"];
  readonly status: RunService["status"];
  readonly logs: RunService["logs"];
  readonly resume: RunService["resume"];
  readonly stop: RunService["stop"];
  readonly respond: RunService["respond"];
}

export interface RunCommandOptions {
  readonly args: RunParsedArgs;
  readonly service: RunCommandService;
  readonly root: string;
  readonly commonDir: string;
  readonly targetBranch: string;
  readonly ownerSessionId: string;
  readonly waitForCompletion?: (runId: string) => Promise<RunState>;
}

export interface RunCommandData {
  readonly action: RunAction;
  readonly runId: string;
  readonly state: RunState;
  readonly message: string;
  readonly text: string;
}

function dynamic(args: RunParsedArgs): Record<string, unknown> {
  return args as unknown as Record<string, unknown>;
}

function actionOf(args: RunParsedArgs): RunAction {
  const value = dynamic(args).runAction ?? dynamic(args).action;
  if (value === undefined || value === "start") return "start";
  if (["status", "logs", "resume", "stop", "respond"].includes(String(value))) return value as RunAction;
  throw new AgentOpsError("RUN_ACTION_INVALID", `Unsupported run action: ${String(value)}`);
}

function runIdOf(args: RunParsedArgs): string {
  const runId = args.runId ?? dynamic(args).taskId;
  if (typeof runId !== "string" || runId.length === 0) throw new AgentOpsError("RUN_ID_REQUIRED", "This run action requires a run id.");
  return runId;
}

function textFor(action: RunAction, state: RunState, message: string): string {
  const active = state.workers.filter((worker) => ["assigned", "starting", "running", "idle", "handing-off"].includes(worker.status)).length;
  return [
    message,
    `Status: ${state.status}`,
    `Host: ${state.host}`,
    `Workers: ${active}/${state.jobs}`,
    `Budget: ${Math.max(0, state.budget.limitMs - state.budget.accumulatedMs)}ms remaining`,
    action === "logs" ? "" : "Native goal completion is not final proof; verify, review, task state, and receipt are still required."
  ].filter((line) => line.length > 0).join("\n");
}

function data(action: RunAction, result: RunLifecycleResult): RunCommandData {
  return {
    action,
    runId: result.state.runId,
    state: result.state,
    message: result.message,
    text: textFor(action, result.state, result.message)
  };
}

function stateData(action: RunAction, state: RunState, message: string): RunCommandData {
  return { action, runId: state.runId, state, message, text: textFor(action, state, message) };
}

async function goalFromArgs(args: RunParsedArgs, root: string): Promise<string> {
  if (args.goal !== undefined && args.goalFile !== undefined) throw new AgentOpsError("RUN_GOAL_CONFLICT", "Use either a positional goal or --goal-file, not both.");
  if (args.goalFile !== undefined) {
    const path = await resolveContainedPath(root, args.goalFile);
    return (await readFile(path, "utf8")).trim();
  }
  if (args.goal === undefined || args.goal.trim() === "") throw new AgentOpsError("RUN_GOAL_REQUIRED", "Run start requires a non-empty goal.");
  return args.goal.trim();
}

async function answerFromArgs(args: RunParsedArgs, root: string): Promise<string> {
  if (args.answer !== undefined && args.answerFile !== undefined) throw new AgentOpsError("RUN_ANSWER_CONFLICT", "Use either --answer or --answer-file, not both.");
  if (args.answerFile !== undefined) return (await readFile(await resolveContainedPath(root, args.answerFile), "utf8")).trim();
  if (args.answer === undefined || args.answer.trim() === "") throw new AgentOpsError("RUN_ANSWER_REQUIRED", "Run respond requires a non-empty answer.");
  return args.answer.trim();
}

/**
 * External lifecycle surface. The command only starts/controls a supervisor;
 * it never marks the task complete or treats a native process exit as proof.
 */
export async function runRunCommand(options: RunCommandOptions): Promise<CliEnvelope<RunCommandData>> {
  const action = actionOf(options.args);
  try {
    if (action === "start") {
      const result = await options.service.start({
        root: options.root,
        commonDir: options.commonDir,
        targetBranch: options.targetBranch,
        goal: await goalFromArgs(options.args, options.root),
        host: options.args.host ?? "codex",
        ownerSessionId: options.ownerSessionId,
        jobs: options.args.jobs,
        timeBudgetMs: options.args.timeBudgetMs
      });
      const state = options.args.wait === true && options.waitForCompletion !== undefined
        ? await options.waitForCompletion(result.state.runId)
        : result.state;
      const response = data(action, { ...result, state });
      return okEnvelope(options.args.wait === true ? "RUN_FINISHED" : "RUN_STARTED", response);
    }
    const runId = runIdOf(options.args);
    if (action === "status") return okEnvelope("RUN_STATUS", stateData(action, await options.service.status(runId), `Read run ${runId}.`));
    if (action === "logs") {
      const state = await options.service.status(runId);
      const events = await options.service.logs(runId);
      return okEnvelope("RUN_LOGS", { ...stateData(action, state, `Read ${events.length} event(s) for run ${runId}.`), events });
    }
    if (action === "resume") return okEnvelope("RUN_RESUMED", data(action, await options.service.resume(runId)));
    if (action === "stop") return okEnvelope("RUN_STOP_REQUESTED", data(action, await options.service.stop(runId, options.args.answer ?? "user requested stop")));
    const questionId = options.args.questionId;
    if (questionId === undefined || questionId.trim() === "") throw new AgentOpsError("RUN_QUESTION_REQUIRED", "Run respond requires --question-id.");
    return okEnvelope("RUN_RESPONDED", data(action, await options.service.respond(runId, questionId, await answerFromArgs(options.args, options.root))));
  } catch (cause) {
    if (cause instanceof AgentOpsError) return errorEnvelope(cause.code, cause.message) as unknown as CliEnvelope<RunCommandData>;
    throw cause;
  }
}
