import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  readFile,
  realpath,
  stat
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
  device: string | null;
  inode: string | null;
  backupPath: string | null;
  createdDirectories: string[];
}

interface FileIdentity {
  device: string;
  inode: string;
}

interface ParentGuard {
  expectedParentPath: string;
  parentDevice: string;
  parentInode: string;
}

interface AnchoredMutationRequest extends ParentGuard {
  action: "mkdir" | "remove" | "rmdir" | "write";
  targetName: string;
  expectedHash: string | null;
  mode?: number;
}

const MUTATION_WORKER_PATH = fileURLToPath(
  new URL("./mutation-worker.js", import.meta.url)
);

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function normalizedPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

async function captureParentGuard(parent: string): Promise<ParentGuard> {
  const [canonicalPath, status] = await Promise.all([
    realpath(parent),
    stat(parent, { bigint: true })
  ]);
  if (
    !status.isDirectory() ||
    normalizedPath(canonicalPath) !== normalizedPath(parent)
  ) {
    throw new AgentOpsError(
      "PRECONDITION_CHANGED",
      `Destination directory changed before mutation: ${parent}`
    );
  }
  return {
    expectedParentPath: canonicalPath,
    parentDevice: status.dev.toString(),
    parentInode: status.ino.toString()
  };
}

async function runAnchoredMutation(
  targetPath: string,
  action: "mkdir" | "remove" | "rmdir" | "write",
  expectedHash: string | null,
  content?: string | Uint8Array,
  mode?: number
): Promise<void> {
  const parent = dirname(targetPath);
  const guard = await captureParentGuard(parent);
  const request: AnchoredMutationRequest = {
    action,
    targetName: basename(targetPath),
    expectedHash,
    ...guard,
    ...(mode === undefined ? {} : { mode })
  };
  const encodedRequest = Buffer.from(
    JSON.stringify(request),
    "utf8"
  ).toString("base64url");

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [MUTATION_WORKER_PATH, encodedRequest], {
      cwd: parent,
      shell: false,
      stdio: ["pipe", "ignore", "pipe"]
    });
    let standardError = "";
    let settled = false;
    const rejectOnce = (error: unknown): void => {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (standardError.length < 4096) {
        standardError += chunk.slice(0, 4096 - standardError.length);
      }
    });
    child.once("error", (error) => {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ["ENOENT", "ENOTDIR"].includes(String(error.code))
          ? "PRECONDITION_CHANGED"
          : "ANCHORED_MUTATION_FAILED";
      rejectOnce(
        new AgentOpsError(code, "Unable to start an anchored file mutation.", {
          cause: error
        })
      );
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      if (exitCode === 0) {
        resolvePromise();
        return;
      }
      const preconditionChanged =
        exitCode === 10 ||
        standardError.trim() === "PRECONDITION_CHANGED";
      rejectPromise(
        new AgentOpsError(
          preconditionChanged
            ? "PRECONDITION_CHANGED"
            : "ANCHORED_MUTATION_FAILED",
          preconditionChanged
            ? "The target changed before anchored mutation."
            : "The anchored file mutation failed."
        )
      );
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(action === "write" ? content : undefined);
  });
}

async function atomicWrite(
  targetPath: string,
  content: string | Uint8Array,
  mode: number,
  expectedHash: string | null
): Promise<void> {
  await runAnchoredMutation(
    targetPath,
    "write",
    expectedHash,
    content,
    mode
  );
}

async function atomicRemove(
  targetPath: string,
  expectedHash: string
): Promise<void> {
  await runAnchoredMutation(targetPath, "remove", expectedHash);
}

async function atomicMakeDirectory(
  targetPath: string,
  mode: number
): Promise<void> {
  await runAnchoredMutation(targetPath, "mkdir", null, undefined, mode);
}

async function atomicRemoveDirectory(targetPath: string): Promise<void> {
  await runAnchoredMutation(targetPath, "rmdir", null);
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
  await atomicMakeDirectory(recoveryDirectory, 0o700);
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
  await atomicWrite(backupPath, snapshot.content, 0o600, null);
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
      device: status.dev.toString(),
      inode: status.ino.toString(),
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
      device: null,
      inode: null,
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

async function currentIdentity(path: string): Promise<FileIdentity | null> {
  try {
    const status = await lstat(path, { bigint: true });
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new AgentOpsError(
        "PRECONDITION_CHANGED",
        `A managed path is no longer a regular file: ${path}`
      );
    }
    return {
      device: status.dev.toString(),
      inode: status.ino.toString()
    };
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

async function assertSnapshotIdentity(
  snapshot: Snapshot,
  path: string
): Promise<void> {
  if (!snapshot.existed) {
    return;
  }
  const identity = await currentIdentity(path);
  if (
    identity === null ||
    identity.device !== snapshot.device ||
    identity.inode !== snapshot.inode
  ) {
    throw new AgentOpsError(
      "PRECONDITION_CHANGED",
      `Target identity changed for ${snapshot.operation.path}.`
    );
  }
}

async function assertMutationBoundary(
  root: string,
  snapshot: Snapshot
): Promise<void> {
  try {
    const resolved = await resolveContainedPath(root, snapshot.operation.path);
    await assertSnapshotIdentity(snapshot, resolved);
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
        await atomicMakeDirectory(current, 0o700);
        snapshot.createdDirectories.push(current);
      } catch (mkdirError) {
        throw new AgentOpsError(
          "PRECONDITION_CHANGED",
          `Managed parent changed while it was created: ${snapshot.operation.path}`,
          { cause: mkdirError }
        );
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
    await atomicRemoveDirectory(directory);
  }
}

async function rollback(
  root: string,
  snapshots: readonly Snapshot[]
): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    const resolved = await resolveContainedPath(root, snapshot.operation.path);
    const observedHash = await currentHash(resolved);
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
        resolved,
        snapshot.content,
        snapshot.mode,
        desiredHash(snapshot)
      );
    } else {
      const expectedHash = desiredHash(snapshot);
      if (expectedHash === null) {
        throw new AgentOpsError(
          "PRECONDITION_CHANGED",
          `Rollback target disappeared before removal: ${snapshot.operation.path}`
        );
      }
      await atomicRemove(resolved, expectedHash);
      await removeCreatedDirectories(snapshot);
    }
  }
}

