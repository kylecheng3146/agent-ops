import type {RunPhase, RunState, RunTaskProgress} from "../run/service.js";
import {activeWallTimeMs} from "../run/scheduler.js";

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
  readonly reviews: readonly OfficeReviewSlot[];
  readonly now: number;
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
}

export interface OfficeDesk {
  readonly name: string;
  readonly branch: string;
  readonly sessionId: string;
  readonly diff: OfficeDiff;
  readonly narration: string;
  readonly commands: readonly string[];
}

export interface OfficeSnapshot {
  readonly generatedAt: string;
  readonly runs: readonly OfficeRun[];
  readonly lobby: readonly OfficeDesk[];
  readonly reviews: readonly OfficeReviewSlot[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LIVE = new Set(["assigned", "starting", "running", "idle", "handing-off", "fenced", "delivered", "blocked"]);

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
  // ponytail: finished runs leave after a day; add history paging if anyone wants an archive floor
  const runs = input.runs.filter(run => !["complete", "failed"].includes(run.status) || input.now - Date.parse(run.updatedAt) < DAY_MS)
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
    return {runId: run.runId, title: run.goal.split("\n").find(l => l.trim() !== "")?.replace(/^#+\s*/u, "").slice(0, 120) ?? run.runId,
      status: run.status, phase: run.phase ?? "unknown",
      budget: {limitMs: run.budget.limitMs, usedMs, remainingMs: Math.max(0, run.budget.limitMs - usedMs)},
      questions, agents, reviewers,
      commands: [`agent-ops run status ${run.runId}`, `agent-ops run logs ${run.runId}`,
        ...questions.map(q => `agent-ops run respond ${run.runId} --question-id ${quote(q.questionId)} --answer "..."`),
        `agent-ops run resume ${run.runId}`, `agent-ops run stop ${run.runId}`]};
  });
  const lobby = input.worktrees.filter(w => w.runId === undefined).map((w): OfficeDesk => ({
    name: w.name, branch: w.branch, sessionId: w.sessionId, diff: w.diff, narration: narrate(w.diff) ?? "idle",
    commands: ["agent-ops worktree list", `agent-ops worktree finish ${w.name}`]}));
  return {generatedAt: new Date(input.now).toISOString(), runs, lobby, reviews: input.reviews.filter(r => !claimed.has(r))};
}
