import { lstat, readFile } from "node:fs/promises";

import {
  SCHEMA_VERSION,
  type Harness,
  type InstallManifest,
  type InstallScope,
  type ManagedMarkerRecord,
  type ManagedPathRecord,
  type Profile
} from "../contracts.js";
import { sha256 } from "../fs/hash.js";
import {
  applyManagedBlock,
  managedBlockMarkers
} from "../fs/managed-block.js";
import {
  formatInstallManifest,
  parseInstallManifest
} from "../fs/manifest.js";
import {
  AgentOpsError,
  resolveContainedPath
} from "../fs/paths.js";
import type { FileOperation } from "../fs/transaction.js";
import {
  planHarnessContributions,
  type HarnessArtifact,
  type HarnessInstallAdapter,
  type HarnessManagedBlock
} from "./harness.js";
import { resolveProfiles } from "./profiles.js";
import type { Capability } from "./types.js";

const CONFIG_PATH = ".agent-ops/config.json";
const MANIFEST_PATH = ".agent-ops/manifest.json";
const MAX_PLANNED_FILE_BYTES = 1024 * 1024;

export interface CreateInstallPlanOptions {
  readonly root: string;
  readonly scope: InstallScope;
  readonly harness: Harness;
  readonly profiles: readonly Profile[];
  readonly adapters: readonly HarnessInstallAdapter[];
}

export interface InstallPlan {
  readonly scope: InstallScope;
  readonly harness: Harness;
  readonly profiles: readonly Profile[];
  readonly capabilities: readonly Capability[];
  readonly manifest: InstallManifest;
  readonly operations: FileOperation[];
}