async function removeRecoveryDirectory(
  recoveryDirectory: string | null,
  snapshots: readonly Snapshot[]
): Promise<void> {
  if (recoveryDirectory === null) {
    return;
  }
  const cleanupProbe = join(
    dirname(recoveryDirectory),
    `.agent-ops-cleanup-probe-${randomUUID()}`
  );
  await atomicMakeDirectory(cleanupProbe, 0o700);
  await atomicRemoveDirectory(cleanupProbe);
  for (const snapshot of snapshots) {
    if (snapshot.backupPath !== null && snapshot.actualHash !== null) {
      await atomicRemove(snapshot.backupPath, snapshot.actualHash);
    }
  }
  await atomicRemoveDirectory(recoveryDirectory);
}

async function recoveryPaths(
  snapshots: readonly Snapshot[]
): Promise<string[]> {
  const retained: string[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.backupPath === null) {
      continue;
    }
    try {
      const status = await lstat(snapshot.backupPath);
      if (status.isFile() && !status.isSymbolicLink()) {
        retained.push(snapshot.backupPath);
      }
    } catch (error) {
      if (!isMissing(error)) {
        retained.push(snapshot.backupPath);
      }
    }
  }
  return retained;
}

async function cleanupPreparedDirectories(
  root: string,
  snapshot: Snapshot
): Promise<void> {
  if (snapshot.createdDirectories.length === 0) {
    return;
  }
  try {
    const resolved = await resolveContainedPath(root, snapshot.operation.path);
    const identity = await currentIdentity(resolved);
    const identityMatches = snapshot.existed
      ? identity !== null &&
        identity.device === snapshot.device &&
        identity.inode === snapshot.inode
      : identity === null;
    if (
      identityMatches &&
      (await currentHash(resolved)) === snapshot.actualHash
    ) {
      await removeCreatedDirectories(snapshot);
    }
  } catch {
    // A concurrent change owns the path now. Leaving empty directories is safer
    // than deleting through a path whose identity can no longer be proven.
  }
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
        await assertMutationBoundary(root, snapshot);
        if (snapshot.operation.kind === "write") {
          await ensureParentDirectories(root, snapshot);
          await assertMutationBoundary(root, snapshot);
        }
        try {
          await this.#options.beforeReplace?.({
            index,
            targetPath: snapshot.targetPath,
            backupPath: snapshot.backupPath
          });
        } catch (error) {
          await cleanupPreparedDirectories(root, snapshot);
          throw error;
        }
        applied.push(snapshot);
        try {
          if (snapshot.operation.kind === "write") {
            await atomicWrite(
              snapshot.targetPath,
              snapshot.operation.content,
              snapshot.existed ? snapshot.mode : 0o600,
              snapshot.actualHash
            );
          } else {
            if (snapshot.actualHash === null) {
              throw new AgentOpsError(
                "PRECONDITION_CHANGED",
                `Remove target disappeared before mutation: ${snapshot.operation.path}`
              );
            }
            await atomicRemove(snapshot.targetPath, snapshot.actualHash);
          }
        } catch (error) {
          if (
            error instanceof AgentOpsError &&
            error.code === "PRECONDITION_CHANGED"
          ) {
            applied.pop();
            await cleanupPreparedDirectories(root, snapshot);
          }
          throw error;
        }
      }
      await validate();
    } catch (error) {
      try {
        await rollback(root, applied);
      } catch (rollbackError) {
        const retainedRecoveryPaths = await recoveryPaths(snapshots);
        throw new AgentOpsError(
          "ROLLBACK_FAILED",
          "The transaction failed and rollback was incomplete.",
          {
            cause: rollbackError,
            recoveryPaths: retainedRecoveryPaths
          }
        );
      }
      try {
        await removeRecoveryDirectory(recoveryDirectory, snapshots);
      } catch (cleanupError) {
        throw new AgentOpsError(
          "ROLLED_BACK_CLEANUP_FAILED",
          "The transaction was rolled back, but recovery cleanup failed.",
          {
            cause: cleanupError,
            recoveryPaths: await recoveryPaths(snapshots)
          }
        );
      }
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
    try {
      await removeRecoveryDirectory(recoveryDirectory, snapshots);
    } catch (cleanupError) {
      throw new AgentOpsError(
        "COMMITTED_CLEANUP_FAILED",
        "The transaction committed, but recovery cleanup failed.",
        {
          cause: cleanupError,
          recoveryPaths: await recoveryPaths(snapshots)
        }
      );
    }
  }
}
