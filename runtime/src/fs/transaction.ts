import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  rm,
  unlink
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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
  createdDirectories: string[];
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
  mode: number,
  assertBeforeRename?: () => Promise<void>
): Promise<void> {
  const parent = dirname(targetPath);
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
    await assertBeforeRename?.();
    await rename(temporaryPath, targetPath);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isExpectedHash(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
  );
}

function assertTransactionPlan(plan: unknown): asserts plan is TransactionPlan {
  if (
    !isRecord(plan) ||
    !hasOnlyKeys(plan, ["operations"]) ||
    !Array.isArray(plan.operations)
  ) {
    throw new AgentOpsError(
      "INVALID_TRANSACTION_PLAN",
      "Transaction plan must contain only an operations array."
    );
  }
  for (let index = 0; index < plan.operations.length; index += 1) {
    if (!Object.hasOwn(plan.operations, index)) {
      throw new AgentOpsError(
        "INVALID_TRANSACTION_PLAN",
        "Transaction operations must be a dense array."
      );
    }
    const operation: unknown = plan.operations[index];
    if (
      !isRecord(operation) ||
      typeof operation.path !== "string" ||
      !isExpectedHash(operation.expectedHash)
    ) {
      throw new AgentOpsError(
        "INVALID_TRANSACTION_PLAN",
        `Invalid transaction operation at index ${index}.`
      );
    }
    if (operation.kind === "write") {
      if (
        typeof operation.content !== "string" ||
        !hasOnlyKeys(operation, ["kind", "path", "content", "expectedHash"])
      ) {
        throw new AgentOpsError(
          "INVALID_TRANSACTION_PLAN",
          `Invalid write operation at index ${index}.`
        );
      }
      continue;
    }
    if (
      operation.kind !== "remove" ||
      !hasOnlyKeys(operation, ["kind", "path", "expectedHash"])
    ) {
      throw new AgentOpsError(
        "INVALID_TRANSACTION_PLAN",
        `Invalid remove operation at index ${index}.`
      );
    }
  }
}

async function createRecoveryDirectory(root: string): Promise<string> {
  const recoveryDirectory = join(
    root,
    `.agent-ops-backup-${randomUUID()}`
  );
  await mkdir(recoveryDirectory, { mode: 0o700 });
  await chmod(recoveryDirectory, 0o700);
  await syncDirectory(root);
  return recoveryDirectory;
}

async function createBackup(
  snapshot: Snapshot,
  recoveryDirectory: string
): Promise<string | null> {
  if (!snapshot.existed || snapshot.content === null) {
    return null;
  }
  const backupPath = join(
    recoveryDirectory,
    `${basename(snapshot.targetPath)}-${randomUUID()}`
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
      backupPath: null,
      createdDirectories: []
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
      backupPath: null,
      createdDirectories: []
    };
  }
}

