import { TextDecoder } from "node:util";

import { AgentOpsError } from "../fs/paths.js";

const WINDOWS_RESERVED_SEGMENT =
  /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/i;

export interface GitRunResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
}

export interface GitRunner {
  run(args: readonly string[]): Promise<GitRunResult>;
}

export interface ChangeSurface {
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
  readonly paths: readonly string[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function normalizePortablePath(path: string): string {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new AgentOpsError(
      "CHANGE_SURFACE_UNSAFE_PATH",
      `Git reported an unsafe path: ${path}`
    );
  }

  const normalizedSegments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (
      segment === ".." ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_RESERVED_SEGMENT.test(segment) ||
      /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u
        .test(segment)
    ) {
      throw new AgentOpsError(
        "CHANGE_SURFACE_UNSAFE_PATH",
        `Git reported a path with an unsafe segment: ${path}`
      );
    }
    normalizedSegments.push(segment);
  }

  if (normalizedSegments.length === 0) {
    throw new AgentOpsError(
      "CHANGE_SURFACE_UNSAFE_PATH",
      `Git reported an empty normalized path: ${path}`
    );
  }
  return normalizedSegments.join("/");
}

export function parseNulPaths(stdout: Uint8Array): string[] {
  if (stdout.byteLength === 0) {
    return [];
  }
  if (stdout[stdout.byteLength - 1] !== 0) {
    throw new AgentOpsError(
      "CHANGE_SURFACE_INVALID_OUTPUT",
      "Git path output must end with a NUL delimiter."
    );
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch (error: unknown) {
    throw new AgentOpsError(
      "CHANGE_SURFACE_INVALID_OUTPUT",
      "Git path output is not valid UTF-8.",
      { cause: error }
    );
  }

  const entries = decoded.split("\0");
  entries.pop();
  if (entries.some((entry) => entry.length === 0)) {
    throw new AgentOpsError(
      "CHANGE_SURFACE_INVALID_OUTPUT",
      "Git path output contains an empty NUL-delimited entry."
    );
  }
  return sortedUnique(entries.map(normalizePortablePath));
}

async function collectPaths(
  runner: GitRunner,
  args: readonly string[]
): Promise<string[]> {
  const result = await runner.run(args);
  if (result.exitCode !== 0) {
    throw new AgentOpsError(
      "CHANGE_SURFACE_GIT_FAILED",
      `Git command failed with exit code ${result.exitCode}: ${args.join(" ")}`
    );
  }
  return parseNulPaths(result.stdout);
}

export async function collectChangeSurface(
  runner: GitRunner
): Promise<ChangeSurface> {
  const staged = await collectPaths(runner, [
    "diff",
    "--cached",
    "--name-only",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "-z"
  ]);
  const unstaged = await collectPaths(runner, [
    "diff",
    "--name-only",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "-z"
  ]);
  const untracked = await collectPaths(runner, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z"
  ]);

  return {
    staged,
    unstaged,
    untracked,
    paths: sortedUnique([...staged, ...unstaged, ...untracked])
  };
}

function decodeCommit(stdout: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout).trim();
  } catch (error: unknown) {
    throw new AgentOpsError("CHANGE_SURFACE_INVALID_OUTPUT", "Git commit output is not valid UTF-8.", { cause: error });
  }
  if (!/^[a-f0-9]{40,64}$/u.test(text)) {
    throw new AgentOpsError("CHANGE_SURFACE_INVALID_OUTPUT", "Git did not return one commit object ID.");
  }
  return text;
}

export async function resolveGitCommit(
  runner: GitRunner,
  ref: string
): Promise<string> {
  const result = await runner.run([
    "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`
  ]);
  if (result.exitCode !== 0) {
    throw new AgentOpsError("CHANGE_SURFACE_GIT_FAILED", "The requested base ref does not resolve to a commit.");
  }
  return decodeCommit(result.stdout);
}

export async function collectBaseChangePaths(
  runner: GitRunner,
  base: string
): Promise<string[]> {
  return await collectPaths(runner, [
    "diff", "--name-only", "--no-renames", "--no-ext-diff",
    "--no-textconv", "-z", `${base}...HEAD`
  ]);
}
