import type {RunPhase, RunState, RunTaskProgress} from "../run/service.js";
import {activeWallTimeMs} from "../run/scheduler.js";
import type {OfficeSessionRecord} from "./sessions.js";

/** `git diff --stat` of one worktree against its base, paths only. */
export interface OfficeDiff {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly paths: readonly string[];
  /** Most recently modified changed path, by file time; never file contents. */
  readonly recent: string | null;
}

export interface OfficeWorktreeInput {
  readonly name: string;
  readonly path: string;
  readonly branch: string;
  readonly sessionId: string;
  readonly runId?: string;
  readonly diff: OfficeDiff;
  readonly phase?: OfficePhase;
  readonly status?: string;
  readonly taskId?: string | null;
  readonly progress?: RunTaskProgress | null;
  readonly completedAt?: string | null;
  readonly host?: string;
}

export interface OfficeReviewSlot {
  readonly slot: number;
  readonly since: string;
  readonly taskId: string | null;
  readonly root: string | null;
}

export interface OfficeInput {
  readonly runs: readonly RunState[];
  readonly worktrees: readonly OfficeWorktreeInput[];
  readonly sessions?: readonly OfficeSessionView[];
  readonly reviews: readonly OfficeReviewSlot[];
  readonly now: number;
}

/** Registry identity plus task/proof state read from its trusted checkout. */
export interface OfficeSessionView extends OfficeSessionRecord {
  readonly taskStatus?: string;
  readonly progress?: RunTaskProgress | null;
}

export type OfficePhase = RunPhase | "unknown";

export interface OfficeAgent {
  readonly id: string;
  readonly role: "coordinator" | "worker";
  readonly status: string;
  readonly phase: OfficePhase;
  readonly taskId: string;
  readonly progress: RunTaskProgress | null;
  readonly worktree: string | null;
  readonly diff: OfficeDiff | null;
  readonly narration: string;
}

export interface OfficeRun {
  readonly runId: string;
  readonly title: string;
  readonly status: string;
  readonly phase: OfficePhase;
  readonly budget: {readonly limitMs: number; readonly usedMs: number; readonly remainingMs: number};
  readonly questions: readonly {readonly questionId: string; readonly prompt: string}[];
  readonly agents: readonly OfficeAgent[];
  readonly reviewers: readonly OfficeReviewSlot[];
  readonly commands: readonly string[];
  readonly completedAt?: string | null;
}

export interface OfficeDesk {
  readonly name: string;
  readonly branch: string;
  readonly sessionId: string;
  readonly diff: OfficeDiff;
  readonly narration: string;
  readonly commands: readonly string[];
  readonly phase?: OfficePhase;
  readonly status?: string;
  readonly taskId?: string | null;
  readonly progress?: RunTaskProgress | null;
  readonly questions?: readonly {readonly questionId: string; readonly prompt: string}[];
  readonly completedAt?: string | null;
  readonly host?: string;
  /** Hook liveness, separate from a task's persistent active status. */
  readonly sessionActive?: boolean;
}

export interface OfficeSnapshot {
  readonly generatedAt: string;
  readonly runs: readonly OfficeRun[];
  readonly lobby: readonly OfficeDesk[];
  readonly reviews: readonly OfficeReviewSlot[];
}

const COMPLETED_RETENTION_MS = 2 * 60 * 60 * 1000;
const LIVE = new Set(["assigned", "starting", "running", "idle", "handing-off", "fenced", "delivered", "blocked"]);
const PHASES = new Set<OfficePhase>(["planning", "implementing", "verifying", "reviewing", "integrating", "unknown"]);

function phaseOf(value: string | undefined): OfficePhase {
  return value !== undefined && PHASES.has(value as OfficePhase) ? value as OfficePhase : "unknown";
}

/** Decision 8: narration comes from changed paths only. */
export function narrate(diff: OfficeDiff | null): string | null {
  const path = diff?.recent ?? diff?.paths[0] ?? null;
  if (path === null) return null;
  if (path.startsWith("docs/")) return "writing docs";
  if (path.startsWith("tests/")) return "writing tests";
  return "editing " + path;
}

function quote(text: string): string {
  return "'" + text.replaceAll("'", "'\\''") + "'";
}