async function currentHash(path: string): Promise<string | null> {
  try {
    const status = await lstat(path);
    if (!status.isFile()) {
      throw new AgentOpsError(
        "PRECONDITION_CHANGED",
        `A managed path is no longer a regular file: ${path}`
      );
    }
    return sha256(await readFile(path));
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

async function assertMutationBoundary(
  root: string,
  snapshot: Snapshot
): Promise<void> {
  try {
    const resolved = await resolveContainedPath(root, snapshot.operation.path);
    if (resolved !== snapshot.targetPath) {
      throw new AgentOpsError(
        "PRECONDITION_CHANGED",
        `Resolved target changed for ${snapshot.operation.path}.`
      );
    }
    if ((await currentHash(resolved)) !== snapshot.actualHash) {
      throw new AgentOpsError(
        "PRECONDITION_CHANGED",
        `Precondition changed for ${snapshot.operation.path}.`
      );
    }
  } catch (error) {
    if (
      error instanceof AgentOpsError &&
      error.code === "PRECONDITION_CHANGED"
    ) {
      throw error;
    }
    throw new AgentOpsError(
      "PRECONDITION_CHANGED",
      `Target safety changed for ${snapshot.operation.path}.`,
      { cause: error }
    );
  }
}

async function ensureParentDirectories(
  root: string,
  snapshot: Snapshot
): Promise<void> {
  const parent = dirname(snapshot.targetPath);
  const fromRoot = relative(root, parent);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`)
  ) {
    return;
  }
  let current = root;
  for (const segment of fromRoot.split(sep)) {
    current = join(current, segment);
    try {
      const status = await lstat(current);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new AgentOpsError(
          "PRECONDITION_CHANGED",
          `Managed parent is not a stable directory: ${snapshot.operation.path}`
        );
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      try {
        await mkdir(current, { mode: 0o700 });
        snapshot.createdDirectories.push(current);
      } catch (mkdirError) {
        if (
          typeof mkdirError !== "object" ||
          mkdirError === null ||
          !("code" in mkdirError) ||
          mkdirError.code !== "EEXIST"
        ) {
          throw mkdirError;
        }
        const status = await lstat(current);
        if (!status.isDirectory() || status.isSymbolicLink()) {
          throw new AgentOpsError(
            "PRECONDITION_CHANGED",
            `Managed parent changed while it was created: ${snapshot.operation.path}`
          );
        }
      }
    }
  }
}

function desiredHash(snapshot: Snapshot): string | null {
  return snapshot.operation.kind === "write"
    ? sha256(snapshot.operation.content)
    : null;
}

async function removeCreatedDirectories(snapshot: Snapshot): Promise<void> {
  for (const directory of [...snapshot.createdDirectories].reverse()) {
    await rmdir(directory);
  }
}

async function rollback(
  root: string,
  snapshots: readonly Snapshot[]
): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    const resolved = await resolveContainedPath(root, snapshot.operation.path);
    if (resolved !== snapshot.targetPath) {
      throw new AgentOpsError(
        "PRECONDITION_CHANGED",
        `Cannot safely roll back changed path: ${snapshot.operation.path}`
      );
    }
    const observedHash = await currentHash(snapshot.targetPath);
    if (observedHash === snapshot.actualHash) {
      await removeCreatedDirectories(snapshot);
      continue;
    }
    if (observedHash !== desiredHash(snapshot)) {
      throw new AgentOpsError(
        "PRECONDITION_CHANGED",
        `Cannot overwrite a concurrent change during rollback: ${snapshot.operation.path}`
      );
    }
    if (snapshot.existed && snapshot.content !== null) {
      await atomicWrite(
        snapshot.targetPath,
        snapshot.content,
        snapshot.mode,
        () => assertMutationBoundaryForHash(root, snapshot, desiredHash(snapshot))
      );
    } else {
      await unlink(snapshot.targetPath).catch((error: unknown) => {
        if (!isMissing(error)) {
          throw error;
        }
      });
      await syncDirectory(dirname(snapshot.targetPath));
      await removeCreatedDirectories(snapshot);
    }
  }
}

async function assertMutationBoundaryForHash(
  root: string,
  snapshot: Snapshot,
  expectedHash: string | null
): Promise<void> {
  const resolved = await resolveContainedPath(root, snapshot.operation.path);
  if (
    resolved !== snapshot.targetPath ||
    (await currentHash(resolved)) !== expectedHash
  ) {
    throw new AgentOpsError(
      "PRECONDITION_CHANGED",
      `Target changed at the replacement boundary: ${snapshot.operation.path}`
    );
  }
}

async function removeRecoveryDirectory(
  recoveryDirectory: string | null
): Promise<void> {
  if (recoveryDirectory !== null) {
    await rm(recoveryDirectory, { recursive: true, force: true });
  }
}

function recoveryPaths(snapshots: readonly Snapshot[]): string[] {
  return snapshots.flatMap((snapshot) =>
    snapshot.backupPath === null ? [] : [snapshot.backupPath]
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
    assertTransactionPlan(plan);
    const root = await realpath(resolve(this.#root));
    const snapshots: Snapshot[] = [];
    const ownership = new Set<string>();
    for (const operation of plan.operations) {
      const snapshot = await snapshotOperation(root, operation);
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
    let recoveryDirectory: string | null = null;
    try {
      for (const [index, snapshot] of snapshots.entries()) {
        const isNoOp =
          snapshot.operation.kind === "write"
            ? snapshot.actualHash === sha256(snapshot.operation.content)
            : !snapshot.existed;
        if (isNoOp) {
          continue;
        }
        if (snapshot.existed && recoveryDirectory === null) {
          recoveryDirectory = await createRecoveryDirectory(root);
        }
        snapshot.backupPath =
          recoveryDirectory === null
            ? null
            : await createBackup(snapshot, recoveryDirectory);
        await this.#options.beforeReplace?.({
          index,
          targetPath: snapshot.targetPath,
          backupPath: snapshot.backupPath
        });
        await assertMutationBoundary(root, snapshot);
        applied.push(snapshot);
        if (snapshot.operation.kind === "write") {
          await ensureParentDirectories(root, snapshot);
          await assertMutationBoundary(root, snapshot);
        }
        if (snapshot.operation.kind === "write") {
          await atomicWrite(
            snapshot.targetPath,
            snapshot.operation.content,
            snapshot.existed ? snapshot.mode : 0o600,
            () => assertMutationBoundary(root, snapshot)
          );
        } else {
          await assertMutationBoundary(root, snapshot);
          await unlink(snapshot.targetPath);
          await syncDirectory(dirname(snapshot.targetPath));
        }
      }
      await validate();
    } catch (error) {
      try {
        await rollback(root, applied);
      } catch (rollbackError) {
        const retainedRecoveryPaths = recoveryPaths(snapshots);
        throw new AgentOpsError(
          "ROLLBACK_FAILED",
          "The transaction failed and rollback was incomplete.",
          {
            cause: rollbackError,
            recoveryPaths: retainedRecoveryPaths
          }
        );
      }
      await removeRecoveryDirectory(recoveryDirectory);
      if (
        error instanceof AgentOpsError &&
        error.code === "PRECONDITION_CHANGED"
      ) {
        throw error;
      }
      throw new AgentOpsError(
        "TRANSACTION_FAILED",
        "The transaction failed and all applied operations were rolled back.",
        { cause: error }
      );
    }
    await removeRecoveryDirectory(recoveryDirectory);
  }
}
