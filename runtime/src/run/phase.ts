import type {AcceptanceCriterion} from "../contracts.js";
import type {RunPhase, RunRepository, RunState, RunTaskProgress} from "./service.js";

/** Move one worker, and the run with it, into a phase. Unknown workers leave the state unchanged. */
export function withRunPhase(state: RunState, workerId: string, phase: RunPhase): RunState {
  if (!state.workers.some(w => w.workerId === workerId)) return state;
  return {...state, phase, workers: state.workers.map(w => w.workerId === workerId ? {...w, phase} : w)};
}

/** Merge the latest verify or review observation into one task node. */
export function withTaskProgress(state: RunState, taskId: string, update: Partial<RunTaskProgress>): RunState {
  return {...state, tasks: state.tasks.map(t => t.taskId !== taskId ? t :
    {...t, progress: {verify: null, review: null, passed: 0, total: 0, ...t.progress, ...update}})};
}

/**
 * Passed/total criteria from one verify report: a command-backed criterion
 * passes when every command result passed, a typed one when every replayed
 * acceptance phase for it passed.
 */
export function criteriaProgress(criteria: readonly Pick<AcceptanceCriterion, "id" | "acceptance">[], report: {
  readonly results?: readonly {readonly status: string}[];
  readonly acceptance?: readonly {readonly criterionId: string; readonly status: string}[];
}): {passed: number; total: number} {
  const results = report.results ?? [];
  const commandsPass = results.length > 0 && results.every(r => r.status === "PASS");
  const passed = criteria.filter(c => {
    if (c.acceptance === undefined) return commandsPass;
    const rows = (report.acceptance ?? []).filter(r => r.criterionId === c.id);
    return rows.length > 0 && rows.every(r => r.status === "PASS");
  }).length;
  return {passed, total: criteria.length};
}

/** Phase writes are display data: a failed write must never fail the proof it describes. */
export async function recordRunPhase(repository: RunRepository, runId: string, workerId: string, phase: RunPhase,
  progress?: {taskId: string; update: Partial<RunTaskProgress>}): Promise<void> {
  try {
    await repository.mutate(runId, state => {
      const moved = withRunPhase(state, workerId, phase);
      return progress === undefined ? moved : withTaskProgress(moved, progress.taskId, progress.update);
    });
  } catch { /* ponytail: display-only; the next transition rewrites it */ }
}
