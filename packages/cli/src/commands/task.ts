import { lstat, readFile } from "node:fs/promises";
import { taskContractHash } from "../../../../runtime/src/task/contract.js";
import type {
  AcceptanceCriterion
} from "../../../../runtime/src/contracts.js";
import { AgentOpsError } from "../../../../runtime/src/fs/paths.js";
import {
  renderTaskMarkdown,
  safeTaskText
} from "../../../../runtime/src/task/render.js";
import type {
  CriterionEvidenceInput,
  TaskService
} from "../../../../runtime/src/task/service.js";
import type {
  StoredTaskRecord
} from "../../../../runtime/src/task/store.js";
import type { ParsedArgs, TaskAction } from "../args.js";
import {
  errorEnvelope,
  okEnvelope,
  type CliEnvelope
} from "../output.js";

export interface TaskCommandOptions {
  readonly args: ParsedArgs;
  readonly service: TaskService;
  readonly sessionId?: string;
  readonly policyConfigHash?: string;
  /**
   * Worktree auto mode from the main checkout: the session's worktree,
   * created or reused, whose task store a new task belongs in.
   */
  readonly sessionWorktree?: (sessionId: string) => Promise<{
    readonly service: TaskService;
    readonly path: string;
    readonly base: string;
  }>;
}

export interface TaskCommandData {
  readonly action: TaskAction;
  readonly message: string;
  readonly pendingCriterion?: AcceptanceCriterion;
  readonly record?: StoredTaskRecord;
  readonly contractHash?: string;
  readonly treeContractHash?: string;
  readonly coverage?: Awaited<ReturnType<TaskService["coverage"]>>;
  readonly records?: readonly StoredTaskRecord[];
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCriterion(source: string): AcceptanceCriterion {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new AgentOpsError(
      "TASK_CRITERION_INVALID",
      "Each --criterion value must be a JSON criterion object."
    );
  }
  if (!isRecord(value)) throw new AgentOpsError("TASK_CRITERION_INVALID", "Criterion must be an object.");
  // TaskService normalizes the creation baseline, then uses the shared strict validator.
  return value as unknown as AcceptanceCriterion;
}

async function jsonFile(path: string): Promise<unknown> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size > 65536)
    throw new AgentOpsError("TASK_PAYLOAD_INVALID", "Payload must be a regular JSON file at most 64 KiB.");
  try { return JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch { throw new AgentOpsError("TASK_PAYLOAD_INVALID", "Invalid JSON payload."); }
}

function parseEvidence(
  values: readonly string[]
): CriterionEvidenceInput {
  const evidence: Record<string, string[]> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new AgentOpsError(
        "TASK_EVIDENCE_INVALID",
        "Each --evidence value must use criterion-id=reference."
      );
    }
    const criterionId = value.slice(0, separator);
    const reference = value.slice(separator + 1);
    const references = evidence[criterionId] ?? [];
    references.push(reference);
    evidence[criterionId] = references;
  }
  return evidence;
}

function requireTaskId(args: ParsedArgs): string {
  if (args.taskId === undefined) {
    throw new AgentOpsError(
      "TASK_ID_REQUIRED",
      "This task action requires --task <id>."
    );
  }
  return args.taskId;
}

function taskAction(args: ParsedArgs): TaskAction {
  if (
    args.command !== "task" ||
    args.action === undefined ||
    ![
      "archive",
      "attach",
      "complete",
      "create",
      "export",
      "status", "revise", "replan", "pin-finding"
    ].includes(args.action)
  ) {
    throw new AgentOpsError(
      "TASK_ACTION_INVALID",
      "A supported task action is required."
    );
  }
  return args.action as TaskAction;
}

function taskEnvelope(
  action: TaskAction,
  code: string,
  message: string,
  record: StoredTaskRecord
): CliEnvelope<TaskCommandData> {
  return okEnvelope(code, {
    action,
    message,
    record,
    contractHash: taskContractHash(record.task),
    text: renderTaskMarkdown(record) + "\nContract: " + taskContractHash(record.task)
  });
}

