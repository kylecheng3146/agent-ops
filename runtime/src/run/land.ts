import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";

import type { AcceptanceCriterion } from "../contracts.js";
import { calculateConfigHash } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import type { FinishDependencies } from "../parallel/finish.js";
import { listWorktrees } from "../parallel/manage.js";
import {
  addWorktree, readWorktreeRecord, removeCheckout, sessionWorktreeName, type WorktreeRecord
} from "../parallel/service.js";
import { readPrivateFile, writePrivateFile } from "../security/permissions.js";
import { landingMarkerLive, MAX_EVENTS, type RunRepository, type RunState, type RunTaskNode } from "./service.js";

const LIVE_WORKER = ["assigned", "starting", "running", "idle", "handing-off"];
const LANDABLE = ["paused", "blocked", "budget-limited"];
/** Inside the landing worktree; names the run that owns it so another run never reuses it. */
const OWNER_FILE = join(".agent-ops", "tasks", "run-landing.json");

export function assertLandable(state: RunState): void {
  if (!LANDABLE.includes(state.status) || state.rootTaskId === null ||
      state.workers.some(worker => LIVE_WORKER.includes(worker.status)))
    throw new AgentOpsError("RUN_LAND_STATE_INVALID",
      `Run ${state.runId} is ${state.status}; land needs a paused, blocked or budget-limited run with a root task and no live worker.`);
}

/** Unlanded delivered children, or the requested ones; every dependency must be selected or already landed. */
export function selectLanding(state: RunState, requested?: readonly string[]): readonly RunTaskNode[] {
  const landed = new Set((state.landings ?? []).flatMap(landing => landing.taskIds));
  const eligible = state.tasks.filter(task => task.taskId !== state.rootTaskId && task.status === "delivered" &&
    task.sourceCommit !== null && !landed.has(task.taskId));
  for (const id of requested ?? [])
    if (!eligible.some(task => task.taskId === id))
      throw new AgentOpsError("RUN_LAND_TASK_INVALID", `${id} is not an unlanded delivered task of run ${state.runId}.`);
  const selected = requested === undefined ? eligible : eligible.filter(task => requested.includes(task.taskId));
  if (selected.length === 0) throw new AgentOpsError("RUN_LAND_NOTHING", `Run ${state.runId} has no unlanded delivered task.`);
  const ids = new Set(selected.map(task => task.taskId));
  for (const task of selected)
    for (const dependency of task.dependencies)
      if (!ids.has(dependency) && !landed.has(dependency))
        throw new AgentOpsError("RUN_LAND_DEPENDENCY_OPEN", `${task.taskId} depends on ${dependency}, which is neither selected nor landed.`);
  return selected;
}

/**
 * One landing session per attempt: a non-hex first letter keeps it apart from
 * UUID sessions, and a fresh path per attempt never reuses a removed checkout.
 */
export function landingSessionId(runId: string, nonce: string = randomUUID()): string {
  return `l${sha256(`${runId}:${nonce}`).slice(0, 7)}${LANDING_SUFFIX}${runId}`;
}
const LANDING_SUFFIX = "-land-";

export interface LandAdvanceInput {
  readonly cwd: string;
  readonly sessionId: string;
  readonly parentTaskId: string;
  readonly children: readonly WorktreeRecord[];
}

export interface LandRunOptions {
  readonly repository: RunRepository;
  readonly runId: string;
  readonly taskIds?: readonly string[];
  readonly deps: FinishDependencies;
  /** Verify every task, run the two-round tree review and finish with the children kept. */
  readonly advance: (input: LandAdvanceInput) => Promise<{ readonly receipt: string }>;
  readonly now?: () => string;
}

export interface LandRunResult {
  readonly state: RunState;
  readonly taskIds: readonly string[];
  readonly receipt: string;
}

