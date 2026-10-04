import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { calculateConfigHash } from "../config/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { sha256 } from "../fs/hash.js";
import { resolveReviewScope } from "../review/scope.js";
import type { ReviewScope } from "../review/scope.js";
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
  /** Added for F deliveries; old markers remain valid. */
  readonly deliveryKind?: "changed" | "no-change";
  readonly sourceArtifacts?: readonly string[];
  readonly reviewScope?: string;
  readonly deliveryDigest?: string;
  readonly contractDigest?: string;
  readonly runId?: string;
  readonly workerId?: string;
  readonly workerGeneration?: number;
}

export interface NoChangeDelivery {
  readonly schemaVersion: 1;
  readonly deliveryKind: "no-change";
  readonly sourceCommit: string;
  readonly deliveryDigest: string;
  readonly contractDigest: string;
  readonly artifactRefs: readonly string[];
  readonly reviewScope: string;
  readonly runId: string;
  readonly workerId: string;
  readonly generation: number;
}

export interface IntegrationJournalStep {
  readonly name: string;
  readonly commit: string;
  readonly kind: "changed" | "no-change";
  readonly status: "prepared" | "merged" | "imported" | "recorded";
  readonly taskIds: readonly string[];
  readonly sourceArtifacts: readonly string[];
  readonly reviewScope: string | null;
  readonly deliveryDigest: string | null;
  readonly contractDigest: string | null;
}

