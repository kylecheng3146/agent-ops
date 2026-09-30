import { AgentOpsError } from "../../../../runtime/src/fs/paths.js";
import {
  DEFAULT_BATCH_WIDTH,
  runBatch,
  type BatchReview,
  type BatchTaskOutcome,
  type BatchVerifyStatus
} from "../../../../runtime/src/review/batch.js";
import {
  resolveBatchBase,
  selectBatchTasks,
  type BatchBaseSource
} from "../../../../runtime/src/review/batch-select.js";
import { redactSecrets } from "../../../../runtime/src/security/redact.js";
import { safeTaskText } from "../../../../runtime/src/task/render.js";
import type { StoredTaskRecord } from "../../../../runtime/src/task/store.js";
import type { ParsedArgs } from "../args.js";
import { errorEnvelope, type CliEnvelope } from "../output.js";

export interface BatchCommandOptions {
  readonly args: ParsedArgs;
  readonly tasks: { list(): Promise<readonly StoredTaskRecord[]> };
  /** The worktree's own base, the fallback for a task with no recorded base. */
  readonly worktreeBase?: string;
  /** False once HEAD or the working tree differs from where the batch began. */
  readonly guard: () => Promise<boolean>;
  readonly isVerified: (taskId: string, base: string) => Promise<boolean>;
  readonly verify: (taskId: string, base: string, signal: AbortSignal) => Promise<"PASS" | "FAIL">;
  readonly review: (taskId: string, base: string, signal: AbortSignal) => Promise<BatchReview>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (line: string) => void;
}

export interface BatchTaskReport {
  readonly taskId: string;
  readonly title: string;
  readonly base: string;
  readonly baseSource: BatchBaseSource;
  readonly verify: BatchVerifyStatus;
  readonly review: BatchReview | null;
  readonly retried: boolean;
  readonly aborted: boolean;
}

export interface BatchCommandData {
  readonly message: string;
  readonly parentTaskId: string;
  readonly width: number;
  readonly tasks: readonly BatchTaskReport[];
  readonly text: string;
}

function outcomeLabel(task: BatchTaskReport): string {
  if (task.aborted) {
    return "aborted";
  }
  if (task.review === null) {
    return task.verify === "FAIL" ? "no review (verify failed)" : "not reviewed";
  }
  const reason = task.review.reason === undefined ? "" : ` ${task.review.reason}`;
  return `${task.review.status}${reason}${task.review.reused === true ? " (reused)" : ""}${task.retried ? " (retried)" : ""}`;
}

function renderBatch(data: Omit<BatchCommandData, "text">): string {
  const lines = [
    `Batch of ${data.tasks.length} task(s) under ${data.parentTaskId}, width ${data.width}.`,
    "",
    ...data.tasks.map((task) =>
      `- ${task.taskId}  verify ${task.verify}  review ${outcomeLabel(task)}  base ${task.base.slice(0, 12)} (${task.baseSource})  ${safeTaskText(redactSecrets(task.title))}`
    )
  ];
  if (data.tasks.some((task) => task.aborted)) {
    lines.push("", "The source changed or the run was interrupted; unfinished tasks were aborted. Run the batch again.");
  }
  return lines.join("\n");
}

function isPass(task: BatchTaskReport): boolean {
  return !task.aborted && task.review?.status === "PASS";
}

/**
 * The envelope's code follows the worst outcome that needs a human: a failed
 * verify or review (fix the code) before a run that could not finish (run it
 * again), so one defect is never hidden behind an unrelated NOT_RUN.
 */
function classify(tasks: readonly BatchTaskReport[]): "BATCH_RESULT" | "BATCH_FAILED" | "BATCH_NOT_RUN" {
  if (tasks.every(isPass)) {
    return "BATCH_RESULT";
  }
  return tasks.some((task) => task.verify === "FAIL" || task.review?.status === "FAIL")
    ? "BATCH_FAILED"
    : "BATCH_NOT_RUN";
}

export async function runBatchCommand(
  options: BatchCommandOptions
): Promise<CliEnvelope<BatchCommandData>> {
  const { args } = options;
  const parentTaskId = args.parentTaskId;
  if (parentTaskId === undefined) {
    throw new AgentOpsError("BATCH_PARENT_REQUIRED", "Batch requires --parent.");
  }
  const selected = selectBatchTasks(await options.tasks.list(), parentTaskId);
  const plan = selected.map((record) => ({
    record,
    ...resolveBatchBase(record, record.task.id === parentTaskId, {
      ...(args.base === undefined ? {} : { base: args.base }),
      ...(args.parentBase === undefined ? {} : { parentBase: args.parentBase }),
      ...(options.worktreeBase === undefined ? {} : { worktreeBase: options.worktreeBase })
    })
  }));
  const baseOf = new Map(plan.map((item) => [item.record.task.id, item.base]));
  const base = (id: string): string => baseOf.get(id)!;

  // The first answer is the clean-tree check: a batch reviews committed ranges.
  if (!await options.guard()) {
    return {
      ...errorEnvelope(
        "BATCH_DIRTY_WORKTREE",
        "Batch needs a clean working tree. Commit or discard your changes first."
      ),
      data: null
    } as CliEnvelope<BatchCommandData>;
  }

  const width = args.width ?? DEFAULT_BATCH_WIDTH;
  const outcomes = await runBatch(
    plan.map((item) => item.record.task.id),
    {
      isVerified: (id) => options.isVerified(id, base(id)),
      verify: (id, signal) => options.verify(id, base(id), signal),
      review: (id, signal) => options.review(id, base(id), signal),
      guard: options.guard
    },
    {
      width,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress })
    }
  );
  const byId = new Map<string, BatchTaskOutcome>(outcomes.map((outcome) => [outcome.id, outcome]));
  const tasks: BatchTaskReport[] = plan.map((item) => {
    const outcome = byId.get(item.record.task.id)!;
    return {
      taskId: item.record.task.id,
      title: item.record.task.title,
      base: item.base,
      baseSource: item.source,
      verify: outcome.verify,
      review: outcome.review,
      retried: outcome.retried,
      aborted: outcome.aborted
    };
  });
  const code = classify(tasks);
  const passed = tasks.filter(isPass).length;
  const message = code === "BATCH_RESULT"
    ? `Batch passed: ${passed} of ${tasks.length} task(s).`
    : code === "BATCH_FAILED"
      ? `Batch failed: ${passed} of ${tasks.length} task(s) passed.`
      : `Batch was not completed: ${passed} of ${tasks.length} task(s) passed.`;
  const summary = { message, parentTaskId, width, tasks };
  const data: BatchCommandData = { ...summary, text: `${message}\n\n${renderBatch(summary)}` };
  if (code === "BATCH_RESULT") {
    return { code, status: "ok", data, errors: [] };
  }
  return { code, status: "error", data, errors: [{ code, message }] };
}