async function git(deps: FinishDependencies, cwd: string, args: readonly string[]): Promise<string> {
  const result = await deps.git(cwd, args);
  if (result.exitCode !== 0) throw new AgentOpsError("RUN_LAND_GIT_FAILED", `${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** The worker checkout whose committed head is the frozen delivery. */
async function deliveredCheckout(deps: FinishDependencies, state: RunState, task: RunTaskNode): Promise<WorktreeRecord> {
  for (const worker of state.workers.filter(worker => worker.taskId === task.taskId && worker.worktree !== null)) {
    const record = await readWorktreeRecord(worker.worktree!);
    if (record !== null && await git(deps, record.path, ["rev-parse", "HEAD"]) === task.sourceCommit) return record;
  }
  throw new AgentOpsError("RUN_LAND_DELIVERY_MISSING", `No preserved checkout of ${task.taskId} is at its delivered commit ${task.sourceCommit}.`);
}

async function ownerOf(path: string): Promise<string | null> {
  try {
    const owner = JSON.parse(await readPrivateFile(join(path, OWNER_FILE), path) ?? "null") as {runId?: unknown} | null;
    return typeof owner?.runId === "string" ? owner.runId : null;
  } catch {
    return null;
  }
}

/** Worktrees kept by this run's failed attempts are removed first; one that claims the run without proof is refused. */
async function freshLandingWorktree(deps: FinishDependencies, state: RunState, sessionId: string): Promise<WorktreeRecord> {
  const claimed = (await listWorktrees(deps, state.root)).map(({record}) => record)
    .filter(record => record.sessionId.endsWith(LANDING_SUFFIX + state.runId));
  for (const record of claimed)
    if (await ownerOf(record.path) !== state.runId)
      throw new AgentOpsError("RUN_LAND_WORKTREE_FOREIGN", `${record.path} claims run ${state.runId} without its owner record; it was left untouched.`);
  for (const record of claimed) await removeCheckout(deps, record, true);
  const record = (await addWorktree(deps, {cwd: state.root, name: sessionWorktreeName(sessionId), sessionId,
    from: state.targetBranch, targetBranch: state.targetBranch})).record;
  await writePrivateFile(join(record.path, OWNER_FILE), JSON.stringify({runId: state.runId}), record.path);
  return record;
}

async function createLandingRoot(deps: FinishDependencies, state: RunState, record: WorktreeRecord,
  selected: readonly RunTaskNode[]): Promise<string> {
  const config = await deps.loadConfig(record.path);
  const required = config.verification.commands.filter(command => command.required).map(command => command.id);
  if (required.length === 0) throw new AgentOpsError("RUN_LAND_VERIFIER_REQUIRED", "Landing proof needs at least one required verification command.");
  const coordinator = state.workers.find(worker => worker.workerId === state.coordinatorId)?.worktree ?? null;
  const root = coordinator === null ? null : await deps.tasks(coordinator).status({taskId: state.rootTaskId!}).catch(() => null);
  const ids = selected.map(task => task.taskId);
  const base = await git(deps, record.path, ["rev-parse", "HEAD"]);
  const criteria: AcceptanceCriterion[] = [
    {id: "landed-verifiers", description: "Every required project verifier passes on the integrated candidate of the landed tasks.", verifierIds: required},
    {id: "landed-coherent", verifierIds: [],
      description: "The landed subset is coherent on its own: it exposes no half-finished behavior and references no work of an undelivered run task.",
      acceptance: {mode: "review-only", baselineCommit: base, bindings: [],
        reviewOnlyReason: "partial-landing coherence: whether a subset stands alone without the undelivered tasks is a reviewer judgment, not a mechanical check"}}
  ];
  // Typed acceptance needs repository context; the target head is the landing baseline.
  const created = await deps.tasks(record.path, base).create({
    title: `Land ${ids.join(", ")} from ${state.runId}`,
    goal: `Land delivered tasks ${ids.join(", ")} of run ${state.runId} ahead of the rest of its goal:\n${state.goal}`.slice(0, 64_000),
    intent: "Merge only the frozen deliveries of the listed run tasks; the run, its root task and its checkouts stay as they are.",
    criteria, createdSourceCommit: base, policyConfigHash: calculateConfigHash(config), sessionId: record.sessionId,
    ...(root?.task.surface === undefined ? {} : {surface: root.task.surface})
  });
  return created.task.id;
}

/**
 * `agent-ops run land`: prove and merge delivered children of a stopped run
 * while the run stays resumable. Landed tasks remain delivered, so a later
 * resume and finalize re-verify the whole goal on the new target.
 */
export async function landRun(options: LandRunOptions): Promise<LandRunResult> {
  const now = options.now ?? (() => new Date().toISOString());
  let selected: readonly RunTaskNode[] = [];
  const held = await options.repository.mutate(options.runId, current => {
    if (landingMarkerLive(current.landing))
      throw new AgentOpsError("RUN_LANDING_IN_PROGRESS", `Run ${current.runId} is already landing delivered work.`);
    assertLandable(current);
    selected = selectLanding(current, options.taskIds);
    return {...current, landing: {processId: process.pid, hostname: hostname(), startedAt: now()}};
  });
  const taskIds = selected.map(task => task.taskId);
  try {
    const children = [];
    for (const task of selected) children.push(await deliveredCheckout(options.deps, held, task));
    const sessionId = landingSessionId(held.runId);
    const record = await freshLandingWorktree(options.deps, held, sessionId);
    const parentTaskId = await createLandingRoot(options.deps, held, record, selected);
    const {receipt} = await options.advance({cwd: held.root, sessionId, parentTaskId, children});
    const target = await git(options.deps, held.root, ["rev-parse", `${held.targetBranch}^{commit}`]);
    const state = await options.repository.mutate(options.runId, current => ({...current, landing: null,
      landings: [...(current.landings ?? []), {taskIds, receipt, target, landedAt: now()}],
      events: [...current.events, {id: randomUUID(), at: now(), type: "integration" as const, code: "RUN_PARTIAL_LANDED",
        workerId: null, taskId: null, detail: `Landed ${taskIds.join(", ")} at ${target}; receipt ${receipt}.`}].slice(-MAX_EVENTS)}));
    return {state, taskIds, receipt};
  } catch (cause) {
    await options.repository.mutate(options.runId, current => ({...current, landing: null})).catch(() => undefined);
    throw cause;
  }
}
