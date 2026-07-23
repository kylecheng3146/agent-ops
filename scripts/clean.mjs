import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function normalizeCleanTarget(target) {
  if (
    typeof target !== "string"
    || target.length === 0
    || path.posix.isAbsolute(target)
    || path.win32.isAbsolute(target)
  ) {
    throw new Error(`Refusing to clean unsafe target: ${String(target)}`);
  }

  const portableTarget = target.replaceAll("\\", "/");
  if (portableTarget.split("/").includes("..")) {
    throw new Error(`Refusing to clean traversal target: ${target}`);
  }

  const normalizedTarget = path.posix.normalize(portableTarget);
  const isAllowlisted = normalizedTarget === "dist"
    || normalizedTarget === ".tmp";

  if (!isAllowlisted) {
    throw new Error(
      `Refusing to clean target outside top-level dist/.tmp roots: ${target}`,
    );
  }

  return path.normalize(normalizedTarget);
}

function isMissingPathError(error) {
  return error instanceof Error
    && "code" in error
    && error.code === "ENOENT";
}

async function rejectSymlinkTarget(target, inspect) {
  try {
    const entry = await inspect(target);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to clean symbolic link: ${target}`);
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
}

export async function cleanTargets(
  targets,
  {
    canonicalize = realpath,
    cwd = process.cwd(),
    inspect = lstat,
    remove = rm,
  } = {},
) {
  const normalizedTargets = targets.map(normalizeCleanTarget);
  const canonicalCwd = await canonicalize(path.resolve(cwd));
  const absoluteTargets = normalizedTargets.map(
    (target) => path.join(canonicalCwd, target),
  );

  for (const target of absoluteTargets) {
    await rejectSymlinkTarget(target, inspect);
  }

  for (const target of absoluteTargets) {
    await remove(target, { force: true, recursive: true });
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined
  && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  cleanTargets(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
