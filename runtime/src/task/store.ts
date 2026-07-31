import { lstat } from "node:fs/promises";

import {
  TASK_SCHEMA_VERSION,
  type AgentTask
} from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";
import { validateTask } from "../schema/validate.js";
import {
  readPrivateFile,
  withPrivateFileLock,
  writePrivateFile
} from "../security/permissions.js";
import type {
  FailureFingerprintState
} from "../verify/fingerprint.js";

export type TaskLifecycleStatus =
  | "active"
  | "archived"
  | "complete";

export interface StoredTaskRecord {
  readonly task: AgentTask;
  readonly status: TaskLifecycleStatus;
  readonly evidence: Readonly<Record<string, readonly string[]>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly archivedAt: string | null;
  readonly failureFingerprint: FailureFingerprintState | null;
}

export interface SessionAttachment {
  readonly sessionId: string;
  readonly taskId: string;
  readonly attachedAt: string;
}

export interface TaskState {
  readonly schemaVersion: typeof TASK_SCHEMA_VERSION;
  readonly tasks: readonly StoredTaskRecord[];
  readonly sessions: readonly SessionAttachment[];
}

export interface MutableTaskState {
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  tasks: StoredTaskRecord[];
  sessions: SessionAttachment[];
}

export interface TaskStore {
  read(): Promise<TaskState>;
  mutate<T>(
    action: (state: MutableTaskState) => T | Promise<T>
  ): Promise<T>;
}

export interface FileTaskStoreOptions {
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const SESSION_ID_PATTERN = /^[^\0\r\n]{1,256}$/u;

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    sortedExpected.every((key, index) => actual[index] === key)
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function invalidState(message: string): never {
  throw new AgentOpsError("TASK_STATE_INVALID", message);
}

function parseEvidence(
  value: unknown,
  task: AgentTask,
  requireComplete: boolean
): Record<string, string[]> {
  if (!isRecord(value)) {
    return invalidState("Task evidence must be an object.");
  }
  const criterionIds = new Set(
    task.criteria.map((criterion) => criterion.id)
  );
  const evidence: Record<string, string[]> = {};
  for (const [criterionId, references] of Object.entries(value)) {
    if (
      !criterionIds.has(criterionId) ||
      !Array.isArray(references) ||
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
      return invalidState("Task evidence references are invalid.");
    }
    evidence[criterionId] = [...references] as string[];
  }
  if (
    requireComplete &&
    task.criteria.some(
      (criterion) => evidence[criterion.id] === undefined
    )
  ) {
    return invalidState(
      "Completed task state requires evidence for every criterion."
    );
  }
  return evidence;
}

function parseTaskRecord(value: unknown): StoredTaskRecord {
  const baseKeys = [
    "archivedAt",
    "completedAt",
    "createdAt",
    "evidence",
    "status",
    "task",
    "updatedAt"
  ];
  if (
    !isRecord(value) ||
    (!hasExactKeys(value, baseKeys) &&
      !hasExactKeys(value, [...baseKeys, "failureFingerprint"]))
  ) {
    return invalidState("Task state contains an invalid task record.");
  }
  const task = validateTask(value.task);
  if (!task.ok) {
    return invalidState("Task state contains an invalid task.");
  }
  if (
    !["active", "archived", "complete"].includes(String(value.status)) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    (value.completedAt !== null && !isTimestamp(value.completedAt)) ||
    (value.archivedAt !== null && !isTimestamp(value.archivedAt))
  ) {
    return invalidState("Task state contains invalid lifecycle metadata.");
  }
  const status = value.status as TaskLifecycleStatus;
  if (
    (status === "active" &&
      (value.completedAt !== null || value.archivedAt !== null)) ||
    (status === "complete" &&
      (value.completedAt === null || value.archivedAt !== null)) ||
    (status === "archived" && value.archivedAt === null)
  ) {
    return invalidState("Task lifecycle timestamps do not match its status.");
  }
  const evidence = parseEvidence(
    value.evidence,
    task.value,
    status === "complete" ||
      (status === "archived" && value.completedAt !== null)
  );
  let failureFingerprint: FailureFingerprintState | null = null;
  if (
    value.failureFingerprint !== undefined &&
    value.failureFingerprint !== null
  ) {
    const fingerprint = value.failureFingerprint;
    if (
      !isRecord(fingerprint) ||
      !hasExactKeys(fingerprint, [
        "commandId",
        "consecutive",
        "diagnostics",
        "exitCategory",
        "failureClass",
        "recordedAt",
        "value"
      ]) ||
      typeof fingerprint.value !== "string" ||
      !/^[a-f0-9]{64}$/u.test(fingerprint.value) ||
      typeof fingerprint.commandId !== "string" ||
      typeof fingerprint.failureClass !== "string" ||
      typeof fingerprint.exitCategory !== "string" ||
      typeof fingerprint.diagnostics !== "string" ||
      fingerprint.diagnostics.includes("\0") ||
      Buffer.byteLength(fingerprint.diagnostics, "utf8") > 512 ||
      !Number.isSafeInteger(fingerprint.consecutive) ||
      (fingerprint.consecutive as number) <= 0 ||
      !isTimestamp(fingerprint.recordedAt)
    ) {
      return invalidState(
        "Task state contains an invalid failure fingerprint."
      );
    }
    failureFingerprint = {
      value: fingerprint.value,
      commandId: fingerprint.commandId,
      failureClass: fingerprint.failureClass,
      exitCategory: fingerprint.exitCategory,
      diagnostics: fingerprint.diagnostics,
      consecutive: fingerprint.consecutive as number,
      recordedAt: fingerprint.recordedAt
    };
  }
  return {
    task: task.value,
    status,
    evidence,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    completedAt: value.completedAt as string | null,
    archivedAt: value.archivedAt as string | null,
    failureFingerprint
  };
}

function parseSession(value: unknown): SessionAttachment {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["attachedAt", "sessionId", "taskId"]) ||
    typeof value.sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(value.sessionId) ||
    typeof value.taskId !== "string" ||
    !isTimestamp(value.attachedAt)
  ) {
    return invalidState("Task state contains an invalid session attachment.");
  }
  return {
    sessionId: value.sessionId,
    taskId: value.taskId,
    attachedAt: value.attachedAt
  };
}

