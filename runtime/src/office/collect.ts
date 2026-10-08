import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {readdir, readFile, realpath, stat} from "node:fs/promises";
import {basename, join, resolve} from "node:path";
import {promisify} from "node:util";

import {readWorktreeRecord, parseWorktreeListPorcelain} from "../parallel/service.js";
import {FileRunRepository, type RunState} from "../run/service.js";
import {criteriaProgress} from "../run/phase.js";
import {parseTaskStateSource, type StoredTaskRecord} from "../task/store.js";
import type {VerificationEvidence} from "../contracts.js";
import {findReviewAttestation} from "../review/attestation.js";
import {FileEvidenceStore} from "../verify/evidence.js";
import {readPrivateFile} from "../security/permissions.js";
import {OFFICE_SESSION_RETENTION_MS, readOfficeSessions} from "./sessions.js";
import {buildOfficeSnapshot, mergeOfficeSnapshots} from "./snapshot.js";
import type {OfficeCriterion, OfficeDiff, OfficeInput, OfficePhase, OfficeReviewSlot, OfficeSessionView, OfficeSnapshot, OfficeWorktreeInput} from "./snapshot.js";
import {forgetOfficeRepos, readOfficeRepos} from "./repos.js";
import type {OfficeHome} from "./server.js";

export type OfficeGit = (cwd: string, args: readonly string[]) => Promise<{exitCode: number; stdout: string}>;

const run = promisify(execFile);
export const officeGit: OfficeGit = async (cwd, args) => {
  try {return {exitCode: 0, stdout: (await run("git", [...args], {cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true})).stdout};}
  catch {return {exitCode: 1, stdout: ""};}
};

const MAX_PATHS = 200;

interface OfficeTaskView {
  readonly taskId: string;
  readonly status: StoredTaskRecord["status"];
  readonly phase: OfficePhase;
  readonly progress: {readonly verify: "PASS" | "FAIL" | null; readonly review: "PASS" | "FAIL" | null; readonly passed: number; readonly total: number};
  readonly title: string;
  readonly criteria: readonly OfficeCriterion[];
  readonly completedAt: string | null;
}

interface LoadedEvidence {
  readonly reference: string;
  readonly evidence: VerificationEvidence;
}

const OFFICE_PHASES = new Set<OfficePhase>(["planning", "implementing", "verifying", "reviewing", "integrating", "unknown"]);

function officePhase(value: string | undefined): OfficePhase | undefined {
  return value === undefined ? undefined : OFFICE_PHASES.has(value as OfficePhase) ? value as OfficePhase : "unknown";
}

function evidenceValue(value: unknown, taskId: string, criterionId: string): VerificationEvidence | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const evidence = value as Partial<VerificationEvidence>;
  return evidence.taskId === taskId && evidence.criterionId === criterionId &&
    (evidence.status === "PASS" || evidence.status === "FAIL" || evidence.status === "UNKNOWN")
    ? value as VerificationEvidence : null;
}

