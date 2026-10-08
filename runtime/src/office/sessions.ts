import {join} from "node:path";

import {readPrivateFile, withPrivateFileLock, writePrivateFile} from "../security/permissions.js";

export const OFFICE_SESSION_STALE_MS = 30 * 60 * 1000;
export const OFFICE_SESSION_RETENTION_MS = 2 * 60 * 60 * 1000;
const OFFICE_SESSION_SCHEMA_VERSION = 1;
const MAX_SESSIONS = 512;
const MAX_TEXT = 256;
const MAX_ROOT = 4_096;

/** `end`: the host closed the conversation, so the room closes with it. */
export type OfficeSessionEvent = "start" | "activity" | "stop" | "end";

export interface OfficeSessionRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly harness: string;
  readonly root: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly status: "active" | "idle";
  readonly agentId?: string;
  readonly runId?: string;
  readonly workerId?: string;
  readonly taskId?: string;
  readonly phase?: string;
  readonly host?: string;
  readonly completedAt?: string | null;
}

export interface RecordOfficeSessionOptions {
  readonly sessionId: string;
  readonly harness: string;
  readonly projectRoot: string;
  readonly commonDir: string;
  readonly event: OfficeSessionEvent;
  readonly now?: number;
  readonly agentId?: string;
  readonly runId?: string;
  readonly workerId?: string;
  readonly taskId?: string;
  readonly phase?: string;
  readonly host?: string;
}

export const officeSessionsPath = (commonDir: string): string =>
  join(commonDir, "agent-ops", "office-sessions.json");

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    !/[\0\r\n]/u.test(value);
}

function optional(value: unknown, max = MAX_TEXT): string | undefined {
  return value === undefined ? undefined : bounded(value, max) ? value : undefined;
}

function timestamp(value: unknown): value is string {
  return bounded(value, 64) && Number.isFinite(Date.parse(value));
}

function parseRecord(value: unknown): OfficeSessionRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== OFFICE_SESSION_SCHEMA_VERSION ||
      !bounded(item.sessionId, MAX_TEXT) || !bounded(item.harness, MAX_TEXT) ||
      !bounded(item.root, MAX_ROOT) || !timestamp(item.firstSeenAt) ||
      !timestamp(item.lastSeenAt) || !["active", "idle"].includes(String(item.status))) {
    return null;
  }
  if (item.completedAt !== undefined && item.completedAt !== null && !timestamp(item.completedAt)) return null;
  const record: OfficeSessionRecord = {
    schemaVersion: 1,
    sessionId: item.sessionId,
    harness: item.harness,
    root: item.root,
    firstSeenAt: item.firstSeenAt,
    lastSeenAt: item.lastSeenAt,
    status: item.status as "active" | "idle",
    ...(optional(item.agentId) === undefined ? {} : {agentId: optional(item.agentId)}),
    ...(optional(item.runId) === undefined ? {} : {runId: optional(item.runId)}),
    ...(optional(item.workerId) === undefined ? {} : {workerId: optional(item.workerId)}),
    ...(optional(item.taskId) === undefined ? {} : {taskId: optional(item.taskId)}),
    ...(optional(item.phase) === undefined ? {} : {phase: optional(item.phase)}),
    ...(optional(item.host) === undefined ? {} : {host: optional(item.host)}),
    ...(item.completedAt === undefined ? {} : {completedAt: item.completedAt as string | null})
  };
  return record;
}

async function readRecords(commonDir: string): Promise<OfficeSessionRecord[]> {
  const source = await readPrivateFile(officeSessionsPath(commonDir), commonDir).catch(() => null);
  if (source === null) return [];
  try {
    const value = JSON.parse(source) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const sessions = (value as Record<string, unknown>).sessions;
    if (!Array.isArray(sessions)) return [];
    return sessions.slice(0, MAX_SESSIONS).map(parseRecord).filter((record): record is OfficeSessionRecord => record !== null);
  } catch {
    return [];
  }
}