function parseState(source: string | null): MutableTaskState {
  if (source === null) {
    return {
      schemaVersion: TASK_SCHEMA_VERSION,
      tasks: [],
      sessions: []
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return invalidState("Task state is not valid JSON.");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["schemaVersion", "sessions", "tasks"]) ||
    value.schemaVersion !== TASK_SCHEMA_VERSION ||
    !Array.isArray(value.tasks) ||
    !Array.isArray(value.sessions)
  ) {
    return invalidState("Task state has an unsupported structure.");
  }
  const tasks = value.tasks.map(parseTaskRecord);
  const sessions = value.sessions.map(parseSession);
  if (
    new Set(tasks.map(({ task }) => task.id)).size !== tasks.length ||
    new Set(sessions.map(({ sessionId }) => sessionId)).size !==
      sessions.length
  ) {
    return invalidState("Task and session identifiers must be unique.");
  }
  const tasksById = new Map(
    tasks.map((record) => [record.task.id, record])
  );
  if (
    sessions.some(({ taskId }) => {
      const record = tasksById.get(taskId);
      return record === undefined || record.status === "archived";
    })
  ) {
    return invalidState("Session attachments must reference known tasks.");
  }
    return {
      schemaVersion: TASK_SCHEMA_VERSION,
      tasks,
      sessions
    };
}

function positiveMaxBytes(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_BYTES;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgentOpsError(
      "TASK_STATE_LIMIT_INVALID",
      "Task state byte limit must be a positive integer."
    );
  }
  return value;
}

export class FileTaskStore implements TaskStore {
  readonly #path: string;
  readonly #anchorDirectory: string;
  readonly #maxBytes: number;

  constructor(
    path: string,
    anchorDirectory: string,
    options: FileTaskStoreOptions = {}
  ) {
    this.#path = path;
    this.#anchorDirectory = anchorDirectory;
    this.#maxBytes = positiveMaxBytes(options.maxBytes);
  }

  async #readState(): Promise<MutableTaskState> {
    let before:
      | { readonly device: bigint; readonly inode: bigint }
      | null = null;
    try {
      const status = await lstat(this.#path, { bigint: true });
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.size > BigInt(this.#maxBytes)
      ) {
        if (status.size > BigInt(this.#maxBytes)) {
          throw new AgentOpsError(
            "TASK_STATE_TOO_LARGE",
            "Task state exceeds its configured byte limit."
          );
        }
        throw new AgentOpsError(
          "TASK_STATE_INVALID",
          "Task state must be a regular private file."
        );
      }
      before = { device: status.dev, inode: status.ino };
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
    const source = await readPrivateFile(
      this.#path,
      this.#anchorDirectory
    );
    if (before === null && source !== null) {
      throw new AgentOpsError(
        "TASK_STATE_INVALID",
        "Task state appeared during inspection."
      );
    }
    if (before !== null) {
      if (source === null) {
        throw new AgentOpsError(
          "TASK_STATE_INVALID",
          "Task state disappeared during inspection."
        );
      }
      const after = await lstat(this.#path, { bigint: true });
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.dev !== before.device ||
        after.ino !== before.inode ||
        after.size > BigInt(this.#maxBytes)
      ) {
        throw new AgentOpsError(
          "TASK_STATE_INVALID",
          "Task state changed during inspection."
        );
      }
    }
    if (
      source !== null &&
      Buffer.byteLength(source, "utf8") > this.#maxBytes
    ) {
      throw new AgentOpsError(
        "TASK_STATE_TOO_LARGE",
        "Task state exceeds its configured byte limit."
      );
    }
    return parseState(source);
  }

  async read(): Promise<TaskState> {
    return await withPrivateFileLock(
      this.#path,
      this.#anchorDirectory,
      async () => structuredClone(await this.#readState())
    );
  }

  async mutate<T>(
    action: (state: MutableTaskState) => T | Promise<T>
  ): Promise<T> {
    return await withPrivateFileLock(
      this.#path,
      this.#anchorDirectory,
      async () => {
        const state = await this.#readState();
        const result = await action(state);
        const validated = parseState(JSON.stringify(state));
        const content = `${JSON.stringify(validated, null, 2)}\n`;
        if (Buffer.byteLength(content, "utf8") > this.#maxBytes) {
          throw new AgentOpsError(
            "TASK_STATE_TOO_LARGE",
            "Task state exceeds its configured byte limit."
          );
        }
        await writePrivateFile(
          this.#path,
          content,
          this.#anchorDirectory
        );
        return result;
      }
    );
  }
}