function renderTaskList(records: readonly StoredTaskRecord[]): string {
  if (records.length === 0) {
    return "No tasks.\n";
  }
  return `${records
    .map(
      (record) =>
        `- ${record.task.id} [${record.status}] ${safeTaskText(
          record.task.title
        )}`
    )
    .join("\n")}\n`;
}

export async function runTaskCommand(
  options: TaskCommandOptions
): Promise<CliEnvelope<TaskCommandData | null>> {
  try {
    const action = taskAction(options.args);
    const sessionId = options.args.sessionId ?? options.sessionId;
    if (action === "create") {
      if (options.args.title === undefined) {
        throw new AgentOpsError(
          "TASK_TITLE_REQUIRED",
          "Task creation requires --title."
        );
      }
      const worktree = sessionId === undefined || options.sessionWorktree === undefined
        ? undefined
        : await options.sessionWorktree(sessionId);
      const record = await (worktree?.service ?? options.service).create({
        title: options.args.title,
        ...(options.args.intent === undefined ? {} : { intent: options.args.intent }),
        criteria: [...(options.args.criteria ?? []).map(parseCriterion),
          ...await Promise.all((options.args.criterionFiles ?? []).map(async path => await jsonFile(path) as AcceptanceCriterion))]
          .map(c => c.acceptance === undefined || options.args.baseline === undefined ? c :
            {...c, acceptance: {...c.acceptance, baselineCommit: c.acceptance.baselineCommit ?? options.args.baseline}}),
        ...(options.policyConfigHash === undefined
          ? {}
          : { policyConfigHash: options.policyConfigHash }),
        ...(options.args.parentTaskId === undefined
          ? {}
          : { parentTaskId: options.args.parentTaskId }),
        ...(sessionId === undefined ? {} : { sessionId })
      });
      const created = taskEnvelope(
        action,
        "TASK_CREATED",
        sessionId === undefined
          ? `Created task ${record.task.id}.`
          : record.task.parentTaskId === undefined
            ? `Created and attached task ${record.task.id}.`
            : `Created subtask ${record.task.id}; the session stays on the top of its task tree.`,
        record
      );
      if (worktree === undefined || created.data === null) return created;
      return {
        ...created,
        data: {
          ...created.data,
          text: [
            `Created in this session's worktree ${worktree.path}.`,
            "Work only inside that path from now on:",
            `- Claude Code: EnterWorktree with path ${worktree.path}`,
            `- Codex and agy: run every command with ${worktree.path} as its working directory`,
            `Commit, then run verify and review there with --base ${worktree.base};`,
            "then leave the worktree (Claude Code: ExitWorktree with action keep) and run",
            "agent-ops worktree finish from the main checkout, which completes the task and merges.",
            "",
            created.data.text
          ].join("\n")
        }
      };
    }
    if (action === "revise") {
      const payload = await jsonFile(options.args.criteriaFile!);
      if (!Array.isArray(payload)) throw new AgentOpsError("TASK_PAYLOAD_INVALID", "Criteria file must contain an array.");
      const record = await options.service.revise(requireTaskId(options.args), {
        expectedContractHash: options.args.expectedContract!, criteria: payload as AcceptanceCriterion[],
        reason: options.args.reason!, ...(options.args.baseline === undefined ? {} : {baseline: options.args.baseline})
      });
      return taskEnvelope(action, "TASK_REVISED", "Contract revised; obtain new verification and fresh review.", record);
    }
    if (action === "replan") {
      const payload = await jsonFile(options.args.planFile!);
      if (!Array.isArray(payload)) throw new AgentOpsError("TASK_PAYLOAD_INVALID", "Plan file must contain split task objects.");
      const records = await options.service.replan(requireTaskId(options.args), {
        expectedTreeContractHash: options.args.expectedTreeContract!, reason: options.args.reason!,
        tasks: payload as Parameters<TaskService["replan"]>[1]["tasks"]
      });
      return okEnvelope("TASK_REPLANNED", {action, message: "Task tree split atomically; reverify and review.", records, text: renderTaskList(records)});
    }
    if (action === "pin-finding") {
      const criterion = parseCriterion(JSON.stringify(await jsonFile(options.args.criterionFiles![0]!)));
      const pinned = await options.service.pinFinding(requireTaskId(options.args), options.args.expectedContract!, options.args.findingReference!, criterion, options.args.reason);
      if (pinned.record === null) return {code: "NEEDS_REPLAN", status: "error",
        data: {action, message: "Pin requires atomic replan to retain two to five criteria.", pendingCriterion: pinned.pendingCriterion, text: "NEEDS_REPLAN: include the pending criterion in task replan; no task was changed."},
        errors: [{code: "NEEDS_REPLAN", message: "Replan the full current tree and pending pin."}]};
      return taskEnvelope(action, "TASK_FINDING_PINNED", "Pinned saved finding; reverify and review the new contract.", pinned.record);
    }
    if (action === "status") {
      if (options.args.taskId === undefined && sessionId === undefined) {
        const parentTaskId = options.args.parentTaskId;
        const records = await options.service.list(
          parentTaskId === undefined ? {} : { parentTaskId }
        );
        return okEnvelope("TASK_LISTED", {
          action,
          message: parentTaskId === undefined
            ? `Listed ${records.length} task(s).`
            : `Listed ${records.length} subtask(s) of ${parentTaskId}.`,
          records,
          text: renderTaskList(records)
        });
      }
      const record = await options.service.status(
        options.args.taskId === undefined
          ? { sessionId }
          : { taskId: options.args.taskId }
      );
      const coverage = await options.service.coverage(record.task.id);
      const proven = coverage.rows.filter(row => row.status === "proven").length;
      const mechanical = coverage.rows.filter(row => row.mode === "behavioral" || row.mode === "invariant").length;
      const reviewOnly = coverage.rows.filter(row => row.mode === "review-only").length;
      const legacy = coverage.rows.filter(row => row.mode === "legacy").length;
      const envelope = taskEnvelope(action, "TASK_STATUS", `Read task ${record.task.id}.`, record);
      return {...envelope, data: {...envelope.data!, coverage, treeContractHash: await options.service.treeContract(record.task.id),
        text: envelope.data!.text + "\nAcceptance: " + proven + "/" + mechanical + " mechanical proven; " + reviewOnly + " review-only; " + legacy + " legacy; originally mechanical " + coverage.originalMechanical +
          "; reviewed " + coverage.reviewed + "; undischarged " + coverage.rows.filter(row => row.status !== "proven" && !coverage.reviewed).length}};
    }
    if (action === "attach") {
      if (sessionId === undefined) {
        throw new AgentOpsError(
          "TASK_SESSION_REQUIRED",
          "Task attachment requires an injected session identity or --session."
        );
      }
      const record = await options.service.attach(
        sessionId,
        requireTaskId(options.args)
      );
      return taskEnvelope(
        action,
        "TASK_ATTACHED",
        `Attached session to ${record.task.id}.`,
        record
      );
    }
    if (action === "complete") {
      const record = await options.service.complete(
        requireTaskId(options.args),
        parseEvidence(options.args.evidence ?? [])
      );
      return taskEnvelope(
        action,
        "TASK_COMPLETED",
        `Completed task ${record.task.id}.`,
        record
      );
    }
    if (action === "archive") {
      const record = await options.service.archive(
        requireTaskId(options.args)
      );
      return taskEnvelope(
        action,
        "TASK_ARCHIVED",
        `Archived task ${record.task.id}.`,
        record
      );
    }
    const taskId = requireTaskId(options.args);
    const record = await options.service.status({ taskId });
    return okEnvelope("TASK_EXPORTED", {
      action,
      message: `Exported task ${record.task.id}.`,
      record,
      text: await options.service.export(taskId)
    });
  } catch (error) {
    if (error instanceof AgentOpsError) {
      return errorEnvelope(error.code, error.message);
    }
    throw error;
  }
}