function retained(record: OfficeSessionRecord, now: number): boolean {
  const lastSeen = Date.parse(record.lastSeenAt);
  if (!Number.isFinite(lastSeen)) return false;
  if (record.status === "active") {
    // ponytail: one TTL handles crashed hook clients; a persistent host heartbeat can replace it if needed.
    return now - lastSeen <= OFFICE_SESSION_STALE_MS;
  }
  const completed = record.completedAt === null || record.completedAt === undefined
    ? lastSeen
    : Date.parse(record.completedAt);
  return Number.isFinite(completed) && now - completed < OFFICE_SESSION_RETENTION_MS;
}

function prune(records: readonly OfficeSessionRecord[], now: number): OfficeSessionRecord[] {
  return records.filter(record => retained(record, now)).slice(-MAX_SESSIONS);
}

export async function readOfficeSessions(commonDir: string, now = Date.now()): Promise<OfficeSessionRecord[]> {
  return prune(await readRecords(commonDir), now);
}

export async function recordOfficeSession(options: RecordOfficeSessionOptions): Promise<void> {
  if (!bounded(options.sessionId, MAX_TEXT) || !bounded(options.harness, MAX_TEXT) ||
      !bounded(options.projectRoot, MAX_ROOT) || !bounded(options.commonDir, MAX_ROOT)) return;
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const path = officeSessionsPath(options.commonDir);
  await withPrivateFileLock(path, options.commonDir, async () => {
    const records = prune(await readRecords(options.commonDir), now);
    const previous = records.find(record => record.sessionId === options.sessionId);
    const next: OfficeSessionRecord = {
      schemaVersion: 1,
      sessionId: options.sessionId,
      harness: options.harness,
      root: options.projectRoot,
      firstSeenAt: previous?.firstSeenAt ?? at,
      lastSeenAt: at,
      status: options.event === "stop" || options.event === "end" ? "idle" : "active",
      ...(options.agentId ?? previous?.agentId ? {agentId: options.agentId ?? previous?.agentId} : {}),
      ...(options.runId ?? previous?.runId ? {runId: options.runId ?? previous?.runId} : {}),
      ...(options.workerId ?? previous?.workerId ? {workerId: options.workerId ?? previous?.workerId} : {}),
      ...(options.taskId ?? previous?.taskId ? {taskId: options.taskId ?? previous?.taskId} : {}),
      ...(options.phase ?? previous?.phase ? {phase: options.phase ?? previous?.phase} : {}),
      ...(options.host ?? previous?.host ? {host: options.host ?? previous?.host} : {}),
      // A finished session keeps its closed room through the tool calls that
      // report the result; only a new start (or resume) reopens it.
      ...(options.event === "end"
        ? {completedAt: previous?.completedAt ?? at}
        : options.event !== "start" && previous?.completedAt !== undefined ? {completedAt: previous.completedAt} : {})
    };
    const without = records.filter(record => record.sessionId !== options.sessionId);
    await writePrivateFile(path, JSON.stringify({schemaVersion: 1, sessions: [...without, next].slice(-MAX_SESSIONS)}) + "\n", options.commonDir);
  });
}

/** Closes a session's room once `worktree finish` merged its work. Unknown sessions stay unknown. */
export async function markOfficeSessionCompleted(commonDir: string, sessionId: string, now = Date.now()): Promise<void> {
  const path = officeSessionsPath(commonDir);
  await withPrivateFileLock(path, commonDir, async () => {
    const records = prune(await readRecords(commonDir), now);
    if (!records.some(record => record.sessionId === sessionId)) return;
    const at = new Date(now).toISOString();
    const next = records.map(record => record.sessionId === sessionId
      ? {...record, status: "idle" as const, phase: "integrating", lastSeenAt: at, completedAt: at} : record);
    await writePrivateFile(path, JSON.stringify({schemaVersion: OFFICE_SESSION_SCHEMA_VERSION, sessions: next}) + "\n", commonDir);
  });
}
