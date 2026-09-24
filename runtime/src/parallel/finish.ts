import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentOpsConfig } from "../contracts.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError, resolveContainedPath } from "../fs/paths.js";
import { currentGateFingerprint } from "../hooks/completion-gate.js";
import type { TaskService } from "../task/service.js";
import { collectChangeSurface, type GitRunner } from "../verify/change-surface.js";
import {
  aggregateVerificationStatus,
  executeConfiguredCommand
} from "../verify/command-executor.js";
import type { VerificationProcessRunner } from "../verify/spawn.js";
import {
  assertWorktreeName,
  readWorktreeRecord,
  removeCheckout,
  resolveCheckouts,
  worktreePath,
  type WorktreeDependencies,
  type WorktreeRecord
} from "./service.js";

export const NOTES_REF = "agent-ops";
const LOCK_NAME = "agent-ops-finish.lock";
const LOCK_POLL_MS = 2_000;
const LOCK_WAIT_MS = 30 * 60 * 1000;
// A holder that has not finished in this long has died without its pid being
// reused by something we can see; the lock is reclaimed.
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const MAX_INTENTS = 20;

export interface FinishDependencies extends WorktreeDependencies {
  readonly tasks: (root: string) => TaskService;
  readonly processRunner?: VerificationProcessRunner;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly lockWaitMs?: number;
}

export interface FinishResult {
  readonly record: WorktreeRecord;
  readonly mergedHead: string;
  readonly rebased: boolean;
  readonly taskId: string;
  readonly warnings: readonly string[];
}

export interface TargetIntent {
  readonly commit: string;
  readonly note: string;
}

/**
 * The work and the moved target touch the same lines. The rebase was undone;
 * this carries what the agent needs to redo it deliberately: the files, and
 * what the tasks already merged into the target meant to achieve.
 */
export class WorktreeConflictError extends AgentOpsError {
  readonly files: readonly string[];
  readonly intents: readonly TargetIntent[];
  readonly target: string;

  constructor(
    record: WorktreeRecord,
    target: string,
    head: string,
    files: readonly string[],
    intents: readonly TargetIntent[]
  ) {
    super("WORKTREE_REBASE_CONFLICT", [
      `Rebasing ${record.branch} onto ${record.targetBranch} (${target}) conflicts in: ${files.join(", ")}.`,
      "The rebase was aborted and the branch is unchanged.",
      intents.length === 0
        ? "No agent-ops notes describe the target-side commits."
        : ["What the target-side work intended:", ...intents.map(({ commit, note }) =>
            `--- ${commit}\n${note}`)].join("\n"),
      `Resolve it in ${record.path}: git rebase ${target}, satisfy both intents, git rebase --continue;`,
      "then create a new task whose criteria cover both intents, attach it to this session,",
      `run verify, review and task complete with --base ${target}, and finish again.`,
      `One attempt only: if that verification or review fails, git reset --hard ${head}`,
      "and stop to report instead of retrying."
    ].join("\n"));
    this.files = files;
    this.intents = intents;
    this.target = target;
  }
}

function finishError(code: string, message: string): AgentOpsError {
  return new AgentOpsError(code, message);
}

async function git(deps: WorktreeDependencies, cwd: string, args: readonly string[], code: string, message: string): Promise<string> {
  const result = await deps.git(cwd, args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split("\n")[0];
    throw finishError(code, detail === undefined || detail === "" ? message : `${message} ${detail}`);
  }
  return result.stdout.trim();
}

function runner(deps: WorktreeDependencies, cwd: string): GitRunner {
  return {
    run: async (args) => {
      const result = await deps.git(cwd, args);
      return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout, "utf8") };
    }
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

async function staleLock(path: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as { pid?: unknown; at?: unknown };
    if (typeof owner.pid !== "number" || typeof owner.at !== "number") return true;
    return !alive(owner.pid) || Date.now() - owner.at > LOCK_STALE_MS;
  } catch {
    // A holder between mkdir and writing its owner file looks like this too;
    // only an old ownerless lock is abandoned.
    try {
      return Date.now() - (await stat(path)).mtimeMs > 60_000;
    } catch {
      return true;
    }
  }
}

/**
 * One finish at a time per repository: each one moves the target, and every
 * later one must rebase onto that. The lock lives in the Git common directory
 * so every worktree of the repository sees the same one.
 */
