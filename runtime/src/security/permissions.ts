import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { AgentOpsError } from "../fs/paths.js";

export interface LocalStatePaths {
  anchorDirectory: string;
  root: string;
  trustStore: string;
  logDirectory: string;
  failureDirectory: string;
}

export function localStatePaths(homeDirectory: string): LocalStatePaths {
  const root = join(homeDirectory, ".agent-ops", "state");
  return {
    anchorDirectory: homeDirectory,
    root,
    trustStore: join(root, "trust.json"),
    logDirectory: join(root, "logs"),
    failureDirectory: join(root, "failures")
  };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

interface PrivateLockRecord {
  choosing: boolean;
  createdAt: string;
  processId: number;
  processIdentity: string;
  ticket: number;
  token: string;
}

interface ActiveParticipant {
  path: string;
  record: PrivateLockRecord;
}

const LOCK_ACQUIRE_TIMEOUT_MS = 6_000;
const PROCESS_IDENTITY_CACHE_MS = 250;
const RECENT_PROCESS_RECORD_MS = 5 * 60 * 1000;
const PROCESS_INSTANCE_TOKEN = randomUUID();
const execFile = promisify(execFileCallback);
const lockQueues = new Map<string, Promise<void>>();
const processIdentityCache = new Map<
  number,
  { checkedAt: number; identity: string | null }
>();

function parseLockRecord(source: string): PrivateLockRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 6 ||
    !("choosing" in value) ||
    !("processId" in value) ||
    !("processIdentity" in value) ||
    !("createdAt" in value) ||
    !("ticket" in value) ||
    !("token" in value) ||
    typeof value.choosing !== "boolean" ||
    !Number.isSafeInteger(value.processId) ||
    (value.processId as number) <= 0 ||
    typeof value.processIdentity !== "string" ||
    value.processIdentity.length === 0 ||
    value.processIdentity.length > 256 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isSafeInteger(value.ticket) ||
    (value.ticket as number) < 0 ||
    typeof value.token !== "string" ||
    value.token.length === 0 ||
    value.token.length > 128
  ) {
    return null;
  }
  return {
    choosing: value.choosing,
    createdAt: value.createdAt,
    processId: value.processId as number,
    processIdentity: value.processIdentity,
    ticket: value.ticket as number,
    token: value.token
  };
}

async function readLinuxProcessIdentity(
  processId: number
): Promise<string | null> {
  try {
    const source = await readFile(`/proc/${processId}/stat`, "utf8");
    const commandEnd = source.lastIndexOf(")");
    if (commandEnd < 0) {
      return null;
    }
    const fields = source.slice(commandEnd + 1).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime === undefined ? null : `linux:${startTime}`;
  } catch {
    return null;
  }
}

async function readPosixProcessIdentity(
  processId: number
): Promise<string | null> {
  try {
    const result = await execFile(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(processId)],
      {
        encoding: "utf8",
        maxBuffer: 4096,
        timeout: 1000
      }
    );
    const startedAt = result.stdout.trim();
    return startedAt.length === 0 ? null : `posix:${startedAt}`;
  } catch {
    return null;
  }
}

async function readWindowsProcessIdentity(
  processId: number
): Promise<string | null> {
  try {
    const script = [
      `$process = Get-Process -Id ${processId} -ErrorAction Stop`,
      "$process.StartTime.ToUniversalTime().Ticks"
    ].join("; ");
    const result = await execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script
      ],
      {
        encoding: "utf8",
        maxBuffer: 4096,
        timeout: 2000,
        windowsHide: true
      }
    );
    const startedAt = result.stdout.trim();
    return startedAt.length === 0 ? null : `windows:${startedAt}`;
  } catch {
    return null;
  }
}

async function readProcessIdentity(
  processId: number
): Promise<string | null> {
  const cached = processIdentityCache.get(processId);
  if (
    cached !== undefined &&
    Date.now() - cached.checkedAt <= PROCESS_IDENTITY_CACHE_MS
  ) {
    return cached.identity;
  }
  let identity: string | null;
  if (process.platform === "linux") {
    identity = await readLinuxProcessIdentity(processId);
  } else if (process.platform === "win32") {
    identity = await readWindowsProcessIdentity(processId);
  } else {
    identity = await readPosixProcessIdentity(processId);
  }
  if (identity === null && processId === process.pid) {
    identity = `runtime:${PROCESS_INSTANCE_TOKEN}`;
  }
  processIdentityCache.set(processId, {
    checkedAt: Date.now(),
    identity
  });
  return identity;
}

function isProcessActive(processId: number): boolean {
  if (processId === process.pid) {
    return true;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error
    ) {
      if (error.code === "ESRCH" || error.code === "EINVAL") {
        return false;
      }
      if (error.code === "EPERM") {
        return true;
      }
    }
    return true;
  }
}

