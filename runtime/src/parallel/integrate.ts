import { join } from "node:path";

import { calculateConfigHash } from "../config/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { resolveReviewScope } from "../review/scope.js";
import { readPrivateFile, writePrivateFile } from "../security/permissions.js";
import { checkTaskVerificationEvidence } from "../task/completion.js";
import type { StoredTaskRecord } from "../task/store.js";
import { FileEvidenceStore } from "../verify/evidence.js";
import { calculateSourceFingerprint } from "../verify/source-fingerprint.js";
import { collectChangeSurface, type GitRunner } from "../verify/change-surface.js";
import { listWorktrees } from "./manage.js";
import type { FinishDependencies } from "./finish.js";
import type { WorktreeRecord } from "./service.js";

export interface IntegratedChild {
  readonly name: string;
  readonly commit: string;
  readonly taskIds: readonly string[];
}

function error(code: string, message: string): AgentOpsError {
  return new AgentOpsError(code, message);
}

async function git(deps: FinishDependencies, cwd: string, args: readonly string[]): Promise<string> {
  const result = await deps.git(cwd, args);
  if (result.exitCode !== 0) throw error("WORKTREE_INTEGRATION_FAILED", `${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function runner(deps: FinishDependencies, cwd: string): GitRunner {
  return { run: async (args) => {
    const result = await deps.git(cwd, args);
    return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout, "utf8") };
  } };
}

function markerPath(record: WorktreeRecord): string {
  return join(record.path, ".agent-ops", "tasks", "integrated-children.json");
}

async function previous(record: WorktreeRecord): Promise<IntegratedChild[]> {
  const source = await readPrivateFile(markerPath(record), record.path);
  if (source === null) return [];
  let value: unknown;
  try { value = JSON.parse(source) as unknown; } catch { value = null; }
  if (!Array.isArray(value) || value.some((item) =>
    typeof item !== "object" || item === null ||
    typeof item.name !== "string" || typeof item.commit !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test(item.commit) ||
    !Array.isArray(item.taskIds) || item.taskIds.some((id: unknown) => typeof id !== "string"))) {
    throw error("WORKTREE_INTEGRATION_STATE_INVALID", "Child integration record is invalid.");
  }
  return value as IntegratedChild[];
}

interface Delivery {
  readonly record: WorktreeRecord;
  readonly head: string;
  readonly tasks: readonly StoredTaskRecord[];
}

/** Integrate only this session's agent-owned branches; local proof is never promoted as final proof. */
export async function integrateSessionChildren(
  deps: FinishDependencies,
  coordinator: WorktreeRecord,
  parentTaskId: string
): Promise<readonly IntegratedChild[]> {
  const statuses = await listWorktrees(deps, coordinator.mainRoot);
  const children = statuses.map(({ record }) => record)
    .filter((record) => record.sessionId === coordinator.sessionId && record.agentId !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
  const integrated = await previous(coordinator);
  if (children.length === 0) return integrated;
  const config = await deps.loadConfig(coordinator.path);
  const configHash = calculateConfigHash(config);
  const deliveries: Delivery[] = [];
  const existing = new Map(integrated.map((item) => [item.name, item]));
  for (const record of children) {
    if (record.mainRoot !== coordinator.mainRoot || record.targetBranch !== coordinator.targetBranch ||
        record.name === coordinator.name ||
        await git(deps, record.path, ["symbolic-ref", "--short", "HEAD"]) !== record.branch) {
      throw error("WORKTREE_CHILD_MISMATCH", `Child ${record.name} does not belong to this candidate branch.`);
    }
    if ((await collectChangeSurface(runner(deps, record.path))).paths.length > 0) {
      throw error("WORKTREE_CHILD_DIRTY", `Commit the changes in child ${record.name} before integration.`);
    }
    const head = await git(deps, record.path, ["rev-parse", "HEAD"]);
    const prior = existing.get(record.name);
    if (prior !== undefined) {
      if (prior.commit !== head) throw error("WORKTREE_CHILD_MOVED", `Child ${record.name} changed after delivery; keep its worktree and replan integration.`);
      continue;
    }
    if ((await deps.git(record.path, ["merge-base", "--is-ancestor", record.base, head])).exitCode !== 0 ||
        Number(await git(deps, record.path, ["rev-list", "--count", `${record.base}..${head}`])) === 0) {
      throw error("WORKTREE_CHILD_EMPTY", `Child ${record.name} has no committed delivery.`);
    }
    const childConfig = await deps.loadConfig(record.path);
    if (calculateConfigHash(childConfig) !== configHash) {
      throw error("WORKTREE_CHILD_CONFIG_CHANGED", `Child ${record.name} uses a different verifier policy.`);
    }
    const tasks = await deps.tasks(record.path).list();
    const roots = tasks.filter(({ task }) => task.parentTaskId === undefined);
    if (roots.length !== 1 || tasks.some(({ status }) => status === "archived")) {
      throw error("WORKTREE_CHILD_TASK_INVALID", `Child ${record.name} must deliver one active task tree.`);
    }
    const scope = await resolveReviewScope({ root: record.path, runner: runner(deps, record.path), base: record.base });
    const fingerprint = await calculateSourceFingerprint(record.path, scope, runner(deps, record.path));
    for (const task of tasks) {
      if (task.task.intent === undefined || task.task.intent.trim() === "") {
        throw error("WORKTREE_CHILD_INTENT_MISSING", `Child task ${task.task.id} needs its pre-work modification intent.`);
      }
      const problem = await checkTaskVerificationEvidence(task, {
        root: record.path, config: childConfig, sourceFingerprint: fingerprint,
        evidenceStore: new FileEvidenceStore(record.path, record.path)
      });
      if (problem !== null) {
        throw error("WORKTREE_CHILD_UNVERIFIED", `Child task ${task.task.id}: ${problem.remedy}`);
      }
    }
    deliveries.push({ record, head, tasks });
  }
  if (deliveries.length === 0) return integrated;
  const before = await git(deps, coordinator.path, ["rev-parse", "HEAD"]);
  if ((await collectChangeSurface(runner(deps, coordinator.path))).paths.length > 0) {
    throw error("WORKTREE_DIRTY", "Commit the candidate worktree before integrating children.");
  }
  try {
    for (const delivery of deliveries) {
      if ((await deps.git(coordinator.path, ["merge-base", "--is-ancestor", delivery.head, "HEAD"])).exitCode !== 0) {
        const merge = await deps.git(coordinator.path, ["merge", "--no-ff", "--no-edit", delivery.head]);
        if (merge.exitCode !== 0) {
          const files = (await deps.git(coordinator.path, ["diff", "--name-only", "--diff-filter=U"])).stdout.trim();
          await deps.git(coordinator.path, ["merge", "--abort"]);
          throw error("WORKTREE_INTEGRATION_CONFLICT", `Child ${delivery.record.name} conflicts in ${files || "unknown files"}. Resolve both recorded intents before retrying.`);
        }
      }
      if (await git(deps, delivery.record.path, ["rev-parse", "HEAD"]) !== delivery.head) {
        throw error("WORKTREE_CHILD_MOVED", `Child ${delivery.record.name} moved during integration.`);
      }
    }
    await deps.tasks(coordinator.path).importDelivery(parentTaskId, deliveries.flatMap(({ tasks }) => tasks));
    const next = [...integrated, ...deliveries.map(({ record, head, tasks }) => ({
      name: record.name, commit: head, taskIds: tasks.map(({ task }) => task.id)
    }))];
    await writePrivateFile(markerPath(coordinator), `${JSON.stringify(next, null, 2)}\n`, coordinator.path);
    return next;
  } catch (failure) {
    await deps.git(coordinator.path, ["merge", "--abort"]);
    await deps.git(coordinator.path, ["reset", "--hard", before]);
    throw failure;
  }
}
