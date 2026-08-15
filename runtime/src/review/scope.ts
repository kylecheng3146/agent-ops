import { lstat, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { AgentOpsError } from "../fs/paths.js";
import {
  collectBaseChangePaths,
  collectChangeSurface,
  resolveGitCommit,
  type GitRunner
} from "../verify/change-surface.js";

export type ReviewScope =
  | {
      readonly mode: "worktree";
      readonly changedFiles: readonly string[];
    }
  | {
      readonly mode: "base";
      readonly baseRef: string;
      readonly resolvedBase: string;
      readonly changedFiles: readonly string[];
    };

export interface ResolveReviewScopeOptions {
  readonly root: string;
  readonly runner: GitRunner;
  readonly base?: string;
}

function unsafe(message: string): never {
  throw new AgentOpsError("REVIEW_UNSAFE_PATH", message);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function contained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && fromRoot !== "";
}

/** Reject links rather than resolving through them: reviewer scope must stay literal. */
async function assertSafeWorktreePath(
  root: string,
  path: string,
  allowMissing = true
): Promise<void> {
  const canonicalRoot = await realpath(resolve(root));
  let current = canonicalRoot;
  for (const segment of path.split("/")) {
    const candidate = join(current, segment);
    let entry;
    try {
      entry = await lstat(candidate);
    } catch (error) {
      if (isMissing(error)) {
        if (allowMissing) {
          return;
        }
        unsafe(`Review supporting path does not exist: ${path}`);
      }
      throw error;
    }
    if (entry.isSymbolicLink()) {
      unsafe(`Review scope contains a symbolic link: ${path}`);
    }
    const canonical = await realpath(candidate);
    if (!contained(canonicalRoot, canonical)) {
      unsafe(`Review scope escapes the repository: ${path}`);
    }
    current = canonical;
  }
}

async function assertSafeCommittedPath(
  runner: GitRunner,
  path: string,
  refs: readonly string[]
): Promise<void> {
  for (const ref of refs) {
    const result = await runner.run(["ls-tree", "-z", ref, "--", path]);
    if (result.exitCode !== 0) {
      throw new AgentOpsError("REVIEW_SCOPE_GIT_FAILED", "Git could not inspect the review path.");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    } catch (error) {
      throw new AgentOpsError("REVIEW_SCOPE_GIT_FAILED", "Git returned invalid path metadata.", { cause: error });
    }
    for (const entry of text.split("\0")) {
      if (entry.startsWith("120000 ")) {
        unsafe(`Review scope contains a committed symbolic link: ${path}`);
      }
    }
  }
}

async function assertSafePaths(
  root: string,
  paths: readonly string[],
  runner: GitRunner,
  refs: readonly string[] = []
): Promise<void> {
  for (const path of paths) {
    await assertSafeWorktreePath(root, path);
    if (refs.length > 0) {
      await assertSafeCommittedPath(runner, path, refs);
    }
  }
}

export async function resolveReviewScope(
  options: ResolveReviewScopeOptions
): Promise<ReviewScope> {
  const surface = await collectChangeSurface(options.runner);
  if (options.base === undefined) {
    if (surface.paths.length === 0) {
      throw new AgentOpsError("REVIEW_NO_CHANGE_SURFACE", "Review requires at least one changed path.");
    }
    await assertSafePaths(options.root, surface.paths, options.runner);
    return { mode: "worktree", changedFiles: surface.paths };
  }
  if (surface.paths.length > 0) {
    throw new AgentOpsError("REVIEW_DIRTY_WORKTREE", "--base review requires a clean worktree.");
  }
  let resolvedBase: string;
  try {
    resolvedBase = await resolveGitCommit(options.runner, options.base);
  } catch (error) {
    if (error instanceof AgentOpsError) {
      throw new AgentOpsError("REVIEW_INVALID_BASE", "--base must resolve to one commit.", { cause: error });
    }
    throw error;
  }
  let changedFiles: readonly string[];
  try {
    changedFiles = await collectBaseChangePaths(options.runner, resolvedBase);
  } catch (error) {
    if (error instanceof AgentOpsError) {
      throw new AgentOpsError("REVIEW_INVALID_BASE", "Git could not resolve the requested base range.", { cause: error });
    }
    throw error;
  }
  if (changedFiles.length === 0) {
    throw new AgentOpsError("REVIEW_NO_CHANGE_SURFACE", "The requested base range has no changed paths.");
  }
  await assertSafePaths(options.root, changedFiles, options.runner, [resolvedBase, "HEAD"]);
  return { mode: "base", baseRef: options.base, resolvedBase, changedFiles };
}

export function reviewScopeSignature(scope: ReviewScope): string {
  return JSON.stringify(scope);
}

export function isReviewerPolicyPath(path: string): boolean {
  const segments = path.split("/");
  return (
    segments.some((segment) => segment === ".codex" || segment === ".claude") ||
    segments.some((segment) => segment === "AGENTS.md" || segment === "CLAUDE.md") ||
    path === ".agent-ops/config.json"
  );
}

export async function assertSafeSupportingPaths(
  root: string,
  paths: readonly string[]
): Promise<void> {
  for (const path of paths) {
    await assertSafeWorktreePath(root, path, false);
  }
}
