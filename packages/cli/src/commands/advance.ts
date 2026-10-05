import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { AgentOpsError } from "../../../../runtime/src/fs/paths.js";
import { finishWorktree, type FinishDependencies } from "../../../../runtime/src/parallel/finish.js";
import { integrateSessionChildren } from "../../../../runtime/src/parallel/integrate.js";
import { readWorktreeRecord, resolveCheckouts, sessionWorktreeName, worktreePath } from "../../../../runtime/src/parallel/service.js";
import { resolveReviewScope } from "../../../../runtime/src/review/scope.js";
import { renderReviewDetails, renderReviewHighlights, type ReviewDisplayArtifact } from "../../../../runtime/src/review/render.js";
import { calculateSourceFingerprint } from "../../../../runtime/src/verify/source-fingerprint.js";
import type { GitRunner } from "../../../../runtime/src/verify/change-surface.js";
import { okEnvelope, type CliEnvelope } from "../output.js";
import { readFinishedReview } from "./review-show.js";
import {prepareRunIntegration, readRunIntegrationProof, abandonPreparedRunIntegration} from "../../../../runtime/src/run/integration.js";

interface StepEnvelope {
  readonly code: string;
  readonly status: "ok" | "error";
  readonly data?: { readonly result?: ReviewDisplayArtifact & { readonly status?: string; readonly taskId?: string };
                    readonly report?: { readonly status?: string }; readonly text?: string } | null;
  readonly errors?: readonly { readonly code: string; readonly message: string }[];
}

export type AdvanceStep = (cwd: string, args: readonly string[]) => Promise<StepEnvelope>;

/** The child process runs the existing CLI in the candidate checkout. */
export async function runAdvanceStep(cwd: string, args: readonly string[]): Promise<StepEnvelope> {
  const bin = process.argv[1];
  if (bin === undefined) throw new AgentOpsError("ADVANCE_CLI_MISSING", "Cannot locate the agent-ops CLI entry point.");
  return await new Promise((resolveStep, reject) => {
    const child = spawn(process.execPath, [resolve(bin), ...args, "--json"], {
      cwd, env: process.env, stdio: ["ignore", "pipe", "inherit"]
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as StepEnvelope;
        if (value.status !== "ok" && value.status !== "error") throw new Error("Invalid CLI envelope.");
        resolveStep(value);
      } catch {
        reject(new AgentOpsError("ADVANCE_STEP_UNREADABLE", `Could not read ${args[0]} result from the candidate checkout.`));
      }
    });
  });
}

function runner(deps: FinishDependencies, cwd: string): GitRunner {
  return { run: async (args) => {
    const result = await deps.git(cwd, args);
    return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout, "utf8") };
  } };
}