/** Pure aggregation of runs, worktrees and review slots into one building. */
export function buildOfficeSnapshot(input: OfficeInput): OfficeSnapshot {
  const byPath = new Map(input.worktrees.map(w => [w.path, w]));
  const claimed = new Set<OfficeReviewSlot>();
  const runs = input.runs.filter(run => !["complete", "failed"].includes(run.status) || input.now - Date.parse(run.updatedAt) < COMPLETED_RETENTION_MS)
    .map((run): OfficeRun => {
    const roots = new Set(run.workers.map(w => w.worktree).filter((p): p is string => p !== null));
    const reviewers = input.reviews.filter(r => r.root !== null && roots.has(r.root)).slice(0, 2);
    reviewers.forEach(r => claimed.add(r));
    const usedMs = activeWallTimeMs(run.budget.activeIntervals, input.now);
    const agents = run.workers.filter(w => w.workerId === run.coordinatorId || LIVE.has(w.status)).map((w): OfficeAgent => {
      const tree = w.worktree === null ? undefined : byPath.get(w.worktree);
      const phase = w.phase ?? "unknown";
      return {id: w.workerId, role: w.workerId === run.coordinatorId ? "coordinator" : "worker", status: w.status, phase,
        taskId: w.taskId, progress: run.tasks.find(t => t.taskId === w.taskId)?.progress ?? null,
        worktree: tree?.name ?? null, diff: tree?.diff ?? null,
        narration: narrate(tree?.diff ?? null) ?? (phase === "unknown" ? w.status : phase)};
    });
    const questions = run.questions.filter(q => q.answeredAt === null).map(q => ({questionId: q.questionId, prompt: q.prompt}));
    return {runId: run.runId, title: run.rootTaskId ?? run.runId,
      status: run.status, phase: run.phase ?? "unknown",
      budget: {limitMs: run.budget.limitMs, usedMs, remainingMs: Math.max(0, run.budget.limitMs - usedMs)},
      questions, agents, reviewers,
      ...(run.status === "complete" || run.status === "failed" ? {completedAt: run.updatedAt} : {}),
      commands: [`agent-ops run status ${run.runId}`, `agent-ops run logs ${run.runId}`,
        ...questions.map(q => `agent-ops run respond ${run.runId} --question-id ${quote(q.questionId)} --answer "..."`),
        `agent-ops run resume ${run.runId}`, `agent-ops run stop ${run.runId}`]};
  });
  const sessions = input.sessions ?? [];
  const bySession = new Map(sessions.map(session => [session.sessionId, session]));
  const runIds = new Set(input.runs.map(run => run.runId));
  const runSessionIds = new Set(input.worktrees.filter(worktree => worktree.runId !== undefined).map(worktree => worktree.sessionId));
  input.runs.flatMap(run => run.workers).forEach(worker => {
    runSessionIds.add(worker.ownerSessionId);
    if (worker.nativeSessionId !== null) runSessionIds.add(worker.nativeSessionId);
  });
  const lobby: OfficeDesk[] = [];
  const represented = new Set<string>();
  for (const worktree of input.worktrees) {
    if (worktree.runId !== undefined) continue;
    const session = bySession.get(worktree.sessionId);
    // An active task in a live worktree is new work, whatever closed the session before.
    const completedAt = worktree.completedAt ?? (worktree.status === "active" ? null : session?.completedAt ?? null);
    if (completedAt !== null && input.now - Date.parse(completedAt) >= COMPLETED_RETENTION_MS) continue;
    lobby.push({
      name: worktree.name,
      branch: worktree.branch,
      sessionId: worktree.sessionId,
      sessionActive: session?.status === "active" && completedAt === null,
      diff: worktree.diff,
      narration: narrate(worktree.diff) ?? worktree.phase ?? session?.phase ?? worktree.status ?? session?.status ?? "idle",
      commands: ["agent-ops worktree list", `agent-ops worktree finish ${quote(worktree.name)}`],
      ...(worktree.phase === undefined && session?.phase === undefined ? {} : {phase: phaseOf(worktree.phase ?? session?.phase)}),
      ...(worktree.status === undefined && session?.taskStatus === undefined && session?.status === undefined ? {} : {status: worktree.status ?? session?.taskStatus ?? session?.status}),
      ...(worktree.taskId === undefined && session?.taskId === undefined ? {} : {taskId: worktree.taskId ?? session?.taskId ?? null}),
      ...(worktree.progress === undefined && session?.progress === undefined ? {} : {progress: worktree.progress ?? session?.progress ?? null}),
      ...(completedAt === null && session?.completedAt === undefined ? {} : {completedAt}),
      ...(worktree.host === undefined && session?.host === undefined ? {} : {host: worktree.host ?? session?.host}),
    });
    represented.add(worktree.sessionId);
  }
  for (const session of sessions) {
    if (represented.has(session.sessionId) || runSessionIds.has(session.sessionId) || (session.runId !== undefined && runIds.has(session.runId))) continue;
    represented.add(session.sessionId);
    const completedAt = session.completedAt ?? null;
    lobby.push({
      name: session.sessionId,
      branch: "(no worktree)",
      sessionId: session.sessionId,
      sessionActive: session.status === "active" && completedAt === null,
      diff: {files: 0, insertions: 0, deletions: 0, paths: [], recent: null},
      narration: session.phase === undefined ? session.taskStatus ?? session.status ?? "idle" : phaseOf(session.phase),
      commands: [`agent-ops task status --session ${quote(session.sessionId)}`],
      ...(session.phase === undefined ? {} : {phase: phaseOf(session.phase)}),
      status: session.taskStatus ?? session.status,
      ...(session.taskId === undefined ? {} : {taskId: session.taskId}),
      ...(session.progress === undefined ? {} : {progress: session.progress}),
      ...(completedAt === null ? {} : {completedAt}),
      ...(session.host === undefined ? {} : {host: session.host})
    });
  }
  return {generatedAt: new Date(input.now).toISOString(), runs, lobby, reviews: input.reviews.filter(r => !claimed.has(r))};
}