interface CurrentFile {
  content: string;
  hash: string;
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
  try {
    const status = await lstat(resolvedPath);
    if (!status.isFile()) {
      throw new AgentOpsError(
        "INSTALL_TARGET_INVALID",
        `Install target must be a regular file: ${path}`
      );
    }
    if (status.size > MAX_PLANNED_FILE_BYTES) {
      throw new AgentOpsError(
        "INSTALL_TARGET_TOO_LARGE",
        `Install target exceeds the planning limit: ${path}`
      );
    }
    const content = await readFile(resolvedPath, "utf8");
    return { content, hash: sha256(content) };
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

function formatConfig(profiles: readonly Profile[]): string {
  return `${JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      profiles,
      verification: { commands: [] },
      pathMappings: [],
      securityExceptions: []
    },
    null,
    2
  )}\n`;
}

function pathKey(path: string): string {
  return path.toLowerCase();
}

function assertUniqueContributions(
  artifacts: readonly HarnessArtifact[],
  blocks: readonly HarnessManagedBlock[]
): void {
  const ids = new Set<string>(["config"]);
  const artifactPaths = new Set<string>([pathKey(CONFIG_PATH)]);
  for (const artifact of artifacts) {
    if (ids.has(artifact.id) || artifactPaths.has(pathKey(artifact.path))) {
      throw new AgentOpsError(
        "INSTALL_PATH_CONFLICT",
        `Harness artifact conflicts with another managed entry: ${artifact.path}`
      );
    }
    ids.add(artifact.id);
    artifactPaths.add(pathKey(artifact.path));
  }

  const markerBoundaries = new Set<string>();
  for (const block of blocks) {
    const markers = managedBlockMarkers(block.id, block.version);
    const key = pathKey(block.path);
    if (
      ids.has(block.id) ||
      artifactPaths.has(key) ||
      markerBoundaries.has(`${key}\0${markers.start}`) ||
      markerBoundaries.has(`${key}\0${markers.end}`)
    ) {
      throw new AgentOpsError(
        "INSTALL_PATH_CONFLICT",
        `Harness block conflicts with another managed entry: ${block.path}`
      );
    }
    ids.add(block.id);
    markerBoundaries.add(`${key}\0${markers.start}`);
    markerBoundaries.add(`${key}\0${markers.end}`);
  }
}

async function readExistingManifest(
  root: string
): Promise<{ manifest: InstallManifest; hash: string } | null> {
  const current = await readCurrentFile(root, MANIFEST_PATH);
  return current === null
    ? null
    : {
        manifest: parseInstallManifest(current.content),
        hash: current.hash
      };
}

function assertCompatibleManifest(
  existing: InstallManifest | null,
  scope: InstallScope,
  harness: Harness
): void {
  if (
    existing !== null &&
    (existing.scope !== scope || existing.harness !== harness)
  ) {
    throw new AgentOpsError(
      "INSTALL_ALREADY_CONFIGURED",
      "Use update to change the scope or harness of an existing installation."
    );
  }
}

function findOwnedArtifact(
  manifest: InstallManifest | null,
  path: string
): ManagedPathRecord | undefined {
  const key = pathKey(path);
  return manifest?.artifacts.find(
    (artifact) => pathKey(artifact.path) === key
  );
}

async function planArtifact(
  root: string,
  artifact: HarnessArtifact,
  existingManifest: InstallManifest | null
): Promise<{
  operation: FileOperation;
  record: ManagedPathRecord;
}> {
  const current = await readCurrentFile(root, artifact.path);
  const owned = findOwnedArtifact(existingManifest, artifact.path);
  if (current !== null && owned === undefined) {
    throw new AgentOpsError(
      "UNMANAGED_INSTALL_PATH",
      `Refusing to replace an unmanaged install artifact: ${artifact.path}`
    );
  }
  if (
    current !== null &&
    owned !== undefined &&
    owned.hash !== current.hash
  ) {
    throw new AgentOpsError(
      "MANAGED_ARTIFACT_CHANGED",
      `Managed artifact changed after installation: ${artifact.path}`
    );
  }
  const hash = sha256(artifact.content);
  return {
    operation: {
      kind: "write",
      path: artifact.path,
      content: artifact.content,
      expectedHash: current?.hash ?? null
    },
    record: {
      id: artifact.id,
      path: artifact.path,
      hash,
      owner: "agent-ops"
    }
  };
}

async function planBlocks(
  root: string,
  blocks: readonly HarnessManagedBlock[]
): Promise<{
  operations: FileOperation[];
  records: ManagedMarkerRecord[];
}> {
  const grouped = new Map<string, HarnessManagedBlock[]>();
  for (const block of blocks) {
    const existing = grouped.get(block.path) ?? [];
    existing.push(block);
    grouped.set(block.path, existing);
  }

  const operations: FileOperation[] = [];
  const records: ManagedMarkerRecord[] = [];
  for (const [path, pathBlocks] of grouped) {
    const current = await readCurrentFile(root, path);
    let content = current?.content ?? "";
    for (const block of pathBlocks) {
      content = applyManagedBlock(content, block);
    }
    const hash = sha256(content);
    operations.push({
      kind: "write",
      path,
      content,
      expectedHash: current?.hash ?? null
    });
    for (const block of pathBlocks) {
      const markers = managedBlockMarkers(block.id, block.version);
      records.push({
        id: block.id,
        path,
        hash,
        owner: "agent-ops",
        startMarker: markers.start,
        endMarker: markers.end
      });
    }
  }
  return { operations, records };
}

export async function createInstallPlan(
  options: CreateInstallPlanOptions
): Promise<InstallPlan> {
  const resolved = resolveProfiles(options.profiles);
  const contribution = await planHarnessContributions(
    options.harness,
    {
      scope: options.scope,
      profiles: resolved.profiles,
      capabilities: resolved.capabilities
    },
    options.adapters
  );
  assertUniqueContributions(
    contribution.artifacts,
    contribution.blocks
  );

  const existing = await readExistingManifest(options.root);
  assertCompatibleManifest(
    existing?.manifest ?? null,
    options.scope,
    options.harness
  );

  const operations: FileOperation[] = [];
  const artifacts: ManagedPathRecord[] = [];
  const config = await planArtifact(
    options.root,
    {
      id: "config",
      path: CONFIG_PATH,
      content: formatConfig(resolved.profiles)
    },
    existing?.manifest ?? null
  );
  operations.push(config.operation);
  artifacts.push(config.record);

  for (const artifact of contribution.artifacts) {
    const planned = await planArtifact(
      options.root,
      artifact,
      existing?.manifest ?? null
    );
    operations.push(planned.operation);
    artifacts.push(planned.record);
  }

  const plannedBlocks = await planBlocks(
    options.root,
    contribution.blocks
  );
  operations.push(...plannedBlocks.operations);
  const manifest: InstallManifest = {
    schemaVersion: SCHEMA_VERSION,
    scope: options.scope,
    harness: options.harness,
    artifacts,
    markers: plannedBlocks.records
  };
  operations.push({
    kind: "write",
    path: MANIFEST_PATH,
    content: formatInstallManifest(manifest),
    expectedHash: existing?.hash ?? null
  });

  return {
    scope: options.scope,
    harness: options.harness,
    profiles: resolved.profiles,
    capabilities: resolved.capabilities,
    manifest,
    operations
  };
}
