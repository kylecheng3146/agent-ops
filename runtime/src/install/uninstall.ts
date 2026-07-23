import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import type {
  InstallManifest,
  ManagedMarkerRecord
} from "../contracts.js";
import { sha256 } from "../fs/hash.js";
import {
  applyManagedBlock,
  managedBlockMarkers,
  removeManagedBlock
} from "../fs/managed-block.js";
import { parseInstallManifest } from "../fs/manifest.js";
import {
  AgentOpsError,
  resolveContainedPath
} from "../fs/paths.js";
import {
  FileTransaction,
  type FileOperation
} from "../fs/transaction.js";
import {
  COMMON_AGENTS_BLOCK,
  COMMON_CLAUDE_BLOCK,
  type HarnessId
} from "./harness.js";

const MANIFEST_PATH = ".agent-ops/manifest.json";
const MAX_UNINSTALL_FILE_BYTES = 1024 * 1024;

export interface UninstallPlan {
  readonly installed: boolean;
  readonly manifest: InstallManifest | null;
  readonly manifestHash: string | null;
  readonly operations: FileOperation[];
}

interface CurrentFile {
  content: string;
  hash: string;
}

interface ExpectedMarker {
  id: string;
  path: string;
  startMarker: string;
  endMarker: string;
  content: string;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readCurrentFile(
  root: string,
  path: string
): Promise<CurrentFile | null> {
  const resolvedPath = await resolveContainedPath(root, path);
  let handle;
  try {
    const before = await lstat(resolvedPath, { bigint: true });
    if (
      !before.isFile() ||
      before.size > BigInt(MAX_UNINSTALL_FILE_BYTES)
    ) {
      throw new AgentOpsError(
        "UNINSTALL_TARGET_INVALID",
        `Uninstall target must be a bounded regular file: ${path}`
      );
    }
    handle = await open(
      resolvedPath,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK
    );
    const opened = await handle.stat({ bigint: true });
    const resolvedAgain = await resolveContainedPath(root, path);
    const after = await lstat(resolvedAgain, { bigint: true });
    if (
      resolvedAgain !== resolvedPath ||
      !opened.isFile() ||
      opened.size > BigInt(MAX_UNINSTALL_FILE_BYTES) ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      throw new AgentOpsError(
        "UNINSTALL_TARGET_INVALID",
        `Uninstall target changed during inspection: ${path}`
      );
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_UNINSTALL_FILE_BYTES) {
      const remaining = MAX_UNINSTALL_FILE_BYTES + 1 - totalBytes;
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(
        chunk,
        0,
        chunk.length,
        null
      );
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_UNINSTALL_FILE_BYTES) {
      throw new AgentOpsError(
        "UNINSTALL_TARGET_TOO_LARGE",
        `Uninstall target exceeds the planning limit: ${path}`
      );
    }
    const content = Buffer.concat(chunks, totalBytes).toString("utf8");
    return { content, hash: sha256(content) };
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function exactMarkerCount(source: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(marker, offset)) !== -1) {
    count += 1;
    offset += marker.length;
  }
  return count;
}

function selectedHarnesses(
  manifest: InstallManifest
): readonly HarnessId[] {
  return manifest.harness === "both"
    ? ["codex", "claude"]
    : [manifest.harness];
}

function expectedMarker(
  manifest: InstallManifest,
  id: HarnessId
): ExpectedMarker {
  const isCodex = id === "codex";
  const markerId = `${id}-routing`;
  const markers = managedBlockMarkers(markerId, 1);
  const instructionFile = isCodex ? "AGENTS.md" : "CLAUDE.md";
  return {
    id: markerId,
    path:
      manifest.scope === "project"
        ? instructionFile
        : `.${id}/${instructionFile}`,
    startMarker: markers.start,
    endMarker: markers.end,
    content: isCodex ? COMMON_AGENTS_BLOCK : COMMON_CLAUDE_BLOCK
  };
}

function manifestOwnershipError(): AgentOpsError {
  return new AgentOpsError(
    "MANIFEST_OWNERSHIP_INVALID",
    "The manifest does not match a supported managed installation shape."
  );
}

function assertSupportedManifestOwnership(
  manifest: InstallManifest
): Map<string, ExpectedMarker> {
  const harnesses = selectedHarnesses(manifest);
  const expectedArtifacts = new Map<string, string>([
    ["config", ".agent-ops/config.json"]
  ]);
  const expectedMarkers = new Map<string, ExpectedMarker>();
  for (const id of harnesses) {
    expectedArtifacts.set(
      `${id}-rules`,
      `.agent-ops/${id === "codex" ? "AGENTS.md" : "CLAUDE.md"}`
    );
    const marker = expectedMarker(manifest, id);
    expectedMarkers.set(marker.id, marker);
  }
  if (
    manifest.artifacts.length !== expectedArtifacts.size ||
    manifest.markers.length !== expectedMarkers.size
  ) {
    throw manifestOwnershipError();
  }
  for (const artifact of manifest.artifacts) {
    if (expectedArtifacts.get(artifact.id) !== artifact.path) {
      throw manifestOwnershipError();
    }
  }
  for (const marker of manifest.markers) {
    const expected = expectedMarkers.get(marker.id);
    if (
      expected === undefined ||
      marker.path !== expected.path ||
      marker.startMarker !== expected.startMarker ||
      marker.endMarker !== expected.endMarker
    ) {
      throw manifestOwnershipError();
    }
  }
  return expectedMarkers;
}

function assertOwnedMarker(
  source: string,
  marker: ManagedMarkerRecord,
  expected: ExpectedMarker
): void {
  const startIndex = source.indexOf(marker.startMarker);
  const endIndex = source.indexOf(marker.endMarker);
  if (
    exactMarkerCount(source, marker.startMarker) !== 1 ||
    exactMarkerCount(source, marker.endMarker) !== 1 ||
    startIndex >= endIndex
  ) {
    throw new AgentOpsError(
      "MANAGED_BLOCK_CHANGED",
      `Managed block boundaries changed after installation: ${marker.path}`
    );
  }
  const expectedBlock = applyManagedBlock("", {
    id: expected.id,
    version: 1,
    content: expected.content
  }).replace(/\n$/u, "");
  const currentBlock = source.slice(
    startIndex,
    endIndex + marker.endMarker.length
  );
  if (currentBlock !== expectedBlock) {
    throw new AgentOpsError(
      "MANAGED_BLOCK_CHANGED",
      `Managed block content changed after installation: ${marker.path}`
    );
  }
}

async function planMarkerFiles(
  root: string,
  markers: readonly ManagedMarkerRecord[],
  expectedMarkers: ReadonlyMap<string, ExpectedMarker>
): Promise<FileOperation[]> {
  const grouped = new Map<string, ManagedMarkerRecord[]>();
  for (const marker of markers) {
    const existing = grouped.get(marker.path) ?? [];
    existing.push(marker);
    grouped.set(marker.path, existing);
  }

  const operations: FileOperation[] = [];
  for (const [path, pathMarkers] of grouped) {
    const current = await readCurrentFile(root, path);
    if (current === null) {
      throw new AgentOpsError(
        "MANAGED_BLOCK_CHANGED",
        `Managed block file is missing: ${path}`
      );
    }
    let content = current.content;
    for (const marker of pathMarkers) {
      const expected = expectedMarkers.get(marker.id);
      if (expected === undefined) {
        throw manifestOwnershipError();
      }
      assertOwnedMarker(content, marker, expected);
      try {
        content = removeManagedBlock(content, marker.id);
      } catch (error) {
        throw new AgentOpsError(
          "MANAGED_BLOCK_CHANGED",
          `Managed block cannot be removed safely: ${path}`,
          { cause: error }
        );
      }
    }
    operations.push(
      content.length === 0
        ? {
            kind: "remove",
            path,
            expectedHash: current.hash
          }
        : {
            kind: "write",
            path,
            content,
            expectedHash: current.hash
          }
    );
  }
  return operations;
}

export async function createUninstallPlan(
  root: string
): Promise<UninstallPlan> {
  const currentManifest = await readCurrentFile(root, MANIFEST_PATH);
  if (currentManifest === null) {
    return {
      installed: false,
      manifest: null,
      manifestHash: null,
      operations: []
    };
  }
  const manifest = parseInstallManifest(currentManifest.content);
  const expectedMarkers =
    assertSupportedManifestOwnership(manifest);
  const operations: FileOperation[] = [];
  for (const artifact of manifest.artifacts) {
    const current = await readCurrentFile(root, artifact.path);
    if (current === null || current.hash !== artifact.hash) {
      throw new AgentOpsError(
        "MANAGED_ARTIFACT_CHANGED",
        `Managed artifact changed after installation: ${artifact.path}`
      );
    }
    operations.push({
      kind: "remove",
      path: artifact.path,
      expectedHash: current.hash
    });
  }
  operations.push(
    ...await planMarkerFiles(
      root,
      manifest.markers,
      expectedMarkers
    )
  );
  operations.push({
    kind: "remove",
    path: MANIFEST_PATH,
    expectedHash: currentManifest.hash
  });
  return {
    installed: true,
    manifest,
    manifestHash: currentManifest.hash,
    operations
  };
}

function allowedPaths(plan: UninstallPlan): Set<string> {
  if (plan.manifest === null) {
    return new Set();
  }
  return new Set([
    ...plan.manifest.artifacts.map(({ path }) => path.toLowerCase()),
    ...plan.manifest.markers.map(({ path }) => path.toLowerCase()),
    MANIFEST_PATH
  ]);
}

function assertUninstallPlan(plan: UninstallPlan): void {
  if (!plan.installed) {
    if (
      plan.manifest !== null ||
      plan.manifestHash !== null ||
      plan.operations.length !== 0
    ) {
      throw new AgentOpsError(
        "INVALID_UNINSTALL_PLAN",
        "An absent installation must have an empty uninstall plan."
      );
    }
    return;
  }
  if (plan.manifest === null || plan.manifestHash === null) {
    throw new AgentOpsError(
      "INVALID_UNINSTALL_PLAN",
      "Installed uninstall plans require a manifest."
    );
  }
  const allowed = allowedPaths(plan);
  const manifestRemovals = plan.operations.filter(
    (operation) =>
      operation.kind === "remove" &&
      operation.path === MANIFEST_PATH &&
      operation.expectedHash === plan.manifestHash
  );
  if (
    manifestRemovals.length !== 1 ||
    plan.operations.some(
      ({ path }) => !allowed.has(path.toLowerCase())
    )
  ) {
    throw new AgentOpsError(
      "INVALID_UNINSTALL_PLAN",
      "Uninstall plan contains an unowned path or manifest mutation."
    );
  }
}

async function validateUninstalled(
  root: string,
  manifest: InstallManifest
): Promise<void> {
  for (const artifact of manifest.artifacts) {
    if (await readCurrentFile(root, artifact.path) !== null) {
      throw new AgentOpsError(
        "UNINSTALL_VALIDATION_FAILED",
        `Managed artifact still exists: ${artifact.path}`
      );
    }
  }
  for (const marker of manifest.markers) {
    const current = await readCurrentFile(root, marker.path);
    if (
      current !== null &&
      (
        current.content.includes(marker.startMarker) ||
        current.content.includes(marker.endMarker)
      )
    ) {
      throw new AgentOpsError(
        "UNINSTALL_VALIDATION_FAILED",
        `Managed block still exists: ${marker.path}`
      );
    }
  }
  if (await readCurrentFile(root, MANIFEST_PATH) !== null) {
    throw new AgentOpsError(
      "UNINSTALL_VALIDATION_FAILED",
      "Installation manifest still exists."
    );
  }
}

export async function applyUninstallPlan(
  root: string,
  plan: UninstallPlan
): Promise<void> {
  assertUninstallPlan(plan);
  const currentPlan = await createUninstallPlan(root);
  if (JSON.stringify(currentPlan) !== JSON.stringify(plan)) {
    throw new AgentOpsError(
      "INVALID_UNINSTALL_PLAN",
      "Uninstall plan no longer matches the current managed installation."
    );
  }
  const manifest = plan.manifest;
  if (!plan.installed || manifest === null) {
    return;
  }
  const transaction = new FileTransaction(root);
  await transaction.apply(
    { operations: plan.operations },
    async () => await validateUninstalled(root, manifest)
  );
}
