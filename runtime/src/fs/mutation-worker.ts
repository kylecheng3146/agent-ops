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
  stat,
  unlink
} from "node:fs/promises";

import { sha256 } from "./hash.js";

interface MutationRequest {
  action: "mkdir" | "remove" | "rmdir" | "write";
  targetName: string;
  expectedHash: string | null;
  expectedParentPath: string;
  parentDevice: string;
  parentInode: string;
  mode?: number;
}

class MutationWorkerError extends Error {
  readonly code: "MUTATION_FAILED" | "PRECONDITION_CHANGED";

  constructor(
    code: "MUTATION_FAILED" | "PRECONDITION_CHANGED",
    message: string
  ) {
    super(message);
    this.code = code;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function parseRequest(value: string | undefined): MutationRequest {
  if (value === undefined) {
    throw new MutationWorkerError("MUTATION_FAILED", "Missing request.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch (error) {
    throw new MutationWorkerError(
      "MUTATION_FAILED",
      `Invalid request: ${String(error)}`
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("action" in parsed) ||
    !["mkdir", "remove", "rmdir", "write"].includes(String(parsed.action)) ||
    !("targetName" in parsed) ||
    typeof parsed.targetName !== "string" ||
    parsed.targetName.length === 0 ||
    parsed.targetName === "." ||
    parsed.targetName === ".." ||
    parsed.targetName.includes("/") ||
    parsed.targetName.includes("\\") ||
    parsed.targetName.includes("\0") ||
    !("expectedHash" in parsed) ||
    (parsed.expectedHash !== null &&
      (typeof parsed.expectedHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(parsed.expectedHash))) ||
    !("expectedParentPath" in parsed) ||
    typeof parsed.expectedParentPath !== "string" ||
    !("parentDevice" in parsed) ||
    typeof parsed.parentDevice !== "string" ||
    !("parentInode" in parsed) ||
    typeof parsed.parentInode !== "string" ||
    ((parsed.action === "write" || parsed.action === "mkdir") &&
      (!("mode" in parsed) ||
        !Number.isInteger(parsed.mode) ||
        (parsed.mode as number) < 0 ||
        (parsed.mode as number) > 0o777))
  ) {
    throw new MutationWorkerError("MUTATION_FAILED", "Invalid request.");
  }
  return parsed as MutationRequest;
}

function normalizedPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

async function assertAnchoredParent(request: MutationRequest): Promise<void> {
  const [canonicalPath, status] = await Promise.all([
    realpath("."),
    stat(".", { bigint: true })
  ]);
  if (
    !status.isDirectory() ||
    normalizedPath(canonicalPath) !==
      normalizedPath(request.expectedParentPath) ||
    status.dev.toString() !== request.parentDevice ||
    status.ino.toString() !== request.parentInode
  ) {
    throw new MutationWorkerError(
      "PRECONDITION_CHANGED",
      "The destination directory changed before mutation."
    );
  }
}

async function currentHash(targetName: string): Promise<string | null> {
  try {
    const status = await lstat(targetName);
    if (!status.isFile() || status.isSymbolicLink()) {
      throw new MutationWorkerError(
        "PRECONDITION_CHANGED",
        "The managed target is no longer a regular file."
      );
    }
    return sha256(await readFile(targetName));
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

async function assertTarget(request: MutationRequest): Promise<void> {
  if ((await currentHash(request.targetName)) !== request.expectedHash) {
    throw new MutationWorkerError(
      "PRECONDITION_CHANGED",
      "The managed target changed before mutation."
    );
  }
}

async function readStandardInput(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function syncCurrentDirectory(): Promise<void> {
  try {
    const directory = await open(".", "r");
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

async function writeTarget(request: MutationRequest): Promise<void> {
  const mode = request.mode;
  if (mode === undefined) {
    throw new MutationWorkerError("MUTATION_FAILED", "Missing write mode.");
  }
  const temporaryName =
    `.${request.targetName}.agent-ops-tmp-${randomUUID()}`;
  let handle;
  try {
    const content = await readStandardInput();
    handle = await open(temporaryName, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryName, mode);
    await assertAnchoredParent(request);
    await assertTarget(request);
    await rename(temporaryName, request.targetName);
    await syncCurrentDirectory();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryName, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function run(): Promise<void> {
  const request = parseRequest(process.argv[2]);
  await assertAnchoredParent(request);
  if (request.action === "write") {
    await assertTarget(request);
    await writeTarget(request);
  } else if (request.action === "remove") {
    await assertTarget(request);
    await unlink(request.targetName);
    await syncCurrentDirectory();
  } else if (request.action === "mkdir") {
    await assertTarget(request);
    const mode = request.mode;
    if (mode === undefined) {
      throw new MutationWorkerError(
        "MUTATION_FAILED",
        "Missing directory mode."
      );
    }
    await mkdir(request.targetName, { mode });
    await chmod(request.targetName, mode);
    await syncCurrentDirectory();
  } else {
    const status = await lstat(request.targetName);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new MutationWorkerError(
        "PRECONDITION_CHANGED",
        "The cleanup target is no longer a directory."
      );
    }
    await rmdir(request.targetName);
    await syncCurrentDirectory();
  }
}

run().catch((error: unknown) => {
  const code =
    error instanceof MutationWorkerError
      ? error.code
      : "MUTATION_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = code === "PRECONDITION_CHANGED" ? 10 : 1;
});
