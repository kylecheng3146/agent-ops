import { randomUUID } from "node:crypto";

import {
  SCHEMA_VERSION,
  type AcceptanceCriterion,
  type AgentTask
} from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";
import { validateTask } from "../schema/validate.js";
import { renderTaskMarkdown } from "./render.js";
import type {
  MutableTaskState,
  StoredTaskRecord,
  TaskStore
} from "./store.js";

export interface CreateTaskInput {
  readonly title: string;
  readonly criteria: readonly AcceptanceCriterion[];
}

export interface TaskServiceOptions {
  readonly generateId?: () => string;
  readonly now?: () => string;
}

export interface TaskStatusQuery {
  readonly taskId?: string;
  readonly sessionId?: string;
}

export type CriterionEvidenceInput = Readonly<
  Record<string, readonly string[]>
>;

const SESSION_ID_PATTERN = /^[^\0\r\n]{1,256}$/u;

function defaultTaskId(): string {
  return `task-${randomUUID()}`;
}

function cloneRecord(record: StoredTaskRecord): StoredTaskRecord {
  return structuredClone(record);
}

function taskError(code: string, message: string): AgentOpsError {
  return new AgentOpsError(code, message);
}

function findTask(
  state: MutableTaskState,
  taskId: string
): StoredTaskRecord {
  const record = state.tasks.find(
    (candidate) => candidate.task.id === taskId
  );
  if (record === undefined) {
    throw taskError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
  }
  return record;
}

function replaceTask(
  state: MutableTaskState,
  record: StoredTaskRecord
): void {
  const index = state.tasks.findIndex(
    (candidate) => candidate.task.id === record.task.id
  );
  if (index === -1) {
    throw taskError("TASK_NOT_FOUND", `Task not found: ${record.task.id}`);
  }
  state.tasks[index] = record;
}

function assertTimestamp(value: string): string {
  if (
    value.length === 0 ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw taskError(
      "TASK_TIMESTAMP_INVALID",
      "Task timestamps must be ISO-compatible."
    );
  }
  return value;
}

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw taskError(
      "TASK_SESSION_INVALID",
      "Session identity must be a bounded non-empty string."
    );
  }
}

function normalizeEvidence(
  task: AgentTask,
  input: CriterionEvidenceInput
): Record<string, string[]> {
  const criterionIds = new Set(
    task.criteria.map((criterion) => criterion.id)
  );
  if (
    Object.keys(input).length !== criterionIds.size ||
    Object.keys(input).some((criterionId) => !criterionIds.has(criterionId))
  ) {
    throw taskError(
      "TASK_EVIDENCE_INCOMPLETE",
      "Completion requires evidence for every acceptance criterion."
    );
  }
  const evidence: Record<string, string[]> = {};
  for (const criterion of task.criteria) {
    const references = input[criterion.id];
    if (
      references === undefined ||
      references.length === 0 ||
      references.some(
        (reference) =>
          typeof reference !== "string" ||
          reference.length === 0 ||
          reference.length > 4096 ||
          reference.includes("\0")
      ) ||
      new Set(references).size !== references.length
    ) {
      throw taskError(
        "TASK_EVIDENCE_INCOMPLETE",
        `Criterion ${criterion.id} requires valid evidence references.`
      );
    }
    evidence[criterion.id] = [...references];
  }
  return evidence;
}

export class TaskService {
  readonly #store: TaskStore;
  readonly #generateId: () => string;
  readonly #now: () => string;

