import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type {
  DiscoveryAdapter,
  DiscoveryEvidence,
  DiscoveryResult,
  NodePackageManager,
  UserDecisionReason,
  VerifierProposal,
} from "./types.js";

interface LockfileDefinition {
  path: string;
  packageManager: NodePackageManager;
}

const LOCKFILES: LockfileDefinition[] = [
  { path: "bun.lock", packageManager: "bun" },
  { path: "bun.lockb", packageManager: "bun" },
  { path: "npm-shrinkwrap.json", packageManager: "npm" },
  { path: "package-lock.json", packageManager: "npm" },
  { path: "pnpm-lock.yaml", packageManager: "pnpm" },
  { path: "yarn.lock", packageManager: "yarn" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ENOENT";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function readPackageScripts(value: unknown): Record<string, string> {
  if (!isRecord(value) || !isRecord(value.scripts)) {
    return {};
  }

  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(value.scripts)) {
    if (typeof command === "string" && command.trim().length > 0) {
      scripts[name] = command;
    }
  }
  return scripts;
}

function fileEvidence(
  filePath: string,
  detail: string,
): DiscoveryEvidence {
  return { kind: "file", path: filePath, detail };
}

function userDecision(
  reason: UserDecisionReason,
  message: string,
  evidence: DiscoveryEvidence[],
): DiscoveryResult {
  return {
    kind: "user-decision",
    adapter: "node",
    reason,
    message,
    evidence,
    manualConfigAllowed: true,
  };
}

function createTestProposal(
  packageManager: NodePackageManager,
  lockfileEvidence: DiscoveryEvidence[],
): VerifierProposal {
  return {
    id: "node:test",
    command: packageManager,
    args: ["test"],
    cwd: ".",
    required: true,
    evidence: { kind: "test-count", minimum: 1 },
    sourceEvidence: [
      ...lockfileEvidence,
      {
        kind: "package-script",
        path: "package.json#scripts.test",
        detail: "Found an explicit test script.",
      },
    ],
    confidence: "high",
    confirmed: false,
  };
}

async function detectLockfiles(root: string): Promise<LockfileDefinition[]> {
  const detected = await Promise.all(
    LOCKFILES.map(async (definition) => (
      await fileExists(path.join(root, definition.path))
        ? definition
        : null
    )),
  );

  return detected.filter(
    (definition): definition is LockfileDefinition => definition !== null,
  );
}

export async function discoverNodeProject(
  root: string,
): Promise<DiscoveryResult> {
  const packageJsonPath = path.join(root, "package.json");
  if (!await fileExists(packageJsonPath)) {
    return {
      kind: "no-match",
      adapter: "node",
      reason: "not-node-project",
      message: "No package.json was found.",
      evidence: [],
      manualConfigAllowed: true,
    };
  }

  const packageEvidence = fileEvidence(
    "package.json",
    "Found Node package metadata.",
  );
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    return userDecision(
      "invalid-package-json",
      "package.json could not be parsed; choose verifier commands manually.",
      [packageEvidence],
    );
  }

  const detectedLockfiles = await detectLockfiles(root);
  const lockfileEvidence = detectedLockfiles.map((definition) => fileEvidence(
    definition.path,
    `Detected ${definition.packageManager} lockfile.`,
  ));
  const packageManagers = [
    ...new Set(detectedLockfiles.map((definition) => definition.packageManager)),
  ];

  if (packageManagers.length === 0) {
    return userDecision(
      "missing-lockfile",
      "No recognized package-manager lockfile was found.",
      [packageEvidence],
    );
  }

  if (packageManagers.length > 1) {
    return userDecision(
      "multiple-package-managers",
      "Multiple package managers were detected; select one explicitly.",
      lockfileEvidence,
    );
  }

  const scripts = readPackageScripts(packageJson);
  if (scripts.test === undefined) {
    return userDecision(
      "no-known-scripts",
      "No recognized verification script was found.",
      [packageEvidence, ...lockfileEvidence],
    );
  }

  const packageManager = packageManagers[0];
  if (packageManager === undefined) {
    return userDecision(
      "missing-lockfile",
      "No recognized package-manager lockfile was found.",
      [packageEvidence],
    );
  }

  return {
    kind: "proposals",
    adapter: "node",
    packageManager,
    proposals: [createTestProposal(packageManager, lockfileEvidence)],
    evidence: [packageEvidence, ...lockfileEvidence],
    manualConfigAllowed: true,
  };
}

export const nodeDiscoveryAdapter: DiscoveryAdapter = {
  id: "node",
  discover: discoverNodeProject,
};
