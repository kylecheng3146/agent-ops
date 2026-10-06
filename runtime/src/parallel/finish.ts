import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import {randomUUID} from "node:crypto";
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
import { prepareFinishReceipt } from "./receipt.js";
import {readRunIntegrationProof, readRunIntegrationReceiptBinding, markRunIntegration} from "../run/integration.js";
import type {IntegrationReceiptBinding} from "../run/integration.js";
import {canonicalJson} from "../config/hash.js";
import { listWorktrees } from "./manage.js";
import {withPrivateFileLock} from "../security/permissions.js";
import type { IntegratedChild } from "./integrate.js";
import {
  assertWorktreeName,
  NOTES_REF,
  noteSessionLine,
  parseWorktreeListPorcelain,
  readWorktreeRecord,
  removeCheckout,
  resolveCheckouts,
  worktreePath,
  type WorktreeDependencies,
  type WorktreeRecord
} from "./service.js";

const LOCK_NAME = "agent-ops-finish.lock";
const LOCK_POLL_MS = 2_000;
const LOCK_WAIT_MS = 30 * 60 * 1000;
// A holder that has not finished in this long has died without its pid being
// reused by something we can see; the lock is reclaimed.
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const MAX_INTENTS = 20;

export interface FinishDependencies extends WorktreeDependencies {
  /** With `completionBase`, a service that can complete tasks over that range. */
  /** `noChangePaths` is the explicit source material for a verified no-change proof. */
  readonly tasks: (root: string, completionBase?: string, noChangePaths?: readonly string[]) => TaskService;
  readonly processRunner?: VerificationProcessRunner;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly lockWaitMs?: number;
}

export interface FinishResult {
  readonly record: WorktreeRecord;
  readonly mergedHead: string;
  readonly rebased: boolean;
  /** Every task the merge carries, top of each tree first. */
  readonly taskIds: readonly string[];
  readonly warnings: readonly string[];
  readonly receipt?: string;
}

