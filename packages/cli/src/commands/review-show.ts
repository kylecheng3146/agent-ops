import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256 } from "../../../../runtime/src/fs/hash.js";
import { AgentOpsError } from "../../../../runtime/src/fs/paths.js";
import { listWorktrees } from "../../../../runtime/src/parallel/manage.js";
import type { FinishDependencies } from "../../../../runtime/src/parallel/finish.js";
import type { FinishReceipt } from "../../../../runtime/src/parallel/receipt.js";
import { NOTES_REF, resolveCheckouts } from "../../../../runtime/src/parallel/service.js";
import { REVIEW_ATTESTATION_DIRECTORY, REVIEW_REPORT_ARTIFACT_SUFFIX,
  type ReviewReportArtifact } from "../../../../runtime/src/review/attestation.js";
import { renderReviewDetails, type ReviewDisplayEntry } from "../../../../runtime/src/review/render.js";
import { validateReviewReport } from "../../../../runtime/src/review/report.js";
import { resolveReviewScope } from "../../../../runtime/src/review/scope.js";
import { readPrivateFile } from "../../../../runtime/src/security/permissions.js";
import { calculateSourceFingerprint } from "../../../../runtime/src/verify/source-fingerprint.js";
import type { GitRunner } from "../../../../runtime/src/verify/change-surface.js";
import { okEnvelope, type CliEnvelope } from "../output.js";

export interface ReviewView {
  readonly mode: "tree" | "per-task-fallback" | "active";
  readonly candidateHead: string;
  readonly sourceFingerprint?: string;
  readonly entries: readonly ReviewDisplayEntry[];
  readonly receipt?: string;
}

function invalid(message: string): never {
  throw new AgentOpsError("REVIEW_RECORD_INVALID", message);
}

function checkedArtifact(value: unknown, fingerprint: string, taskId: string): ReviewReportArtifact {
  if (typeof value !== "object" || value === null) invalid("Review artifact is unreadable.");
  const artifact = value as ReviewReportArtifact;
  if (!([1, 2] as const).includes(artifact.schemaVersion) || artifact.sourceFingerprint !== fingerprint ||
      artifact.taskId !== taskId || !["PASS", "FAIL", "NOT_RUN"].includes(artifact.status) ||
      !Array.isArray(artifact.attempts) ||
      (artifact.report !== undefined && !validReport(artifact.report, artifact)) ||
      (artifact.adversarial !== undefined && !validReport(artifact.adversarial.report, artifact))) {
    invalid(`Review artifact for ${taskId} does not match the candidate.`);
  }
  return artifact;
}

function validReport(report: ReviewReportArtifact["report"], artifact: ReviewReportArtifact): boolean {
  const ids = artifact.tree?.criterionIds ?? report?.results?.map(({ criterionId }) => criterionId);
  return ids !== undefined && validateReviewReport(report, ids).ok;
}

function entriesFromReceipt(receipt: FinishReceipt): ReviewDisplayEntry[] {
  const records = receipt.reviewMode === "tree"
    ? [receipt.tasks.find(({ task }) => task.parentTaskId === undefined) ?? receipt.tasks[0]!]
    : receipt.tasks;
  return records.map(({ task }) => {
    const sealed = receipt.reviews[task.id]?.report;
    if (sealed === undefined || sha256(JSON.stringify(sealed.value)) !== sealed.digest) {
      invalid(`Review evidence for ${task.id} is missing or changed.`);
    }
    return { taskId: task.id, title: task.title,
      artifact: checkedArtifact(sealed.value, receipt.sourceFingerprint, task.id) };
  });
}

/** The note binds the private receipt to the merged commit and its exact bytes. */
export async function readFinishedReview(
  deps: FinishDependencies, mainRoot: string, commonDir: string, path: string
): Promise<ReviewView> {
  if (dirname(path) !== join(commonDir, "agent-ops", "receipts")) invalid("Final review receipt path is outside the receipt directory.");
  const source = await readPrivateFile(path, commonDir);
  if (source === null) invalid("Final review receipt is missing.");
  let receipt: FinishReceipt;
  try { receipt = JSON.parse(source) as FinishReceipt; }
  catch { return invalid("Final review receipt is malformed."); }
  if (receipt.schemaVersion !== 1 || !/^[a-f0-9]{40,64}$/u.test(receipt.candidateHead) ||
      !Array.isArray(receipt.tasks) || receipt.tasks.length === 0 ||
      !["tree", "per-task-fallback"].includes(receipt.reviewMode) ||
      typeof receipt.reviews !== "object" || receipt.reviews === null) {
    invalid("Final review receipt is invalid.");
  }
  const note = await deps.git(mainRoot, ["notes", `--ref=${NOTES_REF}`, "show", receipt.candidateHead]);
  const binding = `\nreceipt: ${path}\nreceipt-sha256: ${sha256(source)}`;
  if (note.exitCode !== 0 || !note.stdout.trimEnd().endsWith(binding)) {
    invalid("Final review receipt does not match its Git note.");
  }
  return { mode: receipt.reviewMode, candidateHead: receipt.candidateHead,
    sourceFingerprint: receipt.sourceFingerprint, entries: entriesFromReceipt(receipt), receipt: path };
}

