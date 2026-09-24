import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { collectChangeSurface } from "../verify/change-surface.js";
import type { FinishDependencies } from "./finish.js";
import {
  assertSessionId,
  assertWorktreeName,
  bindSession,
  insideWorktreeDirectory,
  readWorktreeRecord,
  removeCheckout,
  resolveCheckouts,
  worktreePath,
  writeWorktreeRecord,
  type WorktreeRecord
} from "./service.js";

/**
 * A baseline no source state hashes to. A resumed session inherits whatever
 * the last one left in the worktree, so none of it counts as "unchanged".
 */
export const RESUMED_BASELINE = sha256("agent-ops-worktree-resumed");
export const IDLE_DAYS = 7;

export interface WorktreeStatus {
  readonly record: WorktreeRecord;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly taskStatus: string;
  readonly lastActivity: string;
}

function manageError(code: string, message: string): AgentOpsError {
  return new AgentOpsError(code, message);
}

async function mainCheckout(deps: FinishDependencies, cwd: string): Promise<string> {
  const { mainRoot, currentRoot } = await resolveCheckouts(deps, cwd);
  if (currentRoot !== mainRoot) {
    throw manageError("WORKTREE_NESTED", `Run this from the main checkout (${mainRoot}).`);
  }
  return mainRoot;
}

async function mtime(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** The last time anything agent-ops tracks moved in the worktree. */
async function lastActivity(record: WorktreeRecord): Promise<string> {
  const gate = join(record.path, ".agent-ops", "tasks", "completion-gate");
  const times = [
    Date.parse(record.createdAt) || 0,
    await mtime(join(record.path, ".agent-ops", "tasks", "state.json")),
    ...await Promise.all((await readdir(gate).catch(() => [] as string[]))
      .map(async (name) => await mtime(join(gate, name))))
  ];
  return new Date(Math.max(...times)).toISOString();
}

async function describe(deps: FinishDependencies, record: WorktreeRecord): Promise<WorktreeStatus> {
  const runner = {
    run: async (args: readonly string[]) => {
      const result = await deps.git(record.path, args);
      return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout, "utf8") };
    }
  };
  const dirty = (await collectChangeSurface(runner).catch(() => ({ paths: ["?"] }))).paths.length > 0;
  const count = await deps.git(record.path, ["rev-list", "--count", `${record.targetBranch}..HEAD`]);
  const taskStatus = await deps.tasks(record.path).status({ sessionId: record.sessionId })
    .then((task) => `${task.task.id} ${task.status}`)
    .catch(() => "none");
  return {
    record,
    dirty,
    ahead: count.exitCode === 0 ? Number(count.stdout.trim()) : 0,
    taskStatus,
    lastActivity: await lastActivity(record)
  };
}

/** Every agent-ops worktree of this repository, from any of its checkouts. */
export async function listWorktrees(deps: FinishDependencies, cwd: string): Promise<readonly WorktreeStatus[]> {
  const { mainRoot } = await resolveCheckouts(deps, cwd);
  const listing = await deps.git(mainRoot, ["worktree", "list", "--porcelain"]);
  if (listing.exitCode !== 0) {
    throw manageError("WORKTREE_LIST_FAILED", "Git could not list worktrees.");
  }
  const statuses: WorktreeStatus[] = [];
  for (const line of listing.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length);
    if (!insideWorktreeDirectory(mainRoot, path)) continue;
    const record = await readWorktreeRecord(path);
    if (record !== null) statuses.push(await describe(deps, record));
  }
  return statuses.sort((left, right) => left.record.name.localeCompare(right.record.name));
}

export function idleWorktrees(statuses: readonly WorktreeStatus[], now: number): readonly WorktreeStatus[] {
  return statuses.filter(({ lastActivity: at }) => now - Date.parse(at) > IDLE_DAYS * 24 * 60 * 60 * 1000);
}

/** Doctor's reading of the worktrees: idle ones are worth a look, not a failure. */
export function worktreeDoctorResult(statuses: readonly WorktreeStatus[], now: number): {
  readonly status: "DEGRADED" | "PASS";
  readonly message: string;
  readonly remediation?: string;
} {
  const idle = idleWorktrees(statuses, now);
  return idle.length === 0
    ? { status: "PASS", message: `${statuses.length} agent-ops worktree(s), none idle.` }
    : {
        status: "DEGRADED",
        message: `Idle for more than ${IDLE_DAYS} days: ${idle.map(({ record }) => record.name).join(", ")}.`,
        remediation: "Resume, finish or remove them; see agent-ops worktree list."
      };
}

async function requireRecord(mainRoot: string, name: string): Promise<WorktreeRecord> {
  const record = await readWorktreeRecord(worktreePath(mainRoot, name));
  if (record === null) {
    throw manageError("WORKTREE_NOT_FOUND", `No agent-ops worktree named ${name}; see agent-ops worktree list.`);
  }
  return record;
}

/**
 * Hands a worktree whose session ended to a new one: the task, the gate and
 * the record follow the new id, and the new session's first Stop has to
 * account for everything already in the worktree.
 */
export async function resumeWorktree(
  deps: FinishDependencies,
  options: { readonly cwd: string; readonly name: string | undefined; readonly sessionId: string | undefined }
): Promise<WorktreeRecord> {
  const name = assertWorktreeName(options.name);
  const sessionId = assertSessionId(options.sessionId);
  const mainRoot = await mainCheckout(deps, options.cwd);
  const previous = await requireRecord(mainRoot, name);
  const tasks = deps.tasks(previous.path);
  const attached = await tasks.status({ sessionId: previous.sessionId }).catch(() => null);
  if (attached !== null) await tasks.attach(sessionId, attached.task.id);
  const record: WorktreeRecord = { ...previous, sessionId };
  await writeWorktreeRecord(record);
  const mainConfig = await deps.loadConfig(mainRoot);
  if (mainConfig.features.completionGate.enabled && previous.sessionId !== sessionId) {
    await (await deps.gate(mainRoot, mainConfig)).redirect(previous.sessionId, null);
  }
  await bindSession(deps, record, mainConfig, RESUMED_BASELINE);
  return record;
}

/**
 * Deletes a worktree and its branch. Work that exists nowhere else — an
 * uncommitted change or a commit the target lacks — needs `force`.
 */
export async function removeWorktree(
  deps: FinishDependencies,
  options: { readonly cwd: string; readonly name: string | undefined; readonly force: boolean }
): Promise<WorktreeStatus> {
  const name = assertWorktreeName(options.name);
  const mainRoot = await mainCheckout(deps, options.cwd);
  const status = await describe(deps, await requireRecord(mainRoot, name));
  if ((status.dirty || status.ahead > 0) && !options.force) {
    throw manageError("WORKTREE_UNMERGED",
      `${name} has ${status.dirty ? "uncommitted changes" : ""}${status.dirty && status.ahead > 0 ? " and " : ""}${status.ahead > 0 ? `${status.ahead} commit(s) not in ${status.record.targetBranch}` : ""}. Finish it, or remove it with --force to discard that work (the user is asked).`);
  }
  const { record } = status;
  const mainConfig = await deps.loadConfig(mainRoot);
  if (mainConfig.features.completionGate.enabled) {
    await (await deps.gate(mainRoot, mainConfig)).redirect(record.sessionId, null);
  }
  await deps.trust.revoke(record.path, await deps.loadConfig(record.path)).catch(() => undefined);
  await removeCheckout(deps, record, true);
  return status;
}
