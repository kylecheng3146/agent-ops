import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { WorktreeSetupCommand } from "../contracts.js";

type NodePackageManager = "bun" | "npm" | "pnpm" | "yarn";

interface LockfileDefinition {
  readonly path: string;
  readonly packageManager: NodePackageManager;
}

const LOCKFILES: readonly LockfileDefinition[] = [
  { path: "bun.lock", packageManager: "bun" },
  { path: "bun.lockb", packageManager: "bun" },
  { path: "npm-shrinkwrap.json", packageManager: "npm" },
  { path: "package-lock.json", packageManager: "npm" },
  { path: "pnpm-lock.yaml", packageManager: "pnpm" },
  { path: "yarn.lock", packageManager: "yarn" }
];

const SETUP_COMMANDS: Record<NodePackageManager, readonly string[]> = {
  npm: ["ci"],
  pnpm: ["install", "--frozen-lockfile"],
  yarn: ["install", "--immutable"],
  bun: ["install", "--frozen-lockfile"]
};

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    const status = await lstat(filePath);
    return status.isFile() && !status.isSymbolicLink();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/**
 * Detects project lockfiles and proposes safe, deterministic dependency installation
 * commands for freshly cloned worktrees. Returns an empty array if detection is
 * ambiguous or unsupported.
 */
export async function detectWorktreeSetup(
  root: string
): Promise<WorktreeSetupCommand[]> {
  const detected = await Promise.all(
    LOCKFILES.map(async (def) =>
      (await regularFileExists(join(root, def.path))) ? def.packageManager : null
    )
  );

  const managers = [...new Set(detected.filter((m): m is NodePackageManager => m !== null))];
  if (managers.length !== 1) {
    return [];
  }

  const manager = managers[0];
  const args = SETUP_COMMANDS[manager];
  return [{ command: manager, args: [...args] }];
}

/**
 * Returns a warning message if local environment files (.env) are detected
 * without a .worktreeinclude file to carry them into new worktrees.
 */
export async function checkWorktreeEnvWarning(
  root: string
): Promise<string | undefined> {
  const hasWorktreeInclude = await regularFileExists(join(root, ".worktreeinclude"));
  if (hasWorktreeInclude) {
    return undefined;
  }

  const envCandidates = [".env", ".env.local"];
  for (const candidate of envCandidates) {
    if (await regularFileExists(join(root, candidate))) {
      return "Local environment files (.env) detected without .worktreeinclude; consider creating .worktreeinclude to copy them to new worktrees.";
    }
  }

  return undefined;
}
