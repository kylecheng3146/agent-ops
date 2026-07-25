import { lstat, realpath } from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

const WINDOWS_RESERVED_SEGMENT =
  /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/i;

export class AgentOpsError extends Error {
  readonly code: string;
  override readonly cause?: unknown;
  readonly recoveryPaths?: readonly string[];

  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; recoveryPaths?: readonly string[] }
  ) {
    super(message);
    this.name = "AgentOpsError";
    this.code = code;
    this.cause = options?.cause;
    this.recoveryPaths = options?.recoveryPaths;
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

function assertPortableRelativePath(path: string): string[] {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new AgentOpsError(
      "PATH_OUTSIDE_ROOT",
      `Path must be portable and relative: ${path}`
    );
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        WINDOWS_RESERVED_SEGMENT.test(segment) ||
        !/^[A-Za-z0-9._-]+$/.test(segment)
    )
  ) {
    throw new AgentOpsError(
      "PATH_OUTSIDE_ROOT",
      `Path contains an unsafe segment: ${path}`
    );
  }
  return segments;
}

function assertContained(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new AgentOpsError(
      "PATH_OUTSIDE_ROOT",
      `Resolved path escapes the managed root: ${candidate}`
    );
  }
}

export async function resolveContainedPath(
  root: string,
  path: string
): Promise<string> {
  const segments = assertPortableRelativePath(path);
  const canonicalRoot = await realpath(resolve(root));
  let current = canonicalRoot;

  for (let index = 0; index < segments.length; index += 1) {
    const candidate = join(current, segments[index]);
    let status;
    try {
      status = await lstat(candidate);
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      const unresolved = join(current, ...segments.slice(index));
      assertContained(canonicalRoot, unresolved);
      return unresolved;
    }

    if (status.isSymbolicLink()) {
      try {
        const linked = await realpath(candidate);
        assertContained(canonicalRoot, linked);
        current = linked;
      } catch (error) {
        if (error instanceof AgentOpsError) {
          throw error;
        }
        throw new AgentOpsError(
          "PATH_OUTSIDE_ROOT",
          `Symlink target cannot be resolved safely: ${path}`,
          { cause: error }
        );
      }
    } else {
      const canonical = await realpath(candidate);
      assertContained(canonicalRoot, canonical);
      current = canonical;
    }
  }

  assertContained(canonicalRoot, current);
  return current;
}