async function taskView(root: string, record: StoredTaskRecord): Promise<OfficeTaskView> {
  const store = new FileEvidenceStore(root, root);
  const loaded: LoadedEvidence[] = [];
  for (const criterion of record.task.criteria) {
    for (const reference of record.evidence[criterion.id] ?? []) {
      if (reference.startsWith("review:")) continue;
      const item = await store.load(reference).catch(() => null);
      const parsed = evidenceValue(item, record.task.id, criterion.id);
      if (parsed !== null) loaded.push({reference, evidence: parsed});
    }
  }
  // A task keeps its evidence history. The desk shows the newest observation
  // for each verifier/acceptance phase so an old failure cannot poison a
  // later PASS, and a stale review cannot remain current after a new verify.
  const latest = new Map<string, LoadedEvidence>();
  for (const item of loaded) {
    const phase = item.evidence.acceptance?.phase ?? "command";
    const key = `${item.evidence.criterionId}\0${item.evidence.commandId}\0${phase}`;
    const previous = latest.get(key);
    const currentAt = Date.parse(item.evidence.finishedAt);
    const previousAt = previous === undefined ? Number.NEGATIVE_INFINITY : Date.parse(previous.evidence.finishedAt);
    if (previous === undefined || currentAt >= previousAt) latest.set(key, item);
  }
  const evidence = [...latest.values()].map(item => item.evidence);
  let passed = 0;
  const criteria: OfficeCriterion[] = [];
  for (const criterion of record.task.criteria) {
    const rows = evidence.filter(item => item.criterionId === criterion.id);
    const checks = rows.flatMap(item => item.acceptance?.checks.map(check => ({criterionId: criterion.id, status: check.status})) ?? []);
    const result = criteriaProgress([criterion], {results: rows.map(item => ({status: item.status})), acceptance: checks});
    passed += result.passed;
    // The row is PASS exactly when it counts toward `passed`, so the list and the n/m summary agree.
    const seen = [...rows.map(item => item.status), ...checks.map(check => check.status)];
    const status = result.passed === 1 ? "PASS" as const : seen.includes("FAIL") ? "FAIL" as const : seen.includes("UNKNOWN") ? "UNKNOWN" as const : null;
    const last = rows.reduce<VerificationEvidence | null>((current, item) =>
      current === null || Date.parse(item.finishedAt) >= Date.parse(current.finishedAt) ? item : current, null);
    criteria.push({id: criterion.id, description: criterion.description, status, finishedAt: last?.finishedAt ?? null,
      failureClass: status === "PASS" || last === null ? null : last.failureClass, exitCode: status === "PASS" ? null : last?.exitCode ?? null});
  }
  const total = record.task.criteria.length;
  const verify = evidence.some(item => item.status === "FAIL" || item.status === "UNKNOWN")
    ? "FAIL" as const
    : total > 0 && passed === total
      ? "PASS" as const
      : null;
  const newest = evidence.reduce<VerificationEvidence | null>((current, item) =>
    current === null || Date.parse(item.finishedAt) >= Date.parse(current.finishedAt) ? item : current, null);
  const review: "PASS" | "FAIL" | null = newest !== null &&
    await findReviewAttestation(root, newest.sourceFingerprint, record.task.id) !== null ? "PASS" : null;
  const progress = {verify, review, passed, total};
  const phase: OfficePhase = record.status === "complete"
    ? "integrating"
    : review === "PASS"
      ? "reviewing"
      : verify !== null
        ? "verifying"
        : evidence.length > 0
          ? "implementing"
          : "planning";
  return {taskId: record.task.id, status: record.status, phase, progress, title: record.task.title, criteria, completedAt: record.completedAt};
}

async function taskState(root: string): Promise<ReturnType<typeof parseTaskStateSource> | null> {
  const source = await readPrivateFile(join(root, ".agent-ops", "tasks", "state.json"), root).catch(() => null);
  if (source === null) return null;
  try { return parseTaskStateSource(source); }
  catch { return null; }
}

async function attachedTaskView(root: string, sessionId: string, fallbackTaskId?: string): Promise<OfficeTaskView | null> {
  const state = await taskState(root);
  if (state === null) return null;
  const taskId = state.sessions.find(session => session.sessionId === sessionId)?.taskId ?? fallbackTaskId;
  if (taskId === undefined) return null;
  const record = state.tasks.find(task => task.task.id === taskId);
  return record === undefined ? null : await taskView(root, record);
}

/** Changed paths and line counts against the worktree's base, committed or not. */
export async function worktreeDiff(git: OfficeGit, path: string, base: string): Promise<OfficeDiff> {
  // The record is a file inside the checkout; only a commit id may reach git's argument list.
  const numstat = /^[0-9a-f]{40,64}$/u.test(base) ? await git(path, ["diff", "--numstat", "-z", base, "--"]) : {exitCode: 1, stdout: ""};
  const untracked = await git(path, ["ls-files", "--others", "--exclude-standard", "-z"]);
  let insertions = 0, deletions = 0;
  const paths: string[] = [];
  // -z numstat: "added\tdeleted\tpath\0", renames as "added\tdeleted\t\0from\0to\0".
  const fields = numstat.stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/u.exec(fields[i]!);
    if (match === null) continue;
    insertions += Number(match[1]) || 0;
    deletions += Number(match[2]) || 0;
    paths.push(match[3] === "" ? (i += 2, fields[i]!) : match[3]!);
  }
  paths.push(...untracked.stdout.split("\0").filter(p => p !== ""));
  let recent: string | null = null, newest = -1;
  for (const p of paths.slice(0, MAX_PATHS)) {
    const mtime = await stat(join(path, p)).then(s => s.mtimeMs, () => -1);
    if (mtime > newest) {newest = mtime; recent = p;}
  }
  return {files: paths.length, insertions, deletions, paths: paths.slice(0, MAX_PATHS), recent: recent ?? paths[0] ?? null};
}