export async function withFinishLock<T>(
  deps: FinishDependencies,
  commonDir: string,
  action: () => Promise<T>
): Promise<T> {
  const path = join(commonDir, LOCK_NAME);
  const deadline = Date.now() + (deps.lockWaitMs ?? LOCK_WAIT_MS);
  const sleep = deps.sleep ?? (async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms)));
  for (;;) {
    try {
      await mkdir(path);
      await writeFile(join(path, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      if (await staleLock(path)) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw finishError("WORKTREE_FINISH_BUSY", "Another worktree finish is still running; try again later.");
      }
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await action();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

/**
 * The branch's own change, independent of where it is based: hunk positions
 * and blob ids move with a rebase, the change itself does not.
 */
async function patchHash(deps: WorktreeDependencies, cwd: string, target: string): Promise<string> {
  const diff = await git(deps, cwd,
    ["diff", "--no-color", "--no-ext-diff", "--no-textconv", `${target}...HEAD`],
    "WORKTREE_DIFF_FAILED", "Git could not diff the branch.");
  return sha256(diff.split("\n")
    .filter((line) => !line.startsWith("index "))
    .map((line) => line.startsWith("@@") ? "@@" : line)
    .join("\n"));
}

async function reverify(
  deps: FinishDependencies,
  root: string,
  config: AgentOpsConfig
): Promise<readonly string[]> {
  const results = [];
  for (const command of config.verification.commands) {
    results.push(await executeConfiguredCommand(command, {
      cwd: command.cwd === "." ? root : await resolveContainedPath(root, command.cwd),
      trusted: true,
      ...(deps.processRunner === undefined ? {} : { runner: deps.processRunner })
    }));
  }
  return aggregateVerificationStatus(results) === "PASS"
    ? []
    : results.filter((result) => result.required && result.status !== "PASS").map(({ commandId }) => commandId);
}

async function targetIntents(deps: WorktreeDependencies, cwd: string, target: string): Promise<TargetIntent[]> {
  const commits = (await git(deps, cwd, ["log", "--format=%H", `HEAD..${target}`],
    "WORKTREE_LOG_FAILED", "Git could not list the target-side commits.")).split("\n").filter(Boolean);
  const intents: TargetIntent[] = [];
  for (const commit of commits) {
    const note = await deps.git(cwd, ["notes", `--ref=${NOTES_REF}`, "show", commit]);
    if (note.exitCode === 0 && note.stdout.trim() !== "") {
      intents.push({ commit, note: note.stdout.trim() });
      if (intents.length >= MAX_INTENTS) break;
    }
  }
  return intents;
}

function noteText(record: WorktreeRecord, task: Awaited<ReturnType<TaskService["status"]>>): string {
  return [
    `agent-ops task ${task.task.id}: ${task.task.title}`,
    `worktree: ${record.name} (${record.branch})`,
    "criteria:",
    ...task.task.criteria.map(({ id, description }) => `- ${id}: ${description}`)
  ].join("\n");
}

/**
 * Brings a worktree's reviewed work into the branch the main checkout is on,
 * by fast-forward only, then retires the worktree. Run from the main checkout.
 */
export async function finishWorktree(
  deps: FinishDependencies,
  options: { readonly cwd: string; readonly name: string | undefined }
): Promise<FinishResult> {
  const name = assertWorktreeName(options.name);
  const { mainRoot, currentRoot, commonDir } = await resolveCheckouts(deps, options.cwd);
  if (currentRoot !== mainRoot) {
    throw finishError("WORKTREE_NESTED",
      `Run worktree finish from the main checkout (${mainRoot}); Claude Code: ExitWorktree with action keep first.`);
  }
  const record = await readWorktreeRecord(worktreePath(mainRoot, name));
  if (record === null) {
    throw finishError("WORKTREE_NOT_FOUND", `No agent-ops worktree named ${name}; see agent-ops worktree list.`);
  }
  return await withFinishLock(deps, commonDir, async () => {
    const mainRunner = runner(deps, mainRoot);
    const worktreeRunner = runner(deps, record.path);
    if ((await collectChangeSurface(mainRunner)).paths.length > 0) {
      throw finishError("WORKTREE_MAIN_DIRTY", "The main checkout has uncommitted changes; a fast-forward would mix them in.");
    }
    const onBranch = (await deps.git(mainRoot, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    if (onBranch !== record.targetBranch) {
      throw finishError("WORKTREE_TARGET_MOVED",
        `The main checkout is on ${onBranch || "a detached HEAD"}; switch it back to ${record.targetBranch} to finish.`);
    }
    if ((await collectChangeSurface(worktreeRunner)).paths.length > 0) {
      throw finishError("WORKTREE_DIRTY", `Commit or discard the uncommitted changes in ${record.path} first.`);
    }
    const target = await git(deps, mainRoot, ["rev-parse", "--verify", `${record.targetBranch}^{commit}`],
      "WORKTREE_TARGET_MISSING", `${record.targetBranch} does not resolve to a commit.`);
    const ahead = Number(await git(deps, record.path, ["rev-list", "--count", `${target}..HEAD`],
      "WORKTREE_LOG_FAILED", "Git could not compare the branch with its target."));
    if (ahead === 0) {
      throw finishError("WORKTREE_NOTHING_TO_MERGE",
        `${record.branch} has no commits beyond ${record.targetBranch}; remove the worktree instead.`);
    }
    const worktreeConfig = await deps.loadConfig(record.path);
    const worktreeGate = await deps.gate(record.path, worktreeConfig);
    const problem = await worktreeGate.validate(record.sessionId);
    if (problem !== null) {
      throw finishError("WORKTREE_TASK_INCOMPLETE",
        `The worktree's task is not ready to merge (${problem.code}). ${problem.remedy ?? ""}`.trim());
    }
    const task = await deps.tasks(record.path).status({ sessionId: record.sessionId });

    const head = await git(deps, record.path, ["rev-parse", "HEAD"], "WORKTREE_LOG_FAILED", "Git could not read HEAD.");
    const fastForward = (await deps.git(record.path, ["merge-base", "--is-ancestor", target, "HEAD"])).exitCode === 0;
    if (!fastForward) {
      const before = await patchHash(deps, record.path, target);
      const rebase = await deps.git(record.path, ["rebase", "--no-autostash", target]);
      if (rebase.exitCode !== 0) {
        const files = (await deps.git(record.path, ["diff", "--name-only", "--diff-filter=U"])).stdout
          .split("\n").map((line) => line.trim()).filter(Boolean);
        await deps.git(record.path, ["rebase", "--abort"]);
        await deps.git(record.path, ["reset", "--hard", head]);
        throw new WorktreeConflictError(record, target, head, files, await targetIntents(deps, record.path, target));
      }
      const reset = async () => { await deps.git(record.path, ["reset", "--hard", head]); };
      if (await patchHash(deps, record.path, target) !== before) {
        await reset();
        throw finishError("WORKTREE_REBASE_CHANGED",
          `Rebasing onto ${target} changed the branch's own diff, so the review no longer covers it. The branch was reset; rebase it yourself and review the result as a new task.`);
      }
      if (await deps.trust.status(record.path, worktreeConfig) !== "TRUSTED") {
        await reset();
        throw finishError("WORKTREE_UNTRUSTED",
          "Re-verifying the rebased branch runs repository commands; run agent-ops trust grant in the worktree.");
      }
      const failed = await reverify(deps, record.path, worktreeConfig);
      if (failed.length > 0) {
        await reset();
        throw finishError("WORKTREE_REVERIFY_FAILED",
          `After rebasing onto ${target}, verification failed: ${failed.join(", ")}. The branch was reset; fix it as a new task and finish again.`);
      }
    }

    const mainConfig = await deps.loadConfig(mainRoot);
    const gateEnabled = mainConfig.features.completionGate.enabled;
    const before = gateEnabled ? await currentGateFingerprint(mainRoot, mainRunner) : "";
    await git(deps, mainRoot, ["merge", "--ff-only", record.branch],
      "WORKTREE_MERGE_FAILED", `Git could not fast-forward ${record.targetBranch}.`);
    const mergedHead = await git(deps, mainRoot, ["rev-parse", "HEAD"], "WORKTREE_LOG_FAILED", "Git could not read HEAD.");

    // The merge happened; everything below is cleanup, reported, never undone.
    const warnings: string[] = [];
    const attempt = async (label: string, step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (error) {
        warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await attempt("note", async () => await git(deps, mainRoot,
      ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", noteText(record, task), mergedHead],
      "WORKTREE_NOTE_FAILED", "Git could not write the agent-ops note."));
    if (gateEnabled) {
      await attempt("gate", async () => {
        const mainGate = await deps.gate(mainRoot, mainConfig);
        await mainGate.redirect(record.sessionId, null);
        await mainGate.rebase(before, await currentGateFingerprint(mainRoot, mainRunner));
      });
    }
    await attempt("trust", async () => await deps.trust.revoke(record.path, worktreeConfig));
    await attempt("remove", async () => await removeCheckout(deps, record, true));
    return { record, mergedHead, rebased: !fastForward, taskId: task.task.id, warnings };
  });
}
