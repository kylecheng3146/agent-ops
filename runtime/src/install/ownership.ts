import type {
  InstallManifest,
  ManagedMarkerRecord
} from "../contracts.js";
import {
  applyManagedBlock,
  managedBlockMarkers
} from "../fs/managed-block.js";
import { AgentOpsError } from "../fs/paths.js";
import { harnessDescriptor, type HarnessId } from "./harness.js";
import { hookRegistrationPath } from "./hooks.js";

export interface ExpectedManagedMarker {
  readonly id: string;
  readonly path: string;
  readonly startMarker: string;
  readonly endMarker: string;
  readonly content: string;
}

function expectedMarker(
  manifest: InstallManifest,
  id: HarnessId
): ExpectedManagedMarker {
  const descriptor = harnessDescriptor(id);
  const markerId = `${id}-routing`;
  const markers = managedBlockMarkers(markerId, 1);
  return {
    id: markerId,
    path:
      manifest.scope === "project"
        ? descriptor.instructionFile
        : `.${id}/${descriptor.instructionFile}`,
    startMarker: markers.start,
    endMarker: markers.end,
    content: descriptor.routingBlock
  };
}

function manifestOwnershipError(): AgentOpsError {
  return new AgentOpsError(
    "MANIFEST_OWNERSHIP_INVALID",
    "The manifest does not match a supported managed installation shape."
  );
}

/**
 * Hook records are optional: installations without hook capabilities, and
 * manifests written before hook registration existed, carry none.
 */
function assertSupportedHookRecords(
  manifest: InstallManifest,
  harnesses: readonly HarnessId[]
): void {
  const selected = new Set<HarnessId>(harnesses);
  const seen = new Set<string>();
  for (const hook of manifest.hooks ?? []) {
    if (
      !selected.has(hook.harness) ||
      seen.has(hook.harness) ||
      hook.id !== `${hook.harness}-hooks` ||
      hook.path !== hookRegistrationPath(hook.harness, manifest.scope) ||
      hook.events.length === 0
    ) {
      throw manifestOwnershipError();
    }
    seen.add(hook.harness);
  }
}

export function assertSupportedManifestOwnership(
  manifest: InstallManifest
): ReadonlyMap<string, ExpectedManagedMarker> {
  const harnesses = manifest.harness;
  const expectedArtifacts = new Map<string, string>([
    ["config", ".agent-ops/config.json"]
  ]);
  const expectedMarkers = new Map<string, ExpectedManagedMarker>();
  for (const id of harnesses) {
    expectedArtifacts.set(
      `${id}-rules`,
      `.agent-ops/${harnessDescriptor(id).instructionFile}`
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
  assertSupportedHookRecords(manifest, harnesses);
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