async function git(deps: FinishDependencies, cwd: string, args: readonly string[]): Promise<string> {
  const result = await deps.git(cwd, args);
  if (result.exitCode !== 0) throw new AgentOpsError("ADVANCE_GIT_FAILED", `${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function requirePass(step: StepEnvelope, label: string): void {
  if (step.status === "ok" && (step.data?.result?.status === "PASS" || step.data?.report?.status === "PASS")) return;
  const result = step.data?.result;
  const details = result?.report !== undefined || result?.attempts !== undefined
    ? `\n${renderReviewDetails([{ taskId: result.taskId ?? label, title: label, artifact: result }], "active")}`
    : step.data?.text ?? "";
  throw new AgentOpsError(step.code, `${label}: ${step.errors?.[0]?.message ?? result?.reason ?? "proof did not pass"}${details ? `\n${details}` : ""}`);
}

export async function reviewFinalTree(
  step: AdvanceStep, cwd: string, parentTaskId: string,
  taskIds: readonly string[], base: string
): Promise<"tree" | "per-task-fallback"> {
  const reviewed = await step(cwd, ["review", "--task", parentTaskId, "--tree", "--base", base, "--yes"]);
  if (reviewed.status === "error" && reviewed.data?.result?.status === "NOT_RUN" &&
      reviewed.data.result.reason === "scope-too-large") {
    for (const taskId of taskIds) {
      requirePass(await step(cwd, ["review", "--task", taskId, "--base", base, "--yes"]), `Review ${taskId}`);
    }
    return "per-task-fallback";
  }
  requirePass(reviewed, "Tree review");
  return "tree";
}

export async function runAdvanceCommand(options: {
  readonly cwd: string;
  readonly sessionId: string | undefined;
  readonly parentTaskId: string | undefined;
  readonly deps: FinishDependencies;
  readonly step?: AdvanceStep;
}): Promise<CliEnvelope<unknown>> {
  const { deps, cwd } = options;
  if (options.sessionId === undefined || options.parentTaskId === undefined) {
    throw new AgentOpsError("ADVANCE_TARGET_REQUIRED", "task advance requires --task and a current or explicit --session.");
  }
  const { mainRoot, currentRoot, commonDir } = await resolveCheckouts(deps, cwd);
  if (mainRoot !== currentRoot) throw new AgentOpsError("WORKTREE_NESTED", `Run task advance from ${mainRoot}.`);
  const name = sessionWorktreeName(options.sessionId);
  const record = await readWorktreeRecord(worktreePath(mainRoot, name));
  if (record === null || record.sessionId !== options.sessionId || record.agentId !== undefined) {
    throw new AgentOpsError("ADVANCE_WORKTREE_MISSING", `No coordinator worktree for session ${options.sessionId}.`);
  }
  const savedProof = await readRunIntegrationProof(commonDir, record);
  if (savedProof !== null && await git(deps, mainRoot, ["rev-parse", `${record.targetBranch}^{commit}`]) === savedProof.head) {
    const finished = await finishWorktree(deps, {cwd: mainRoot, name, finalProof: {...savedProof, recovery: true}});
    return okEnvelope("TASK_ADVANCED", { ...finished, text: "Recovered the sealed integration without moving the target again." });
  }
  if (savedProof !== null && await git(deps, mainRoot, ["rev-parse", `${record.targetBranch}^{commit}`]) !== savedProof.target)
    await abandonPreparedRunIntegration(commonDir, record, deps.git);
  const parent = await deps.tasks(record.path).status({ taskId: options.parentTaskId });
  if (parent.status !== "active" || parent.task.parentTaskId !== undefined) {
    throw new AgentOpsError("ADVANCE_PARENT_INVALID", "Advance requires an active root task in the coordinator worktree.");
  }
  const children = await integrateSessionChildren(deps, record, parent.task.id);
  const step = options.step ?? runAdvanceStep;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const target = await git(deps, mainRoot, ["rev-parse", `${record.targetBranch}^{commit}`]);
    const branchHead = await git(deps, record.path, ["rev-parse", "HEAD"]);
    if ((await deps.git(record.path, ["merge-base", "--is-ancestor", target, "HEAD"])).exitCode !== 0) {
      const rebase = await deps.git(record.path, ["rebase", "--rebase-merges", "--no-autostash", target]);
      if (rebase.exitCode !== 0) {
        const files = (await deps.git(record.path, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim();
        await deps.git(record.path, ["rebase", "--abort"]);
        throw new AgentOpsError("WORKTREE_REBASE_CONFLICT", `Target moved; rebase conflicted in ${files || "unknown files"}. Candidate remains at ${branchHead}.`);
      }
    }
    const head = await git(deps, record.path, ["rev-parse", "HEAD"]);
    const all = (await deps.tasks(record.path).list()).filter(({ status }) => status !== "archived");
    const selected = new Set([parent.task.id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const item of all) {
        if (item.task.parentTaskId !== undefined && selected.has(item.task.parentTaskId) && !selected.has(item.task.id)) {
          selected.add(item.task.id);
          changed = true;
        }
      }
    }
    if (selected.size !== all.length || all.some(({ task, status }) => !selected.has(task.id) || status !== "active")) {
      throw new AgentOpsError("ADVANCE_TASK_TREE_INVALID", "The candidate has unrelated or already completed tasks; final proof must cover one active tree.");
    }
    const ordered = all.filter(({ task }) => selected.has(task.id));
    const noChangePaths = head === target ? parent.noChangePaths : undefined;
    if (noChangePaths !== undefined) for (const task of ordered)
      await deps.tasks(record.path).recordEvidence(task.task.id, {}, undefined, noChangePaths);
    for (const task of ordered) {
      requirePass(await step(record.path, ["verify", "--task", task.task.id, "--base", target]), `Verify ${task.task.id}`);
    }
    const reviewMode = await reviewFinalTree(step, record.path, parent.task.id,
      ordered.map(({ task }) => task.id), target);
    const scope = await resolveReviewScope({ root: record.path, runner: runner(deps, record.path), base: target,
      ...(noChangePaths === undefined ? {} : {noChangePaths}) });
    const sourceFingerprint = await calculateSourceFingerprint(record.path, scope, runner(deps, record.path));
    const finalProof = {target, head, sourceFingerprint, children,
      ...(noChangePaths === undefined ? {} : {noChange: {sourceCommit: head,
        contractDigest: await deps.tasks(record.path).treeContract(parent.task.id), reviewScope: scope,
        artifactRefs: Object.values((await deps.tasks(record.path).status({taskId: parent.task.id})).evidence).flat()}})};
    await prepareRunIntegration(commonDir, record, finalProof);
    try {
      const finished = await finishWorktree(deps, {
        cwd: mainRoot, name,
        finalProof
      });
      if (finished.receipt === undefined) throw new AgentOpsError("WORKTREE_RECEIPT_MISSING", "Finish returned without a final review receipt.");
      const review = await readFinishedReview(deps, mainRoot, commonDir, finished.receipt);
      const highlights = renderReviewHighlights(review.entries);
      return okEnvelope("TASK_ADVANCED", {
        parentTaskId: parent.task.id,
        reviewMode,
        sourceFingerprint,
        ...finished,
        text: `Final candidate ${head} passed all task verifiers and ${reviewMode} review, then finished into ${record.targetBranch}. Receipt: ${finished.receipt}.\n${highlights}Full reports: agent-ops review show --task ${parent.task.id}`
      });
    } catch (failure) {
      if (failure instanceof AgentOpsError && failure.code === "WORKTREE_TARGET_MOVED" && attempt === 0) {
        await abandonPreparedRunIntegration(commonDir, record, deps.git);
        continue;
      }
      throw failure;
    }
  }
  throw new AgentOpsError("WORKTREE_TARGET_MOVED", "The target moved again; preserve the candidate and rerun after coordination.");
}
