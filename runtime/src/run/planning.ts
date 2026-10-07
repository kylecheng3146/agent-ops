import type {AcceptanceCriterion} from "../contracts.js";
import {AgentOpsError} from "../fs/paths.js";
import {validateCriterion} from "../schema/validate.js";
import type {RunState} from "./service.js";

export interface RunWorkerPlan {
  readonly taskId: string;
  readonly title: string;
  readonly intent: string;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly dependencies: readonly string[];
}
const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 4096 && !v.includes("\0");

/** Validate a deferred worker plan without freezing criteria before dependencies are delivered. */
export function workerPlan(value: unknown, taskId: string, state: RunState): RunWorkerPlan {
  if (!plain(value) || Object.keys(value).some(k => !["title", "intent", "criteria", "dependencies"].includes(k)) ||
    !text(value.title) || !text(value.intent) || !Array.isArray(value.criteria) || value.criteria.length < 2 || value.criteria.length > 5 ||
    !Array.isArray(value.dependencies) || value.dependencies.length > 512 || new Set(value.dependencies).size !== value.dependencies.length ||
    value.dependencies.some(id => typeof id !== "string" || id === state.rootTaskId || !state.tasks.some(task => task.taskId === id)))
    throw new AgentOpsError("RUN_WORKER_PLAN_INVALID", "Worker plans require 2–5 criteria and known non-coordinator dependencies.");
  const ids = new Set<string>();
  const criteria = value.criteria.map((criterion, index) => {
    if (!plain(criterion) || criterion.finding !== undefined || (plain(criterion.acceptance) && criterion.acceptance.baselineCommit !== undefined))
      throw new AgentOpsError("RUN_WORKER_BASELINE_DEFERRED", "New worker baselines are captured only after dependencies enter its checkout; finding pins belong to an existing task.");
    const normalized = {...criterion, ...(plain(criterion.acceptance) ? {acceptance: {...criterion.acceptance, baselineCommit: "0".repeat(40)}} : {})};
    const checked = validateCriterion(normalized, `$.criteria[${index}]`);
    if (!checked.ok || ids.has(checked.value.id)) throw new AgentOpsError("RUN_WORKER_PLAN_INVALID", "Worker criteria must be unique valid contracts.");
    ids.add(checked.value.id);
    // TaskService.create resolves the real checkout SHA when this worker starts.
    return structuredClone(criterion) as unknown as AcceptanceCriterion;
  });
  return {taskId, title: value.title, intent: value.intent, criteria, dependencies: [...value.dependencies] as string[]};
}