/**
 * Work already in the target branch by some route other than `worktree finish`
 * (a merged pull request): commits past its base, all reachable from the
 * target, and nothing uncommitted. A fresh worktree (HEAD at base) is not merged.
 * ponytail: ancestry only, so a squash-merged branch stays visible until removed.
 */
export async function worktreeMerged(git: OfficeGit, path: string, base: string, targetBranch: string): Promise<boolean> {
  const head = (await git(path, ["rev-parse", "HEAD"])).stdout.trim();
  if (!/^[0-9a-f]{40,64}$/u.test(head) || head === base || !/^[A-Za-z0-9._/-]{1,128}$/u.test(targetBranch)) return false;
  if ((await git(path, ["merge-base", "--is-ancestor", head, `refs/heads/${targetBranch}`])).exitCode !== 0) return false;
  const status = await git(path, ["status", "--porcelain"]);
  return status.exitCode === 0 && status.stdout.trim() === "";
}

/** Each run is read on its own: one unreadable run must not hide the building. */
export async function readRuns(commonDir: string): Promise<RunState[]> {
  const directory = join(commonDir, "agent-ops", "runs");
  const repository = new FileRunRepository(directory, commonDir);
  const names = await readdir(directory).catch(() => [] as string[]);
  const runs: RunState[] = [];
  for (const name of names.filter(n => n.endsWith(".json"))) {
    const state = await repository.read(basename(name, ".json")).catch(() => null);
    if (state !== null) runs.push(state);
  }
  return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function readSessions(mainRoot: string, commonDir: string, now: number,
  trustedRoots: readonly string[] = [mainRoot]): Promise<OfficeSessionView[]> {
  const sessions = await readOfficeSessions(commonDir, now).catch(() => []);
  const views = await Promise.all(sessions.map(async session => {
    let task: OfficeTaskView | null = null;
    for (const root of trustedRoots) {
      task = await attachedTaskView(root, session.sessionId, root === mainRoot ? session.taskId : undefined);
      if (task !== null) break;
    }
    const observedPhase = session?.phase === undefined ? undefined : officePhase(session.phase) ?? "unknown";
    const phase = task === null
      ? observedPhase
      : task.status === "complete"
        ? task.phase
        : observedPhase ?? task.phase;
    return task === null
      ? session
      : {...session, taskId: task.taskId, phase, taskStatus: task.status, progress: task.progress, title: task.title, criteria: task.criteria,
        completedAt: task.completedAt, status: task.status === "complete" ? "idle" as const : session.status};
  }));
  return views.filter(session => session.completedAt === undefined || session.completedAt === null ||
    now - Date.parse(session.completedAt) <= OFFICE_SESSION_RETENTION_MS);
}

function alive(pid: number): boolean {
  try {process.kill(pid, 0); return true;}
  catch (error) {return (error as {code?: string}).code === "EPERM";}
}

/** Review slots held by a live process (see review/slots.ts). */
export async function readReviewSlots(commonDir: string): Promise<OfficeReviewSlot[]> {
  const slots: OfficeReviewSlot[] = [];
  for (const name of (await readdir(commonDir).catch(() => [] as string[])).sort()) {
    const match = /^agent-ops-review-slot-(\d+)\.lock$/u.exec(name);
    if (match === null) continue;
    try {
      const owner = JSON.parse(await readFile(join(commonDir, name, "owner.json"), "utf8")) as Record<string, unknown>;
      if (typeof owner.pid !== "number" || typeof owner.at !== "number" || !alive(owner.pid)) continue;
      slots.push({slot: Number(match[1]), since: new Date(owner.at).toISOString(),
        taskId: typeof owner.taskId === "string" ? owner.taskId : null, root: typeof owner.root === "string" ? owner.root : null});
    } catch { /* a slot being claimed or released */ }
  }
  return slots;
}

export async function collectOfficeInput(mainRoot: string, commonDir: string, git: OfficeGit = officeGit,
  now = Date.now()): Promise<OfficeInput> {
  const worktrees: OfficeWorktreeInput[] = [];
  const discovered: Array<{readonly path: string; readonly record: NonNullable<Awaited<ReturnType<typeof readWorktreeRecord>>>}> = [];
  const merged = new Set<string>();
  for (const entry of parseWorktreeListPorcelain((await git(mainRoot, ["worktree", "list", "--porcelain"])).stdout)) {
    const path = await realpath(resolve(entry.path)).catch(() => resolve(entry.path));
    const record = await readWorktreeRecord(path).catch(() => null);
    if (record === null) continue;
    if (record.runId === undefined && await worktreeMerged(git, path, record.base, record.targetBranch)) {
      // A subagent's worktree shares its coordinator's session, which stays.
      if (record.agentId === undefined) merged.add(record.sessionId);
      continue;
    }
    discovered.push({path, record});
  }
  const sessions = (await readSessions(mainRoot, commonDir, now,
    [mainRoot, ...discovered.map(item => item.path)])).filter(session => !merged.has(session.sessionId));
  for (const {path, record} of discovered) {
    const session = sessions.find(item => item.sessionId === record.sessionId);
    const task = await attachedTaskView(path, record.sessionId, session?.taskId);
    const base = {name: record.name, path, branch: record.branch, sessionId: record.sessionId,
      ...(record.runId === undefined ? {} : {runId: record.runId}), diff: await worktreeDiff(git, path, record.base)};
    const observedPhase = session?.phase === undefined ? undefined : officePhase(session.phase) ?? "unknown";
    const phase = task === null
      ? observedPhase
      : task.status === "complete"
        ? task.phase
        : observedPhase ?? task.phase;
    worktrees.push(task === null
      ? session === undefined ? base : {...base, ...(officePhase(session.phase) === undefined ? {} : {phase: officePhase(session.phase)}), status: session.status,
          ...(session.taskId === undefined ? {} : {taskId: session.taskId}), host: session.host ?? session.harness}
      : {...base, phase, status: task.status, taskId: task.taskId, progress: task.progress, title: task.title, criteria: task.criteria,
          ...(task.completedAt === null ? {} : {completedAt: task.completedAt}), host: session?.host ?? session?.harness});
  }
  return {runs: await readRuns(commonDir), worktrees, sessions, reviews: await readReviewSlots(commonDir), now};
}

export interface OfficeBuilding {
  readonly snapshot: OfficeSnapshot;
  /** Repositories still in the building; none left means the server may go. */
  readonly repos: number;
}

/**
 * Every registered repository that still exists and still opts in, as one
 * building. One that vanished or opted out is forgotten, and so is one that
 * stayed quiet past the retention window with nothing left to show.
 */
export async function collectOfficeBuilding(home: OfficeHome, enabled: (mainRoot: string) => Promise<boolean>,
  git: OfficeGit = officeGit, now = Date.now()): Promise<OfficeBuilding> {
  const parts: Array<{readonly repo: string; readonly snapshot: OfficeSnapshot}> = [];
  const forget: string[] = [];
  const names = new Set<string>();
  for (const repo of await readOfficeRepos(home)) {
    if (!await stat(repo.commonDir).then(item => item.isDirectory(), () => false) || !await enabled(repo.mainRoot).catch(() => false)) {
      forget.push(repo.commonDir);
      continue;
    }
    // One unreadable repository must not hide the rest of the building.
    const snapshot = await collectOfficeInput(repo.mainRoot, repo.commonDir, git, now).then(buildOfficeSnapshot, () => null);
    if (snapshot === null) continue;
    if (snapshot.runs.length + snapshot.lobby.length + snapshot.reviews.length === 0 &&
      now - Date.parse(repo.lastSeenAt) >= OFFICE_SESSION_RETENTION_MS) {
      forget.push(repo.commonDir);
      continue;
    }
    let name = basename(repo.mainRoot);
    if (names.has(name)) name += "~" + createHash("sha256").update(repo.commonDir).digest("hex").slice(0, 4);
    names.add(name);
    parts.push({repo: name, snapshot});
  }
  await forgetOfficeRepos(home, forget).catch(() => undefined);
  return {snapshot: mergeOfficeSnapshots(parts, now), repos: parts.length};
}