async function isProcessInstanceActive(
  record: PrivateLockRecord
): Promise<boolean> {
  if (!isProcessActive(record.processId)) {
    return false;
  }
  if (record.processId === process.pid) {
    const localIdentity = await readProcessIdentity(process.pid);
    return localIdentity === record.processIdentity;
  }
  const ageMs = Date.now() - Date.parse(record.createdAt);
  if (ageMs >= 0 && ageMs <= RECENT_PROCESS_RECORD_MS) {
    return true;
  }
  const identity = await readProcessIdentity(record.processId);
  return identity === null || identity === record.processIdentity;
}

function privateStateError(path: string, cause?: unknown): AgentOpsError {
  return new AgentOpsError(
    "PRIVATE_STATE_PATH_INVALID",
    `Private state path is outside its anchor or contains a symlink: ${path}`,
    { cause }
  );
}

function containedSegments(
  path: string,
  anchorDirectory: string
): { anchor: string; segments: string[] } {
  const anchor = resolve(anchorDirectory);
  const candidate = resolve(path);
  const fromAnchor = relative(anchor, candidate);
  if (
    !isAbsolute(anchorDirectory) ||
    !isAbsolute(path) ||
    fromAnchor === ".." ||
    fromAnchor.startsWith(`..${sep}`) ||
    isAbsolute(fromAnchor)
  ) {
    throw privateStateError(path);
  }
  return {
    anchor,
    segments:
      fromAnchor.length === 0 ? [] : fromAnchor.split(sep)
  };
}

async function assertAnchor(anchor: string): Promise<void> {
  let status;
  try {
    status = await lstat(anchor);
  } catch (error) {
    throw privateStateError(anchor, error);
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw privateStateError(anchor);
  }
}

async function inspectPath(
  path: string,
  anchorDirectory: string,
  leafKind: "directory" | "file"
): Promise<boolean> {
  const { anchor, segments } = containedSegments(path, anchorDirectory);
  await assertAnchor(anchor);
  let current = anchor;

  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    let status;
    try {
      status = await lstat(current);
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
    const isLeaf = index === segments.length - 1;
    if (
      status.isSymbolicLink() ||
      (!isLeaf && !status.isDirectory()) ||
      (isLeaf &&
        ((leafKind === "directory" && !status.isDirectory()) ||
          (leafKind === "file" && !status.isFile())))
    ) {
      throw privateStateError(current);
    }
    if (!isLeaf) {
      await chmod(current, 0o700);
    }
  }
  return true;
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(
        String(error.code)
      )
    ) {
      return;
    }
    throw error;
  }
}

export async function ensurePrivateDirectory(
  path: string,
  anchorDirectory: string
): Promise<void> {
  const { anchor, segments } = containedSegments(path, anchorDirectory);
  await assertAnchor(anchor);
  let current = anchor;

  for (const segment of segments) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
    }
    const status = await lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw privateStateError(current);
    }
    await chmod(current, 0o700);
  }
}