export interface IntegrationJournal {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly expectedTarget: string;
  readonly coordinatorBefore: string;
  readonly status: "prepared" | "merging" | "importing" | "recorded" | "rolled-back";
  readonly steps: readonly IntegrationJournalStep[];
  readonly updatedAt: string;
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

function journalPath(record: WorktreeRecord): string {
  return join(record.path, ".agent-ops", "tasks", "integration-journal.json");
}

function deliveryPath(record: WorktreeRecord): string {
  return join(record.path, ".agent-ops", "tasks", "delivery.json");
}

function deliveryArchivePath(record: WorktreeRecord, child: WorktreeRecord): string {
  return join(record.path, ".agent-ops", "tasks", "deliveries", `${child.name}.json`);
}

async function readJournal(record: WorktreeRecord): Promise<IntegrationJournal | null> {
  const source = await readPrivateFile(journalPath(record), record.path);
  if (source === null) return null;
  try {
    const value = JSON.parse(source) as Partial<IntegrationJournal>;
    if (value.schemaVersion !== 1 || typeof value.transactionId !== "string" || value.transactionId.length === 0 || value.transactionId.length > 256 ||
        !/^[a-f0-9]{40,64}$/u.test(value.expectedTarget ?? "") ||
        !/^[a-f0-9]{40,64}$/u.test(value.coordinatorBefore ?? "") ||
        !["prepared", "merging", "importing", "recorded", "rolled-back"].includes(String(value.status)) ||
        !Array.isArray(value.steps) || value.steps.some((step) => typeof step !== "object" || step === null ||
          typeof (step as Partial<IntegrationJournalStep>).name !== "string" ||
          !/^[a-f0-9]{40,64}$/u.test((step as Partial<IntegrationJournalStep>).commit ?? "") ||
          !["changed", "no-change"].includes(String((step as Partial<IntegrationJournalStep>).kind)) ||
          !["prepared", "merged", "imported", "recorded"].includes(String((step as Partial<IntegrationJournalStep>).status)) ||
          !Array.isArray((step as Partial<IntegrationJournalStep>).taskIds) ||
          !Array.isArray((step as Partial<IntegrationJournalStep>).sourceArtifacts))) {
      throw new Error("invalid integration journal");
    }
    return value as IntegrationJournal;
  } catch (cause) {
    throw error("WORKTREE_INTEGRATION_JOURNAL_INVALID", "Integration journal is invalid; preserve the worktree for recovery.");
  }
}

/** Read the coordinator's durable integration transaction for finish/recovery. */
export async function readIntegrationJournal(record: WorktreeRecord): Promise<IntegrationJournal | null> {
  return await readJournal(record);
}

async function writeJournal(record: WorktreeRecord, journal: IntegrationJournal): Promise<void> {
  await mkdir(join(record.path, ".agent-ops", "tasks"), { recursive: true });
  await writePrivateFile(journalPath(record), `${JSON.stringify(journal, null, 2)}\n`, record.path);
}

/** Stable digest used by finish receipts to bind journal bookkeeping. */
export function integrationJournalDigest(journal: IntegrationJournal): string {
  return sha256(JSON.stringify(journal));
}

/** Persist a coordinator journal update so recovery can resume the same transaction. */
export async function writeIntegrationJournal(record: WorktreeRecord, journal: IntegrationJournal): Promise<void> {
  await writeJournal(record, journal);
}

async function readNoChangeDelivery(record: WorktreeRecord): Promise<NoChangeDelivery | null> {
  const source = await readPrivateFile(deliveryPath(record), record.path);
  if (source === null) return null;
  try {
    const value = JSON.parse(source) as Partial<NoChangeDelivery>;
    if (value.schemaVersion !== 1 || value.deliveryKind !== "no-change" ||
        typeof value.sourceCommit !== "string" || !/^[a-f0-9]{40,64}$/u.test(value.sourceCommit) ||
        typeof value.deliveryDigest !== "string" || !/^[a-f0-9]{40,64}$/u.test(value.deliveryDigest) ||
        typeof value.contractDigest !== "string" || !/^[a-f0-9]{40,64}$/u.test(value.contractDigest) ||
        typeof value.reviewScope !== "string" || value.reviewScope.length === 0 ||
        typeof value.runId !== "string" || typeof value.workerId !== "string" ||
        !Number.isSafeInteger(value.generation) || (value.generation as number) < 1 ||
        !Array.isArray(value.artifactRefs) || value.artifactRefs.some((ref) => typeof ref !== "string" || ref.length === 0 || ref.length > 4096 || ref.includes("\0"))) {
      throw new Error("invalid no-change delivery");
    }
    return value as NoChangeDelivery;
  } catch {
    throw error("WORKTREE_NO_CHANGE_DELIVERY_INVALID", `Child ${record.name} has an invalid no-change delivery manifest.`);
  }
}

function parseNoChangeReviewScope(value: string): ReviewScope {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch {
    throw error("WORKTREE_NO_CHANGE_SCOPE_INVALID", "No-change review scope is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw error("WORKTREE_NO_CHANGE_SCOPE_INVALID", "No-change review scope is invalid.");
  const scope = parsed as Partial<ReviewScope>;
  const safePaths = (paths: unknown): paths is readonly string[] => Array.isArray(paths) && paths.length > 0 && paths.every((path) => {
    if (typeof path !== "string" || path.length === 0 || path.includes("\\") || path.startsWith("/") || path.includes("\0")) return false;
    return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  });
  const noChange = (scope as Partial<ReviewScope> & { readonly noChange?: unknown }).noChange === true;
  if (scope.mode === "worktree" && safePaths(scope.changedFiles)) {
    return { mode: "worktree", changedFiles: scope.changedFiles, ...(noChange ? { noChange: true } : {}) } as ReviewScope;
  }
  if (scope.mode === "base" && typeof scope.baseRef === "string" && typeof scope.resolvedBase === "string" &&
      /^[a-f0-9]{40,64}$/u.test(scope.resolvedBase) && safePaths(scope.changedFiles)) {
    return { mode: "base", baseRef: scope.baseRef, resolvedBase: scope.resolvedBase, changedFiles: scope.changedFiles, ...(noChange ? { noChange: true } : {}) } as ReviewScope;
  }
  throw error("WORKTREE_NO_CHANGE_SCOPE_INVALID", "No-change review scope must list at least one safe supporting path.");
}

/** Persist a coordinator-issued no-change handoff before the worker is fenced. */
export async function writeNoChangeDelivery(
  record: WorktreeRecord,
  delivery: NoChangeDelivery
): Promise<void> {
  if (delivery.runId !== record.runId || delivery.workerId !== record.workerId || delivery.generation !== record.workerGeneration) {
    throw error("WORKTREE_NO_CHANGE_OWNERSHIP", `No-change delivery does not match worktree ${record.name}.`);
  }
  await writePrivateFile(deliveryPath(record), `${JSON.stringify(delivery, null, 2)}\n`, record.path);
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
  readonly kind: "changed" | "no-change";
  readonly sourceArtifacts: readonly string[];
  readonly reviewScope: string | null;
  readonly deliveryDigest: string | null;
  readonly contractDigest: string | null;
  readonly runId: string | null;
  readonly workerId: string | null;
  readonly workerGeneration: number | null;
}

/** Integrate only this session's agent-owned branches; local proof is never promoted as final proof. */
export async function integrateSessionChildren(
  deps: FinishDependencies,
  coordinator: WorktreeRecord,
  parentTaskId: string
): Promise<readonly IntegratedChild[]> {
  const statuses = await listWorktrees(deps, coordinator.mainRoot);
  const children = statuses.map(({ record }) => record)
    .filter((record) => record.name !== coordinator.name && record.sessionId === coordinator.sessionId &&
      (record.agentId !== undefined || (coordinator.runId !== undefined && record.runId === coordinator.runId)))
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
    const ahead = Number(await git(deps, record.path, ["rev-list", "--count", `${record.base}..${head}`]));
    const noChange = ahead === 0;
    const manifest = noChange ? await readNoChangeDelivery(record) : null;
    if (noChange && manifest === null) throw error("WORKTREE_CHILD_EMPTY", `Child ${record.name} has no committed delivery.`);
    if (coordinator.runId !== undefined &&
        (record.runId !== coordinator.runId || record.workerId === undefined || record.ownerSessionId !== coordinator.ownerSessionId || record.workerGeneration === undefined)) {
      throw error("WORKTREE_CHILD_RUN_OWNERSHIP", `Child ${record.name} is not explicitly registered to run ${coordinator.runId}.`);
    }
    if (manifest !== null && (manifest.runId !== coordinator.runId || manifest.workerId !== record.workerId || manifest.generation !== record.workerGeneration || manifest.sourceCommit !== head)) {
      throw error("WORKTREE_NO_CHANGE_OWNERSHIP", `Child ${record.name} no-change manifest does not match its registered worker and source.`);
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
    const scope = manifest === null
      ? await resolveReviewScope({ root: record.path, runner: runner(deps, record.path), base: record.base })
      : parseNoChangeReviewScope(manifest.reviewScope);
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
    deliveries.push({
      record,
      head,
      tasks,
      kind: noChange ? "no-change" : "changed",
      sourceArtifacts: manifest?.artifactRefs ?? [],
      reviewScope: manifest?.reviewScope ?? null,
      deliveryDigest: manifest?.deliveryDigest ?? null,
      contractDigest: manifest?.contractDigest ?? null,
      runId: manifest?.runId ?? record.runId ?? null,
      workerId: manifest?.workerId ?? record.workerId ?? null,
      workerGeneration: manifest?.generation ?? record.workerGeneration ?? null
    });
  }
  if (deliveries.length === 0) return integrated;
  const before = await git(deps, coordinator.path, ["rev-parse", "HEAD"]);
  const expectedTarget = await git(deps, coordinator.mainRoot, ["rev-parse", "--verify", `${coordinator.targetBranch}^{commit}`]);
  const priorJournal = await readJournal(coordinator);
  if (priorJournal !== null && priorJournal.status !== "rolled-back" &&
      priorJournal.expectedTarget !== expectedTarget && priorJournal.status !== "recorded") {
    throw error("WORKTREE_INTEGRATION_TARGET_MOVED", "The integration target moved while a journal is pending; re-run final proof.");
  }
  let journal: IntegrationJournal = priorJournal !== null && priorJournal.status !== "rolled-back"
    ? priorJournal
    : {
      schemaVersion: 1,
      transactionId: `integration-${randomUUID()}`,
      expectedTarget,
      coordinatorBefore: before,
      status: "prepared",
      steps: [],
      updatedAt: new Date().toISOString()
    };
  await writeJournal(coordinator, journal);
  if ((await collectChangeSurface(runner(deps, coordinator.path))).paths.length > 0) {
    throw error("WORKTREE_DIRTY", "Commit the candidate worktree before integrating children.");
  }
  try {
    for (const delivery of deliveries) {
      const priorStep = journal.steps.find((step) => step.name === delivery.record.name);
      if (priorStep !== undefined && priorStep.commit !== delivery.head) throw error("WORKTREE_CHILD_MOVED", `Child ${delivery.record.name} changed after its journaled delivery.`);
      if (priorStep?.status === "recorded") continue;
      const step: IntegrationJournalStep = {
        name: delivery.record.name,
        commit: delivery.head,
        kind: delivery.kind,
        status: "prepared",
        taskIds: delivery.tasks.map(({ task }) => task.id),
        sourceArtifacts: delivery.sourceArtifacts,
        reviewScope: delivery.reviewScope,
        deliveryDigest: delivery.deliveryDigest,
        contractDigest: delivery.contractDigest
      };
      journal = { ...journal, status: "merging", steps: [...journal.steps.filter((candidate) => candidate.name !== delivery.record.name), step], updatedAt: new Date().toISOString() };
      await writeJournal(coordinator, journal);
      if (delivery.kind === "changed" && (await deps.git(coordinator.path, ["merge-base", "--is-ancestor", delivery.head, "HEAD"])).exitCode !== 0) {
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
      journal = {
        ...journal,
        status: "merging",
        steps: journal.steps.map((candidate) => candidate.name === delivery.record.name ? { ...candidate, status: "merged" } : candidate),
        updatedAt: new Date().toISOString()
      };
      await writeJournal(coordinator, journal);
    }
    journal = { ...journal, status: "importing", updatedAt: new Date().toISOString() };
    await writeJournal(coordinator, journal);
    await deps.tasks(coordinator.path).importDelivery(parentTaskId, deliveries.flatMap(({ tasks }) => tasks));
    for (const delivery of deliveries) {
      if (delivery.sourceArtifacts.length > 0) {
        const manifest = await readPrivateFile(deliveryPath(delivery.record), delivery.record.path);
        if (manifest !== null) {
          await mkdir(join(coordinator.path, ".agent-ops", "tasks", "deliveries"), { recursive: true });
          await writePrivateFile(deliveryArchivePath(coordinator, delivery.record), manifest, coordinator.path);
        }
      }
    }
    journal = { ...journal, status: "recorded", steps: journal.steps.map((step) => ({ ...step, status: "recorded" })), updatedAt: new Date().toISOString() };
    await writeJournal(coordinator, journal);
    const next = [...integrated, ...deliveries.map(({ record, head, tasks, kind, sourceArtifacts, reviewScope, deliveryDigest, contractDigest, runId, workerId, workerGeneration }) => ({
      name: record.name,
      commit: head,
      taskIds: tasks.map(({ task }) => task.id),
      ...(kind === "no-change" ? {
        deliveryKind: kind,
        ...(sourceArtifacts.length === 0 ? {} : { sourceArtifacts }),
        ...(reviewScope === null ? {} : { reviewScope }),
        ...(deliveryDigest === null ? {} : { deliveryDigest }),
        ...(contractDigest === null ? {} : { contractDigest }),
        ...(runId === null ? {} : { runId }),
        ...(workerId === null ? {} : { workerId }),
        ...(workerGeneration === null ? {} : { workerGeneration })
      } : {
        ...(runId === null ? {} : { runId }),
        ...(workerId === null ? {} : { workerId }),
        ...(workerGeneration === null ? {} : { workerGeneration })
      })
    }))];
    await writePrivateFile(markerPath(coordinator), `${JSON.stringify(next, null, 2)}\n`, coordinator.path);
    return next;
  } catch (failure) {
    await deps.git(coordinator.path, ["merge", "--abort"]);
    await deps.git(coordinator.path, ["reset", "--hard", before]);
    await writeJournal(coordinator, { ...journal, status: "rolled-back", updatedAt: new Date().toISOString() });
    throw failure;
  }
}
