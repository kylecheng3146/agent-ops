import { lstat, rm } from "node:fs/promises";
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
  const normalizedTarget = path.posix.normalize(portableTarget);
  const isAllowlisted = normalizedTarget === "dist"
    || normalizedTarget.startsWith("dist/")
    || normalizedTarget === ".tmp"
    || normalizedTarget.startsWith(".tmp/");

  if (!isAllowlisted) {
    throw new Error(`Refusing to clean target outside dist/.tmp: ${target}`);
  }

  return path.normalize(normalizedTarget);
}

function isMissingPathError(error) {
  return error instanceof Error
    && "code" in error
    && error.code === "ENOENT";
}

async function rejectSymlinkComponents(target, { cwd, inspect }) {
  let currentPath = path.resolve(cwd);

  for (const component of target.split(path.sep)) {
    currentPath = path.join(currentPath, component);

    try {
      const entry = await inspect(currentPath);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Refusing to clean through symbolic link: ${currentPath}`,
        );
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }
  }
}

export async function cleanTargets(
  targets,
  {
    cwd = process.cwd(),
    inspect = lstat,
    remove = rm,
  } = {},
) {
  const normalizedTargets = targets.map(normalizeCleanTarget);

  for (const target of normalizedTargets) {
    await rejectSymlinkComponents(target, { cwd, inspect });
  }

  for (const target of normalizedTargets) {
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
