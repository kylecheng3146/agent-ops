import {execFile} from "node:child_process";
import {readdir, readFile, realpath, stat} from "node:fs/promises";
import {basename, join, resolve} from "node:path";
import {promisify} from "node:util";

import {readWorktreeRecord, parseWorktreeListPorcelain} from "../parallel/service.js";
import {FileRunRepository, type RunState} from "../run/service.js";
import type {OfficeDiff, OfficeInput, OfficeReviewSlot, OfficeWorktreeInput} from "./snapshot.js";

export type OfficeGit = (cwd: string, args: readonly string[]) => Promise<{exitCode: number; stdout: string}>;

const run = promisify(execFile);
export const officeGit: OfficeGit = async (cwd, args) => {
  try {return {exitCode: 0, stdout: (await run("git", [...args], {cwd, maxBuffer: 8 * 1024 * 1024})).stdout};}
  catch {return {exitCode: 1, stdout: ""};}
};

const MAX_PATHS = 200;

/** Changed paths and line counts against the worktree's base, committed or not. */
export async function worktreeDiff(git: OfficeGit, path: string, base: string): Promise<OfficeDiff> {
  const numstat = await git(path, ["diff", "--numstat", "-z", base]);
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
  for (const entry of parseWorktreeListPorcelain((await git(mainRoot, ["worktree", "list", "--porcelain"])).stdout)) {
    const path = await realpath(resolve(entry.path)).catch(() => resolve(entry.path));
    const record = await readWorktreeRecord(path).catch(() => null);
    if (record === null) continue;
    worktrees.push({name: record.name, path, branch: record.branch, sessionId: record.sessionId,
      ...(record.runId === undefined ? {} : {runId: record.runId}), diff: await worktreeDiff(git, path, record.base)});
  }
  return {runs: await readRuns(commonDir), worktrees, reviews: await readReviewSlots(commonDir), now};
}