export async function readPrivateFile(
  path: string,
  anchorDirectory: string
): Promise<string | null> {
  const exists = await inspectPath(path, anchorDirectory, "file");
  if (!exists) {
    return null;
  }
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    const status = await handle.stat();
    if (!status.isFile()) {
      throw privateStateError(path);
    }
    await handle.chmod(0o600);
    return await handle.readFile("utf8");
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ["ELOOP", "EMLINK"].includes(String(error.code))
    ) {
      throw privateStateError(path, error);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writePrivateFile(
  path: string,
  content: string,
  anchorDirectory: string
): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent, anchorDirectory);
  await inspectPath(path, anchorDirectory, "file");

  const temporaryPath = join(
    parent,
    `.${basename(path)}.agent-ops-private-${randomUUID()}`
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function lockParticipantPrefix(path: string): string {
  return `.${basename(path)}.agent-ops-lock-`;
}

function lockParticipantPath(
  path: string,
  processId: number,
  token: string
): string {
  return join(
    dirname(path),
    `${lockParticipantPrefix(path)}${processId}-${token}`
  );
}

async function removeOwnedParticipant(
  participantPath: string,
  anchorDirectory: string
): Promise<void> {
  const source = await readPrivateFile(
    participantPath,
    anchorDirectory
  );
  if (source === null) {
    return;
  }
  const record = parseLockRecord(source);
  if (record === null) {
    throw new AgentOpsError(
      "PRIVATE_STATE_LOCK_INVALID",
      `Private state lock record is invalid: ${participantPath}`
    );
  }
  try {
    await rm(participantPath);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
}

async function readActiveParticipants(
  path: string,
  anchorDirectory: string,
  ownParticipantPath: string
): Promise<ActiveParticipant[]> {
  const parent = dirname(path);
  const prefix = lockParticipantPrefix(path);
  const names = await readdir(parent);
  const participants: ActiveParticipant[] = [];

  for (const name of names) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const participantPath = join(parent, name);
    const source = await readPrivateFile(
      participantPath,
      anchorDirectory
    );
    if (source === null) {
      continue;
    }
    const record = parseLockRecord(source);
    if (record === null) {
      if (participantPath === ownParticipantPath) {
        throw new AgentOpsError(
          "PRIVATE_STATE_LOCK_INVALID",
          `The current private state lock record is invalid: ${participantPath}`
        );
      }
      await rm(participantPath);
      continue;
    }
    if (!await isProcessInstanceActive(record)) {
      if (participantPath !== ownParticipantPath) {
        await removeOwnedParticipant(
          participantPath,
          anchorDirectory
        );
      }
      continue;
    }
    participants.push({ path: participantPath, record });
  }
  return participants;
}

async function refreshBlockers(
  blockers: readonly ActiveParticipant[],
  record: PrivateLockRecord,
  anchorDirectory: string
): Promise<ActiveParticipant[]> {
  const refreshed: ActiveParticipant[] = [];
  for (const blocker of blockers) {
    const source = await readPrivateFile(
      blocker.path,
      anchorDirectory
    );
    if (source === null) {
      continue;
    }
    const current = parseLockRecord(source);
    if (current === null) {
      await rm(blocker.path);
      continue;
    }
    if (!await isProcessInstanceActive(current)) {
      await removeOwnedParticipant(
        blocker.path,
        anchorDirectory
      );
      continue;
    }
    if (current.choosing || precedes(current, record)) {
      refreshed.push({ path: blocker.path, record: current });
    }
  }
  return refreshed;
}

function precedes(
  left: PrivateLockRecord,
  right: PrivateLockRecord
): boolean {
  return (
    left.ticket < right.ticket ||
    (left.ticket === right.ticket && left.token < right.token)
  );
}

export async function withPrivateFileLock<T>(
  path: string,
  anchorDirectory: string,
  action: () => Promise<T>
): Promise<T> {
  const queueKey = `${resolve(anchorDirectory)}\0${resolve(path)}`;
  const previous = lockQueues.get(queueKey);
  let releaseQueue = (): void => undefined;
  const current = new Promise<void>((resolveQueue) => {
    releaseQueue = resolveQueue;
  });
  lockQueues.set(queueKey, current);
  await previous;
  try {
    return await withTicketLock(path, anchorDirectory, action);
  } finally {
    releaseQueue();
    if (lockQueues.get(queueKey) === current) {
      lockQueues.delete(queueKey);
    }
  }
}

async function withTicketLock<T>(
  path: string,
  anchorDirectory: string,
  action: () => Promise<T>
): Promise<T> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent, anchorDirectory);
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  const token = randomUUID();
  const participantPath = lockParticipantPath(
    path,
    process.pid,
    token
  );
  const processIdentity =
    await readProcessIdentity(process.pid) ??
    `runtime:${PROCESS_INSTANCE_TOKEN}`;
  let record: PrivateLockRecord = {
    choosing: true,
    createdAt: new Date().toISOString(),
    processId: process.pid,
    processIdentity,
    ticket: 0,
    token
  };
  await writePrivateFile(
    participantPath,
    `${JSON.stringify(record)}\n`,
    anchorDirectory
  );

  try {
    const initialParticipants = await readActiveParticipants(
      path,
      anchorDirectory,
      participantPath
    );
    const maximumTicket = initialParticipants.reduce(
      (maximum, participant) =>
        Math.max(maximum, participant.record.ticket),
      0
    );
    if (maximumTicket >= Number.MAX_SAFE_INTEGER) {
      throw new AgentOpsError(
        "PRIVATE_STATE_LOCK_EXHAUSTED",
        `Private state lock ticket space is exhausted: ${path}`
      );
    }
    record = {
      ...record,
      choosing: false,
      ticket: maximumTicket + 1
    };
    await writePrivateFile(
      participantPath,
      `${JSON.stringify(record)}\n`,
      anchorDirectory
    );

    let blockers = (await readActiveParticipants(
      path,
      anchorDirectory,
      participantPath
    )).filter(
      (participant) =>
        participant.record.token !== token &&
        (participant.record.choosing ||
          precedes(participant.record, record))
    );
    while (blockers.length > 0) {
      blockers = await refreshBlockers(
        blockers,
        record,
        anchorDirectory
      );
      if (blockers.length === 0) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new AgentOpsError(
          "PRIVATE_STATE_LOCK_TIMEOUT",
          `Timed out waiting for private state lock: ${path}`
        );
      }
      await delay(10);
    }

    return await action();
  } finally {
    await removeOwnedParticipant(
      participantPath,
      anchorDirectory
    );
  }
}
