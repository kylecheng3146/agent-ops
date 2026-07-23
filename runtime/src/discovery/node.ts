import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import type {
  DiscoveryAdapter,
  DiscoveryEvidence,
  NoMatchDiscoveryResult,
  ProposalDiscoveryResult,
  UserDecisionDiscoveryResult,
  UserDecisionReason,
  VerifierProposal
} from "./types.js";

export type NodePackageManager = "bun" | "npm" | "pnpm" | "yarn";

export interface NodeProposalDiscoveryResult
  extends ProposalDiscoveryResult {
  adapter: "node";
  packageManager: NodePackageManager;
}

export type NodeDiscoveryResult =
  | NodeProposalDiscoveryResult
  | NoMatchDiscoveryResult
  | UserDecisionDiscoveryResult;

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
  { path: "yarn.lock", packageManager: "yarn" }
];
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code
  );
}

async function fileExists(filePath: string): Promise<boolean> {
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

async function readBoundedPackageJson(
  filePath: string
): Promise<string | null> {
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_PACKAGE_JSON_BYTES) {
      const remaining = MAX_PACKAGE_JSON_BYTES + 1 - totalBytes;
      const buffer = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        null
      );
      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes).toString("utf8");
      }
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    return null;
  } catch (error) {
    if (
      hasErrorCode(error, "ELOOP") ||
      hasErrorCode(error, "EMLINK")
    ) {
      return null;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
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
  detail: string
): DiscoveryEvidence {
  return { kind: "file", path: filePath, detail };
}

function userDecision(
  reason: UserDecisionReason,
  message: string,
  evidence: DiscoveryEvidence[]
): UserDecisionDiscoveryResult {
  return {
    kind: "user-decision",
    adapter: "node",
    reason,
    message,
    evidence,
    manualConfigAllowed: true
  };
}

function createTestProposal(
  packageManager: NodePackageManager,
  lockfileEvidence: DiscoveryEvidence[]
): VerifierProposal {
  const args = packageManager === "bun" ? ["run", "test"] : ["test"];
  return {
    id: "node:test",
    command: packageManager,
    args,
    cwd: ".",
    required: true,
    evidence: { kind: "test-count", minimum: 1 },
    sourceEvidence: [
      ...lockfileEvidence,
      {
        kind: "package-script",
        path: "package.json#scripts.test",
        detail: "Found an explicit test script."
      }
    ],
    confidence: "high",
    confirmed: false
  };
}

async function detectLockfiles(root: string): Promise<LockfileDefinition[]> {
  const detected = await Promise.all(
    LOCKFILES.map(async (definition) => (
      await fileExists(path.join(root, definition.path))
        ? definition
        : null
    ))
  );

  return detected.filter(
    (definition): definition is LockfileDefinition => definition !== null
  );
}

export async function discoverNodeProject(
  root: string
): Promise<NodeDiscoveryResult> {
  const packageJsonPath = path.join(root, "package.json");
  if (!await fileExists(packageJsonPath)) {
    return {
      kind: "no-match",
      adapter: "node",
      reason: "not-node-project",
      message: "No package.json was found.",
      evidence: [],
      manualConfigAllowed: true
    };
  }

  const packageEvidence = fileEvidence(
    "package.json",
    "Found Node package metadata.",
  );
  let packageJson: unknown;
  try {
    const source = await readBoundedPackageJson(packageJsonPath);
    if (source === null) {
      return userDecision(
        "invalid-package-json",
        "package.json is unsafe or exceeds the discovery size limit.",
        [packageEvidence]
      );
    }
    packageJson = JSON.parse(source);
  } catch {
    return userDecision(
      "invalid-package-json",
      "package.json could not be parsed; choose verifier commands manually.",
      [packageEvidence]
    );
  }

  const detectedLockfiles = await detectLockfiles(root);
  const lockfileEvidence = detectedLockfiles.map((definition) => fileEvidence(
    definition.path,
    `Detected ${definition.packageManager} lockfile.`
  ));
  const packageManagers = [
    ...new Set(
      detectedLockfiles.map((definition) => definition.packageManager)
    )
  ];

  if (packageManagers.length === 0) {
    return userDecision(
      "missing-lockfile",
      "No recognized package-manager lockfile was found.",
      [packageEvidence]
    );
  }

  if (packageManagers.length > 1) {
    return userDecision(
      "multiple-package-managers",
      "Multiple package managers were detected; select one explicitly.",
      lockfileEvidence
    );
  }

  const scripts = readPackageScripts(packageJson);
  if (scripts.test === undefined) {
    return userDecision(
      "no-known-scripts",
      "No recognized verification script was found.",
      [packageEvidence, ...lockfileEvidence]
    );
  }

  const packageManager = packageManagers[0];
  if (packageManager === undefined) {
    return userDecision(
      "missing-lockfile",
      "No recognized package-manager lockfile was found.",
      [packageEvidence]
    );
  }

  return {
    kind: "proposals",
    adapter: "node",
    packageManager,
    proposals: [createTestProposal(packageManager, lockfileEvidence)],
    evidence: [packageEvidence, ...lockfileEvidence],
    manualConfigAllowed: true
  };
}

export const nodeDiscoveryAdapter: DiscoveryAdapter = {
  id: "node",
  discover: discoverNodeProject
};
