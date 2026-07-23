import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { sha256 } from "./hash.js";
import {
  AgentOpsError,
  resolveContainedPath
} from "./paths.js";

export { AgentOpsError } from "./paths.js";

export interface WriteOperation {
  kind: "write";
  path: string;
  content: string;
  expectedHash: string | null;
}

export interface RemoveOperation {
  kind: "remove";
  path: string;
  expectedHash: string | null;
}

export type FileOperation = RemoveOperation | WriteOperation;

export interface TransactionPlan {
  operations: FileOperation[];
}

export interface BeforeReplaceContext {
  index: number;
  targetPath: string;
  backupPath: string | null;
}

export interface FileTransactionOptions {
  beforeReplace?(
    context: BeforeReplaceContext
  ): Promise<void> | void;
}

interface Snapshot {
  operation: FileOperation;
  targetPath: string;
  existed: boolean;
  content: Uint8Array | null;
  mode: number;
  actualHash: string | null;
  backupPath: string | null;
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

async function atomicWrite(
  targetPath: string,
  content: string | Uint8Array,
  mode: number
): Promise<void> {
  const parent = dirname(targetPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    parent,
    `.${basename(targetPath)}.agent-ops-tmp-${randomUUID()}`
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, targetPath);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function createBackup(snapshot: Snapshot): Promise<string | null> {
  if (!snapshot.existed || snapshot.content === null) {
    return null;
  }
  const backupPath = join(
    dirname(snapshot.targetPath),
    `.${basename(snapshot.targetPath)}.agent-ops-backup-${randomUUID()}`
  );
  const handle = await open(backupPath, "wx", 0o600);
  try {
    await handle.writeFile(snapshot.content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(backupPath, 0o600);
  await syncDirectory(dirname(backupPath));
  return backupPath;
}

async function snapshotOperation(
  root: string,
  operation: FileOperation
): Promise<Snapshot> {
  const targetPath = await resolveContainedPath(root, operation.path);
  try {
    const status = await lstat(targetPath);
    if (!status.isFile()) {
      throw new AgentOpsError(
        "UNSUPPORTED_FILE_TYPE",
        `Managed target must be a regular file: ${operation.path}`
      );
    }
    const content = await readFile(targetPath);
    return {
      operation,
      targetPath,
      existed: true,
      content,
      mode: status.mode & 0o777,
      actualHash: sha256(content),
      backupPath: null
    };
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    return {
      operation,
      targetPath,
      existed: false,
      content: null,
      mode: 0o600,
      actualHash: null,
      backupPath: null
    };
  }
}

async function rollback(snapshots: readonly Snapshot[]): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.existed && snapshot.content !== null) {
      await atomicWrite(snapshot.targetPath, snapshot.content, snapshot.mode);
    } else {
      await unlink(snapshot.targetPath).catch((error: unknown) => {
        if (!isMissing(error)) {
          throw error;
        }
      });
    }
  }
}

async function removeBackups(snapshots: readonly Snapshot[]): Promise<void> {
  await Promise.all(
    snapshots.map(async (snapshot) => {
      if (snapshot.backupPath !== null) {
        await rm(snapshot.backupPath, { force: true });
      }
    })
  );
}

export class FileTransaction {
  readonly #root: string;
  readonly #options: FileTransactionOptions;

  constructor(root: string, options: FileTransactionOptions = {}) {
    this.#root = root;
    this.#options = options;
  }

  async apply(
    plan: TransactionPlan,
    validate: () => Promise<void> = async () => undefined
  ): Promise<void> {
    const snapshots: Snapshot[] = [];
    const ownership = new Set<string>();
    for (const operation of plan.operations) {
      const snapshot = await snapshotOperation(this.#root, operation);
      const ownershipKey = snapshot.targetPath.toLowerCase();
      if (ownership.has(ownershipKey)) {
        throw new AgentOpsError(
          "DUPLICATE_OPERATION",
          `A transaction may manage a path only once: ${operation.path}`
        );
      }
      ownership.add(ownershipKey);
      if (snapshot.actualHash !== operation.expectedHash) {
        throw new AgentOpsError(
          "PRECONDITION_CHANGED",
          `Precondition changed for ${operation.path}.`
        );
      }
      snapshots.push(snapshot);
    }

    const applied: Snapshot[] = [];
    try {
      for (const [index, snapshot] of snapshots.entries()) {
        const isNoOp =
          snapshot.operation.kind === "write"
            ? snapshot.actualHash === sha256(snapshot.operation.content)
            : !snapshot.existed;
        if (isNoOp) {
          continue;
        }
        snapshot.backupPath = await createBackup(snapshot);
        applied.push(snapshot);
        await this.#options.beforeReplace?.({
          index,
          targetPath: snapshot.targetPath,
          backupPath: snapshot.backupPath
        });
        if (snapshot.operation.kind === "write") {
          await atomicWrite(
            snapshot.targetPath,
            snapshot.operation.content,
            snapshot.existed ? snapshot.mode : 0o600
          );
        } else {
          await unlink(snapshot.targetPath);
          await syncDirectory(dirname(snapshot.targetPath));
        }
      }
      await validate();
    } catch (error) {
      try {
        await rollback(applied);
      } catch (rollbackError) {
        await removeBackups(snapshots).catch(() => undefined);
        throw new AgentOpsError(
          "ROLLBACK_FAILED",
          "The transaction failed and rollback was incomplete.",
          { cause: rollbackError }
        );
      }
      await removeBackups(snapshots);
      throw new AgentOpsError(
        "TRANSACTION_FAILED",
        "The transaction failed and all applied operations were rolled back.",
        { cause: error }
      );
    }
    await removeBackups(snapshots);
  }
}