async function finishedPath(commonDir: string, taskId: string): Promise<string | null> {
  const directory = join(commonDir, "agent-ops", "receipts");
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  let latest: { path: string; createdAt: string } | null = null;
  for (const name of names.filter((item) => /^[a-f0-9]{64}-[a-f0-9]{40,64}\.json$/u.test(item))) {
    const path = join(directory, name);
    const source = await readPrivateFile(path, commonDir);
    if (source === null) continue;
    try {
      const receipt = JSON.parse(source) as FinishReceipt;
      if (!Array.isArray(receipt.tasks) || !receipt.tasks.some(({ task }) => task.id === taskId)) continue;
      if (latest === null || receipt.createdAt > latest.createdAt) latest = { path, createdAt: receipt.createdAt };
    } catch { /* An unrelated malformed receipt cannot name this task. */ }
  }
  return latest?.path ?? null;
}

function runner(deps: FinishDependencies, cwd: string): GitRunner {
  return { run: async (args) => {
    const result = await deps.git(cwd, args);
    return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout, "utf8") };
  } };
}

async function activeReview(deps: FinishDependencies, mainRoot: string, taskId: string): Promise<ReviewView | null> {
  const matching = [];
  for (const { record } of await listWorktrees(deps, mainRoot)) {
    const records = await deps.tasks(record.path).list();
    if (records.some(({ task }) => task.id === taskId)) matching.push({ record, records });
  }
  if (matching.length > 1) invalid(`Task ${taskId} exists in more than one active worktree.`);
  const current = matching[0];
  if (current === undefined) return null;
  const { record, records } = current;
  const headResult = await deps.git(record.path, ["rev-parse", "HEAD"]);
  if (headResult.exitCode !== 0) invalid("Cannot read the active candidate HEAD.");
  const candidateHead = headResult.stdout.trim();
  const selected = new Set([taskId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const { task } of records) {
      if (task.parentTaskId !== undefined && selected.has(task.parentTaskId) && !selected.has(task.id)) {
        selected.add(task.id);
        changed = true;
      }
    }
  }
  const tree = [records.find(({ task }) => task.id === taskId)!,
    ...records.filter(({ task }) => selected.has(task.id) && task.id !== taskId)];
  const target = await deps.git(mainRoot, ["rev-parse", `${record.targetBranch}^{commit}`]);
  if (target.exitCode !== 0) invalid("Cannot read the target branch for the active candidate.");
  let fingerprint: string | undefined;
  try {
    const scope = await resolveReviewScope({ root: record.path, runner: runner(deps, record.path), base: target.stdout.trim() });
    fingerprint = await calculateSourceFingerprint(record.path, scope, runner(deps, record.path));
  } catch (error) {
    if (error instanceof AgentOpsError && error.code === "REVIEW_DIRTY_WORKTREE") {
      try {
        const scope = await resolveReviewScope({ root: record.path, runner: runner(deps, record.path) });
        fingerprint = await calculateSourceFingerprint(record.path, scope, runner(deps, record.path));
      } catch { /* No report for this source state. */ }
    }
  }
  const entries: ReviewDisplayEntry[] = [];
  for (const { task } of tree) {
    let artifact: ReviewReportArtifact | null = null;
    if (fingerprint !== undefined) {
      const source = await readPrivateFile(join(record.path, REVIEW_ATTESTATION_DIRECTORY,
        `${fingerprint}.${task.id}${REVIEW_REPORT_ARTIFACT_SUFFIX}`), record.path);
      if (source !== null) {
        try { artifact = checkedArtifact(JSON.parse(source) as unknown, fingerprint, task.id); }
        catch (error) {
          if (error instanceof AgentOpsError) throw error;
          invalid(`Review artifact for ${task.id} is malformed.`);
        }
      }
    }
    entries.push({ taskId: task.id, title: task.title, artifact });
  }
  // A failed whole-tree review writes one parent artifact; its criterion IDs
  // already cover the whole tree, so do not print empty child aliases.
  const first = entries[0];
  const wholeTree = first?.artifact?.report?.results.some(({ criterionId }) => criterionId.includes(":"));
  return { mode: "active", candidateHead, ...(fingerprint === undefined ? {} : { sourceFingerprint: fingerprint }),
    entries: wholeTree ? [first!] : entries };
}

export async function runReviewShowCommand(options: {
  readonly cwd: string; readonly taskId: string; readonly deps: FinishDependencies;
}): Promise<CliEnvelope<unknown>> {
  const { mainRoot, commonDir } = await resolveCheckouts(options.deps, options.cwd);
  const active = await activeReview(options.deps, mainRoot, options.taskId);
  const path = active === null ? await finishedPath(commonDir, options.taskId) : null;
  const view = active ?? (path === null ? null : await readFinishedReview(options.deps, mainRoot, commonDir, path));
  if (view === null) throw new AgentOpsError("REVIEW_TASK_NOT_FOUND", `No active or finished review task ${options.taskId}.`);
  return okEnvelope("REVIEW_SHOWN", { ...view,
    text: `Candidate: ${view.candidateHead}\n${renderReviewDetails(view.entries, view.mode)}` });
}