export interface FinalCandidateProof {
  readonly recovery?: true;
  readonly target: string;
  readonly head: string;
  readonly sourceFingerprint: string;
  readonly children: readonly IntegratedChild[];
  /** An explicit review scope for an already-satisfied, unchanged target. */
  readonly noChange?: {
    readonly sourceCommit: string;
    readonly contractDigest: string;
    readonly reviewScope: import("../review/scope.js").ReviewScope;
    readonly artifactRefs: readonly string[];
  };
  readonly integrationJournal?: {
    readonly transactionId: string;
    readonly expectedTarget: string;
    readonly candidate: string;
    readonly digest: string;
  };
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
  const token = randomUUID();
  for (;;) {
    let claimed = false;
    try {
      claimed = await withPrivateFileLock(path + ".state", commonDir, async () => {
        for (;;) {
          try {
            await mkdir(path);
            await writeFile(join(path, "owner.json"), JSON.stringify({pid: process.pid, at: Date.now(), token}));
            return true;
          } catch (error) {
            if ((error as {code?: string}).code !== "EEXIST") throw error;
            if (!await staleLock(path)) return false;
            await rm(path, {recursive: true, force: true});
          }
        }
      });
    } catch (error) {
      if (!(error instanceof AgentOpsError) || error.code !== "PRIVATE_STATE_LOCK_TIMEOUT") throw error;
    }
    if (claimed) break;
    if (Date.now() >= deadline) throw finishError("WORKTREE_FINISH_BUSY", "Another worktree finish is still running; try again later.");
    await sleep(LOCK_POLL_MS);
  }
  try {
    return await action();
  } finally {
    await withPrivateFileLock(path + ".state", commonDir, async () => {
      const owner = await readFile(join(path, "owner.json"), "utf8").catch(error => {
        if ((error as {code?: string}).code === "ENOENT") return null;
        throw error;
      });
      if (owner !== null && JSON.parse(owner)?.token === token) await rm(path, {recursive: true, force: true});
    });
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

type StoredTask = Awaited<ReturnType<TaskService["status"]>>;

/** Each tree top first, its subtasks after it; `depth` counts parents. */
function taskTree(tasks: readonly StoredTask[]): { readonly task: StoredTask; readonly depth: number }[] {
  const ids = new Set(tasks.map(({ task }) => task.id));
  const ordered: { task: StoredTask; depth: number }[] = [];
  const visit = (parent: string | undefined, depth: number): void => {
    for (const task of tasks) {
      const own = task.task.parentTaskId !== undefined && ids.has(task.task.parentTaskId)
        ? task.task.parentTaskId
        : undefined;
      if (own === parent) {
        ordered.push({ task, depth });
        visit(task.task.id, depth + 1);
      }
    }
  };
  visit(undefined, 0);
  return ordered;
}

function noteText(record: WorktreeRecord, tasks: readonly { readonly task: StoredTask; readonly depth: number }[]): string {
  return [
    `worktree: ${record.name} (${record.branch})`,
    noteSessionLine(record.sessionId),
    ...tasks.flatMap(({ task, depth }) => {
      const indent = "  ".repeat(depth);
      return [
        `${indent}agent-ops task ${task.task.id}: ${task.task.title}`,
        ...(task.task.intent === undefined ? [] : [`${indent}intent: ${task.task.intent}`]),
        `${indent}criteria:`,
        ...task.task.criteria.map(({ id, description }) => `${indent}- ${id}: ${description}`)
      ];
    })
  ].join("\n");
}

/**
 * Brings a worktree's reviewed work into its target branch by fast-forward
 * only, then retires the worktree. Run from the main checkout, which may be on
 * another branch: then only the target's ref moves.
 */
export async function finishWorktree(
  deps: FinishDependencies,
  options: { readonly cwd: string; readonly name: string | undefined; readonly finalProof?: FinalCandidateProof }
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
    const sessionChildren = (await listWorktrees(deps, mainRoot))
      .map(({ record: child }) => child)
      .filter((child) => child.path !== record.path && child.sessionId === record.sessionId &&
        (child.agentId !== undefined || (record.runId !== undefined && child.runId === record.runId)));
    if (options.finalProof === undefined && sessionChildren.length > 0) {
      throw finishError("WORKTREE_CHILDREN_REQUIRE_ADVANCE", "This session has child worktrees; run task advance for integrated final evidence before finish.");
    }
    if (options.finalProof !== undefined && options.finalProof.recovery !== true &&
        (sessionChildren.length !== options.finalProof.children.length ||
         sessionChildren.some((child) => !options.finalProof!.children.some(({ name }) => name === child.name)))) {
      throw finishError("WORKTREE_CHILDREN_CHANGED", "The child worktree set changed after final review.");
    }
    const assertPinnedChild = async (child: WorktreeRecord): Promise<string> => {
      const expected = options.finalProof?.children.find(({ name }) => name === child.name)?.commit;
      const head = await git(deps, child.path, ["rev-parse", "HEAD"],
        "WORKTREE_CHILDREN_CHANGED", `Cannot read child ${child.name}.`);
      if (expected === undefined || head !== expected ||
          (await collectChangeSurface(runner(deps, child.path))).paths.length > 0) {
        throw finishError("WORKTREE_CHILDREN_CHANGED", `Child ${child.name} changed after integration; preserve its worktree.`);
      }
      return head;
    };
    if (options.finalProof !== undefined) {
      for (const child of sessionChildren) await assertPinnedChild(child);
    }
    const mainRunner = runner(deps, mainRoot);
    const worktreeRunner = runner(deps, record.path);
    const onBranch = (await deps.git(mainRoot, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
    // On the target, the merge rewrites the checkout's files, so its changes
    // would mix in. Anywhere else only the target's ref moves and the checkout
    // is never touched.
    const onTarget = onBranch === record.targetBranch;
    if (onTarget) {
      if ((await collectChangeSurface(mainRunner)).paths.length > 0) {
        throw finishError("WORKTREE_MAIN_DIRTY", "The main checkout has uncommitted changes; a fast-forward would mix them in.");
      }
    } else {
      const listing = await deps.git(mainRoot, ["worktree", "list", "--porcelain"]);
      const holder = listing.exitCode === 0
        ? parseWorktreeListPorcelain(listing.stdout).find(({ branch }) => branch === record.targetBranch)
        : undefined;
      if (holder !== undefined) {
        throw finishError("WORKTREE_BRANCH_CHECKED_OUT",
          `${record.targetBranch} is checked out at ${holder.path}; moving it would desync that checkout. Switch it away or finish from there.`);
      }
    }
    if ((await collectChangeSurface(worktreeRunner)).paths.length > 0) {
      throw finishError("WORKTREE_DIRTY", `Commit or discard the uncommitted changes in ${record.path} first.`);
    }
    const actualTarget = await git(deps, mainRoot, ["rev-parse", "--verify", `${record.targetBranch}^{commit}`],
      "WORKTREE_TARGET_MISSING", `${record.targetBranch} does not resolve to a commit.`);
    const recovering = options.finalProof?.recovery === true;
    if (recovering) {
      const sealed = await readRunIntegrationProof(commonDir, record);
      const {recovery: _recovery, ...requested} = options.finalProof!;
      if (sealed === null || canonicalJson(sealed) !== canonicalJson(requested) || actualTarget !== sealed.head)
        throw finishError("RUN_INTEGRATION_PROOF_CHANGED", "Recovery requires the exact sealed candidate already at the target.");
    }
    const target = recovering ? options.finalProof!.target : actualTarget;
    if (options.finalProof !== undefined && actualTarget !== options.finalProof.target && !recovering) {
      throw finishError("WORKTREE_TARGET_MOVED", "The target branch moved after final review; rerun the final evidence gate.");
    }
    const ahead = Number(await git(deps, record.path, ["rev-list", "--count", `${target}..HEAD`],
      "WORKTREE_LOG_FAILED", "Git could not compare the branch with its target."));
    const noChangeProof = options.finalProof?.noChange;
    if (ahead === 0 && noChangeProof === undefined && !recovering) {
      throw finishError("WORKTREE_NOTHING_TO_MERGE",
        `${record.branch} has no commits beyond ${record.targetBranch}; remove the worktree instead.`);
    }
    const worktreeConfig = await deps.loadConfig(record.path);
    const headBeforeCompletion = await git(deps, record.path, ["rev-parse", "HEAD"],
      "WORKTREE_LOG_FAILED", "Git could not read HEAD.");
    if (options.finalProof !== undefined) {
      if (headBeforeCompletion !== options.finalProof.head) {
        throw finishError("WORKTREE_SOURCE_MOVED", "The candidate changed after final review.");
      }
      if ((await deps.git(record.path, ["merge-base", "--is-ancestor", target, "HEAD"])).exitCode !== 0) {
        throw finishError("WORKTREE_TARGET_MOVED", "The final candidate is not based on the target; rerun the final evidence gate.");
      }
      if (noChangeProof !== undefined && noChangeProof.sourceCommit !== headBeforeCompletion) {
        throw finishError("WORKTREE_NO_CHANGE_SOURCE_MISMATCH", "The verified-no-change proof does not match the candidate commit.");
      }
    }
    // Direct finish completes before merge. A final-proof finish checks all
    // evidence first, then completes only after the target's fast-forward:
    // a target that moves before that point can still be re-reviewed once.
    const tree = taskTree((await deps.tasks(record.path).list()).filter(({ status }) => status !== "archived"));
    if (tree.length === 0) {
      throw finishError("WORKTREE_TASK_INCOMPLETE",
        "The worktree has no task; create one, verify and review it before finishing.");
    }
    const completeTasks = async () => {
      const noChangePaths = noChangeProof?.reviewScope.changedFiles;
      for (const { task } of [...tree].sort((left, right) => right.depth - left.depth)) {
        if (task.status === "complete") continue;
        const base = options.finalProof === undefined ? task.reviewBase ?? record.base : target;
        try {
          await deps.tasks(record.path, base, noChangePaths).complete(task.task.id, {});
        } catch (error) {
          throw finishError("WORKTREE_TASK_INCOMPLETE",
            `Task ${task.task.id} (${task.task.title}) could not be completed against ${base}: ${error instanceof Error ? error.message : String(error)} ` +
            "A task another session left here is not this session's to archive: its owner finishes or archives it, and finish never does.");
        }
      }
    };
    const validateGate = async () => {
      const worktreeGate = await deps.gate(record.path, worktreeConfig);
      const problem = await worktreeGate.validate(record.sessionId);
      if (problem !== null) {
        throw finishError("WORKTREE_TASK_INCOMPLETE",
          `The worktree's task is not ready to merge (${problem.code}). ${problem.remedy ?? ""}`.trim());
      }
    };
    if (options.finalProof === undefined) {
      await completeTasks();
      await validateGate();
    }

    const head = await git(deps, record.path, ["rev-parse", "HEAD"], "WORKTREE_LOG_FAILED", "Git could not read HEAD.");
    const fastForward = (await deps.git(record.path, ["merge-base", "--is-ancestor", target, "HEAD"])).exitCode === 0;
    if (options.finalProof !== undefined && !fastForward) {
      throw finishError("WORKTREE_TARGET_MOVED", "The target branch moved after final review.");
    }
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

    const sealedIntegration = options.finalProof === undefined || record.runId === undefined
      ? null
      : await readRunIntegrationReceiptBinding(commonDir, record, {target, candidate: head});
    const requestedIntegration = options.finalProof?.integrationJournal;
    if (requestedIntegration !== undefined && sealedIntegration !== null &&
        canonicalJson(requestedIntegration) !== canonicalJson(sealedIntegration)) {
      throw finishError("RUN_INTEGRATION_PROOF_CHANGED", "The requested receipt binding differs from the sealed integration transaction.");
    }
    const integrationJournal: IntegrationReceiptBinding | undefined = sealedIntegration ?? requestedIntegration;
    const receiptOptions = options.finalProof === undefined ? undefined : {
      commonDir,
      record,
      candidateHead: head,
      targetCommit: target,
      expectedFingerprint: options.finalProof.sourceFingerprint,
      children: options.finalProof.children,
      config: worktreeConfig,
      gitRunner: worktreeRunner,
      ...(noChangeProof === undefined ? {} : { noChange: noChangeProof }),
      ...(integrationJournal === undefined ? {} : { integrationJournal })
    };
    let receipt = receiptOptions === undefined ? undefined : await prepareFinishReceipt({
      ...receiptOptions,
      tasks: await deps.tasks(record.path).list().then((tasks) => tasks.filter(({ status }) => status !== "archived"))
    });
    const mainConfig = await deps.loadConfig(mainRoot);
    const gateEnabled = mainConfig.features.completionGate.enabled;
    const before = gateEnabled ? await currentGateFingerprint(mainRoot, mainRunner) : "";
    let mergedHead: string;
    if (noChangeProof !== undefined || recovering) {
      // A verified-no-change finish records proof and task state while leaving
      // the target ref untouched. The ordinary finish path still rejects an
      // empty branch, preserving its public behavior.
      mergedHead = actualTarget;
    } else if (onTarget) {
      if (options.finalProof !== undefined &&
          await git(deps, mainRoot, ["rev-parse", "HEAD"], "WORKTREE_LOG_FAILED", "Git could not read HEAD.") !== target) {
        throw finishError("WORKTREE_TARGET_MOVED", "The target changed after the final proof was prepared.");
      }
      const merge = await deps.git(mainRoot, ["merge", "--ff-only", record.branch]);
      if (merge.exitCode !== 0) {
        if (options.finalProof !== undefined &&
            await git(deps, mainRoot, ["rev-parse", "HEAD"], "WORKTREE_LOG_FAILED", "Git could not read HEAD.") !== target) {
          throw finishError("WORKTREE_TARGET_MOVED", "The target moved during finish; rerun the final evidence gate.");
        }
        throw finishError("WORKTREE_MERGE_FAILED", `Git could not fast-forward ${record.targetBranch}. ${merge.stderr.trim()}`);
      }
      mergedHead = await git(deps, mainRoot, ["rev-parse", "HEAD"], "WORKTREE_LOG_FAILED", "Git could not read HEAD.");
    } else {
      // Compare-and-swap on the target's value read above: a target that moved
      // since fails here instead of being overwritten.
      mergedHead = await git(deps, mainRoot, ["rev-parse", "--verify", `${record.branch}^{commit}`],
        "WORKTREE_LOG_FAILED", `Git could not read ${record.branch}.`);
      const update = await deps.git(mainRoot,
        ["update-ref", "-m", `agent-ops finish ${record.branch}`, `refs/heads/${record.targetBranch}`, mergedHead, target]);
      if (update.exitCode !== 0) {
        if (options.finalProof !== undefined &&
            await git(deps, mainRoot, ["rev-parse", `${record.targetBranch}^{commit}`],
              "WORKTREE_LOG_FAILED", "Git could not read the target.") !== target) {
          throw finishError("WORKTREE_TARGET_MOVED", "The target moved during finish; rerun the final evidence gate.");
        }
        throw finishError("WORKTREE_MERGE_FAILED", `Git could not fast-forward ${record.targetBranch}. ${update.stderr.trim()}`);
      }
    }

    if (receiptOptions !== undefined) {
      await markRunIntegration(commonDir, record, "target-moved", "target");
      try {
        await completeTasks();
        await validateGate();
        await markRunIntegration(commonDir, record, "tasks-completed", "tasks");
        receipt = await prepareFinishReceipt({
          ...receiptOptions,
          tasks: await deps.tasks(record.path).list().then((tasks) => tasks.filter(({ status }) => status !== "archived"))
        });
        await markRunIntegration(commonDir, record, "receipt-written", "receipt", receipt);
      } catch (error) {
        throw finishError("WORKTREE_FINISH_PARTIAL", `Code merged at ${mergedHead}; final task state or receipt failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // The merge happened; everything below is cleanup, reported, never undone.
    const warnings: string[] = [];
    const attempt = async (label: string, step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (error) {
        const message = `${label}: ${error instanceof Error ? error.message : String(error)}`;
        if (options.finalProof !== undefined) {
          throw finishError("WORKTREE_FINISH_PARTIAL", `Code merged at ${mergedHead} with receipt ${receipt?.path}; ${message}`);
        }
        warnings.push(message);
      }
    };
    const finishNote = `${noteText(record, tree)}${noChangeProof === undefined ? "" : "\nverified-no-change: true"}${receipt === undefined ? "" : `\nreceipt: ${receipt.path}\nreceipt-sha256: ${receipt.digest}`}`;
    await attempt("note", async () => await git(deps, mainRoot,
      ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", finishNote, mergedHead],
      "WORKTREE_NOTE_FAILED", "Git could not write the agent-ops note."));
    if (receiptOptions !== undefined) await markRunIntegration(commonDir, record, "receipt-written", "note");
    if (gateEnabled) {
      await attempt("gate", async () => {
        const mainGate = await deps.gate(mainRoot, mainConfig);
        const after = await currentGateFingerprint(mainRoot, mainRunner);
        await mainGate.rebase(before, after);
        // rebase only moves baselines equal to `before`; a main that moved since
        // this session began would leave it reading the merge as its own change.
        // Only this worktree leaves the session; its other roots stay covered.
        await mainGate.afterFinish(record.sessionId, record.path, after);
        if (options.finalProof !== undefined) {
          for (const child of sessionChildren) {
            await mainGate.afterFinish(record.sessionId, child.path, after);
          }
        }
      });
    }
    await attempt("trust", async () => await deps.trust.revoke(record.path, worktreeConfig));
    if (options.finalProof !== undefined) {
      for (const child of sessionChildren) {
        await attempt(`child ${child.name}`, async () => {
          const pinnedHead = await assertPinnedChild(child);
          await deps.trust.revoke(child.path, await deps.loadConfig(child.path));
          await removeCheckout(deps, child, false, pinnedHead);
          await markRunIntegration(commonDir, record, "receipt-written", "child:" + child.name);
        });
      }
    }
    await attempt("remove", async () => await removeCheckout(deps, record,
      options.finalProof === undefined, options.finalProof?.head));
    if (receiptOptions !== undefined) await markRunIntegration(commonDir, record, "cleaned", "coordinator");
    return { record, mergedHead, rebased: !fastForward, taskIds: tree.map(({ task }) => task.task.id), warnings,
      ...(receipt === undefined ? {} : { receipt: receipt.path }) };
  });
}
