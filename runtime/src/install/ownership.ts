import type {
  InstallManifest,
  ManagedMarkerRecord
} from "../contracts.js";
import {
  applyManagedBlock,
  managedBlockMarkers
} from "../fs/managed-block.js";
import { AgentOpsError } from "../fs/paths.js";
import {
  COMMON_AGENTS_BLOCK,
  COMMON_CLAUDE_BLOCK,
  type HarnessId
} from "./harness.js";

export interface ExpectedManagedMarker {
  readonly id: string;
  readonly path: string;
  readonly startMarker: string;
  readonly endMarker: string;
  readonly content: string;
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
): ExpectedManagedMarker {
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

export function assertSupportedManifestOwnership(
  manifest: InstallManifest
): ReadonlyMap<string, ExpectedManagedMarker> {
  const harnesses = selectedHarnesses(manifest);
  const expectedArtifacts = new Map<string, string>([
    ["config", ".agent-ops/config.json"]
  ]);
  const expectedMarkers = new Map<string, ExpectedManagedMarker>();
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

function exactMarkerCount(source: string, marker: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(marker, offset)) !== -1) {
    count += 1;
    offset += marker.length;
  }
  return count;
}

export function assertExpectedManagedBlock(
  source: string,
  marker: ManagedMarkerRecord,
  expected: ExpectedManagedMarker
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
