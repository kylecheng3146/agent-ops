import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
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
  processId: number;
  createdAt: string;
  token: string;
}

const LOCK_ACQUIRE_TIMEOUT_MS = 6_000;
const LOCK_MAX_AGE_MS = 60_000;
const MALFORMED_LOCK_RECOVERY_MS = 5_000;

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
    Object.keys(value).length !== 3 ||
    !("processId" in value) ||
    !("createdAt" in value) ||
    !("token" in value) ||
    !Number.isSafeInteger(value.processId) ||
    (value.processId as number) <= 0 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.token !== "string" ||
    value.token.length === 0 ||
    value.token.length > 128
  ) {
    return null;
  }
  return {
    processId: value.processId as number,
    createdAt: value.createdAt,
    token: value.token
  };
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

async function recoverAbandonedLock(
  lockPath: string,
  anchorDirectory: string
): Promise<boolean> {
  const source = await readPrivateFile(lockPath, anchorDirectory);
  if (source === null) {
    return true;
  }
  const record = parseLockRecord(source);
  if (record === null) {
    const status = await lstat(lockPath);
    if (Date.now() - status.mtimeMs < MALFORMED_LOCK_RECOVERY_MS) {
      return false;
    }
  } else {
    const ageMs = Date.now() - Date.parse(record.createdAt);
    if (
      Math.abs(ageMs) <= LOCK_MAX_AGE_MS &&
      isProcessActive(record.processId)
    ) {
      return false;
    }
  }

  const currentSource = await readPrivateFile(
    lockPath,
    anchorDirectory
  );
  if (currentSource !== source) {
    return false;
  }
  try {
    await rm(lockPath);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return true;
    }
    throw error;
  }
}

export async function withPrivateFileLock<T>(
  path: string,
  anchorDirectory: string,
  action: () => Promise<T>
): Promise<T> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent, anchorDirectory);
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let handle;

  while (handle === undefined) {
    let candidate;
    try {
      candidate = await open(lockPath, "wx", 0o600);
      await candidate.writeFile(
        `${JSON.stringify({
          processId: process.pid,
          createdAt: new Date().toISOString(),
          token: randomUUID()
        })}\n`,
        "utf8"
      );
      await candidate.sync();
      handle = candidate;
    } catch (error) {
      await candidate?.close().catch(() => undefined);
      if (candidate !== undefined) {
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if (await recoverAbandonedLock(lockPath, anchorDirectory)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new AgentOpsError(
          "PRIVATE_STATE_LOCK_TIMEOUT",
          `Timed out waiting for private state lock: ${path}`,
          { cause: error }
        );
      }
      await delay(10);
    }
  }

  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    try {
      await rm(lockPath);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
}