  constructor(store: TaskStore, options: TaskServiceOptions = {}) {
    this.#store = store;
    this.#generateId = options.generateId ?? defaultTaskId;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateTaskInput): Promise<StoredTaskRecord> {
    const task: AgentTask = {
      schemaVersion: SCHEMA_VERSION,
      id: this.#generateId(),
      title: input.title,
      criteria: [...input.criteria]
    };
    const validation = validateTask(task);
    if (!validation.ok) {
      throw taskError(
        "TASK_INVALID",
        validation.errors[0]?.message ?? "Task input is invalid."
      );
    }
    const now = assertTimestamp(this.#now());
    return await this.#store.mutate((state) => {
      if (
        state.tasks.some(
          (record) => record.task.id === validation.value.id
        )
      ) {
        throw taskError(
          "TASK_ID_CONFLICT",
          `Task ID already exists: ${validation.value.id}`
        );
      }
      const record: StoredTaskRecord = {
        task: validation.value,
        status: "active",
        evidence: {},
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        archivedAt: null
      };
      state.tasks.push(record);
      return cloneRecord(record);
    });
  }

  async list(): Promise<readonly StoredTaskRecord[]> {
    const state = await this.#store.read();
    return state.tasks
      .map(cloneRecord)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.task.id.localeCompare(right.task.id)
      );
  }

  async status(query: TaskStatusQuery): Promise<StoredTaskRecord> {
    if (
      (query.taskId === undefined) ===
      (query.sessionId === undefined)
    ) {
      throw taskError(
        "TASK_STATUS_TARGET_REQUIRED",
        "Task status requires exactly one task or session identity."
      );
    }
    const state = await this.#store.read();
    if (query.taskId !== undefined) {
      return cloneRecord(
        findTask(
          {
            schemaVersion: 1,
            tasks: [...state.tasks],
            sessions: [...state.sessions]
          },
          query.taskId
        )
      );
    }
    const sessionId = query.sessionId;
    if (sessionId === undefined) {
      throw taskError(
        "TASK_STATUS_TARGET_REQUIRED",
        "Task status requires a session identity."
      );
    }
    assertSessionId(sessionId);
    const attachment = state.sessions.find(
      (candidate) => candidate.sessionId === sessionId
    );
    if (attachment === undefined) {
      throw taskError(
        "TASK_SESSION_UNATTACHED",
        "The session is not attached to a task."
      );
    }
    const record = state.tasks.find(
      (candidate) => candidate.task.id === attachment.taskId
    );
    if (record === undefined) {
      throw taskError(
        "TASK_STATE_INVALID",
        "The session references an unknown task."
      );
    }
    return cloneRecord(record);
  }

  async attach(
    sessionId: string,
    taskId: string
  ): Promise<StoredTaskRecord> {
    assertSessionId(sessionId);
    const now = assertTimestamp(this.#now());
    return await this.#store.mutate((state) => {
      const record = findTask(state, taskId);
      if (record.status !== "active") {
        throw taskError(
          "TASK_NOT_ACTIVE",
          "Only an active task can be attached to a session."
        );
      }
      const currentIndex = state.sessions.findIndex(
        (attachment) => attachment.sessionId === sessionId
      );
      const attachment = { sessionId, taskId, attachedAt: now };
      if (currentIndex === -1) {
        state.sessions.push(attachment);
      } else {
        state.sessions[currentIndex] = attachment;
      }
      return cloneRecord(record);
    });
  }

  async complete(
    taskId: string,
    evidenceInput: CriterionEvidenceInput
  ): Promise<StoredTaskRecord> {
    const now = assertTimestamp(this.#now());
    return await this.#store.mutate((state) => {
      const current = findTask(state, taskId);
      if (current.status === "archived") {
        throw taskError(
          "TASK_NOT_ACTIVE",
          "An archived task cannot be completed."
        );
      }
      const evidence = normalizeEvidence(
        current.task,
        evidenceInput
      );
      if (current.status === "complete") {
        if (JSON.stringify(current.evidence) !== JSON.stringify(evidence)) {
          throw taskError(
            "TASK_ALREADY_COMPLETE",
            "Completed task evidence cannot be replaced."
          );
        }
        return cloneRecord(current);
      }
      const completed: StoredTaskRecord = {
        ...current,
        status: "complete",
        evidence,
        updatedAt: now,
        completedAt: now
      };
      replaceTask(state, completed);
      return cloneRecord(completed);
    });
  }

  async archive(taskId: string): Promise<StoredTaskRecord> {
    const now = assertTimestamp(this.#now());
    return await this.#store.mutate((state) => {
      const current = findTask(state, taskId);
      if (current.status === "archived") {
        return cloneRecord(current);
      }
      const archived: StoredTaskRecord = {
        ...current,
        status: "archived",
        updatedAt: now,
        archivedAt: now
      };
      replaceTask(state, archived);
      state.sessions = state.sessions.filter(
        (attachment) => attachment.taskId !== taskId
      );
      return cloneRecord(archived);
    });
  }

  async export(taskId: string): Promise<string> {
    return renderTaskMarkdown(await this.status({ taskId }));
  }
}
