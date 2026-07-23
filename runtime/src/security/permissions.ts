import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { AgentOpsError } from "../fs/paths.js";

export interface LocalStatePaths {
  root: string;
  trustStore: string;
  logDirectory: string;
  failureDirectory: string;
}

export function localStatePaths(homeDirectory: string): LocalStatePaths {
  const root = join(homeDirectory, ".agent-ops", "state");
  return {
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

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new AgentOpsError(
      "PRIVATE_STATE_PATH_INVALID",
      `Private state path must be a directory: ${path}`
    );
  }
  await chmod(path, 0o700);
}

export async function readPrivateFile(
  path: string
): Promise<string | null> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new AgentOpsError(
        "PRIVATE_STATE_PATH_INVALID",
        `Private state path must be a regular file: ${path}`
      );
    }
    await chmod(path, 0o600);
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

export async function writePrivateFile(
  path: string,
  content: string
): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new AgentOpsError(
        "PRIVATE_STATE_PATH_INVALID",
        `Private state path must be a regular file: ${path}`
      );
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }

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
