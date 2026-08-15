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
}

export interface TaskCommandData {
  readonly action: TaskAction;
  readonly message: string;
  readonly record?: StoredTaskRecord;
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
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "description,id,verifierIds" ||
    typeof value.id !== "string" ||
    typeof value.description !== "string" ||
    !Array.isArray(value.verifierIds) ||
    value.verifierIds.some((id) => typeof id !== "string")
  ) {
    throw new AgentOpsError(
      "TASK_CRITERION_INVALID",
      "Each criterion requires only id, description, and verifierIds."
    );
  }
  return {
    id: value.id,
    description: value.description,
    verifierIds: [...value.verifierIds] as string[]
  };
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
      "status"
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
    text: renderTaskMarkdown(record)
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
      const record = await options.service.create({
        title: options.args.title,
        criteria: (options.args.criteria ?? []).map(parseCriterion),
        ...(options.policyConfigHash === undefined
          ? {}
          : { policyConfigHash: options.policyConfigHash })
      });
      return taskEnvelope(
        action,
        "TASK_CREATED",
        `Created task ${record.task.id}.`,
        record
      );
    }
    if (action === "status") {
      if (options.args.taskId === undefined && sessionId === undefined) {
        const records = await options.service.list();
        return okEnvelope("TASK_LISTED", {
          action,
          message: `Listed ${records.length} task(s).`,
          records,
          text: renderTaskList(records)
        });
      }
      const record = await options.service.status(
        options.args.taskId === undefined
          ? { sessionId }
          : { taskId: options.args.taskId }
      );
      return taskEnvelope(
        action,
        "TASK_STATUS",
        `Read task ${record.task.id}.`,
        record
      );
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
