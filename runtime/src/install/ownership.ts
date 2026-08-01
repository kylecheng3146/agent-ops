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
  harnessDescriptor,
  harnessHookPath,
  routingBlockId,
  selectHarnessHookSurface,
  rulesArtifactId,
  type HarnessId
} from "./harness.js";
import { isOpencodePluginPath } from "../adapters/opencode/config.js";

export interface ExpectedManagedMarker {
  readonly id: string;
  readonly path: string;
  readonly startMarker: string;
  readonly endMarker: string;
  readonly content: string;
  readonly legacyContent: readonly string[];
}

function expectedMarker(
  manifest: InstallManifest,
  id: HarnessId,
  markerId: string
): ExpectedManagedMarker {
  const descriptor = harnessDescriptor(id);
  const markers = managedBlockMarkers(markerId, 1);
  return {
    id: markerId,
    path:
      manifest.scope === "project"
        ? descriptor.control.instructionFile
        : `.${id}/${descriptor.control.instructionFile}`,
    startMarker: markers.start,
    endMarker: markers.end,
    content: descriptor.control.routing.desired,
    legacyContent: descriptor.control.routing.legacy
  };
}

function pathKey(path: string): string {
  return path.toLowerCase();
}

function manifestOwnershipError(): AgentOpsError {
  return new AgentOpsError(
    "MANIFEST_OWNERSHIP_INVALID",
    "The manifest does not match a supported managed installation shape."
  );
}

interface ExpectedArtifactPath {
  readonly path: string;
  readonly ids: Set<string>;
}

/**
 * Hook records are optional: installations without hook capabilities, and
 * manifests written before hook registration existed, carry none.
 */
function assertSupportedHookRecords(
  manifest: InstallManifest,
  harnesses: readonly HarnessId[],
  root?: string
): void {
  const selected = new Set<HarnessId>(harnesses);
  const seen = new Set<string>();
  for (const hook of manifest.hooks ?? []) {
    if (
      !selected.has(hook.harness) ||
      seen.has(hook.harness) ||
      harnessDescriptor(hook.harness).control.buildHooks === undefined ||
      hook.id !== `${hook.harness}-hooks` ||
      hook.events.length === 0
    ) {
      throw manifestOwnershipError();
    }
    try {
      selectHarnessHookSurface({
        harness: hook.harness,
        scope: manifest.scope,
        root,
        persistedPath: hook.path
      });
    } catch {
      throw manifestOwnershipError();
    }
    seen.add(hook.harness);
  }
}

export function assertSupportedManifestOwnership(
  manifest: InstallManifest,
  root?: string
): ReadonlyMap<string, ExpectedManagedMarker> {
  const harnesses = manifest.harness;
  const expectedArtifactPaths = new Map<string, ExpectedArtifactPath>([
    [
      pathKey(".agent-ops/config.json"),
      { path: ".agent-ops/config.json", ids: new Set(["config"]) }
    ]
  ]);
  const requiredArtifactPaths = new Set<string>([
    pathKey(".agent-ops/config.json")
  ]);
  const expectedMarkers = new Map<string, ExpectedManagedMarker>();
  const expectedMarkerPaths = new Set<string>();
  const recordedOpencodePluginPath = manifest.artifacts.find(
    ({ id }) => id === "opencode-plugin"
  )?.path;
  if (
    recordedOpencodePluginPath !== undefined &&
    (!harnesses.includes("opencode") ||
      !isOpencodePluginPath(manifest.scope, recordedOpencodePluginPath))
  ) {
    throw manifestOwnershipError();
  }
  for (const id of harnesses) {
    const descriptor = harnessDescriptor(id);
    const artifactPath = `.agent-ops/${descriptor.control.instructionFile}`;
    const artifactKey = pathKey(artifactPath);
    const artifactEntry = expectedArtifactPaths.get(artifactKey);
    const artifactIds = artifactEntry?.ids ?? new Set<string>();
    artifactIds.add(rulesArtifactId(descriptor));
    // Accept the PR 2 per-harness spelling while update rewrites it to the
    // path-derived ID. This keeps already-installed manifests removable.
    artifactIds.add(`${id}-rules`);
    expectedArtifactPaths.set(artifactKey, {
      path: artifactEntry?.path ?? artifactPath,
      ids: artifactIds
    });
    requiredArtifactPaths.add(artifactKey);

    const markerPath =
      manifest.scope === "project"
        ? descriptor.control.instructionFile
        : `.${id}/${descriptor.control.instructionFile}`;
    const markerKey = pathKey(markerPath);
    expectedMarkerPaths.add(markerKey);
    const currentId = routingBlockId(id, manifest.scope, descriptor);
    const markerIds = new Set([currentId, `${id}-routing`]);
    for (const markerId of markerIds) {
      expectedMarkers.set(
        markerId,
        expectedMarker(manifest, id, markerId)
      );
    }

    if (id === "opencode") {
      const pluginPath =
        recordedOpencodePluginPath ?? harnessHookPath(id, manifest.scope, root);
      const pluginKey = pathKey(pluginPath);
      const pluginEntry = expectedArtifactPaths.get(pluginKey);
      if (pluginEntry !== undefined && pluginEntry.path !== pluginPath) {
        throw manifestOwnershipError();
      }
      const pluginIds = pluginEntry?.ids ?? new Set<string>();
      pluginIds.add("opencode-plugin");
      expectedArtifactPaths.set(pluginKey, {
        path: pluginPath,
        ids: pluginIds
      });
    }
  }
  const opencodePluginPath = harnesses.includes("opencode")
    ? recordedOpencodePluginPath ??
      harnessHookPath("opencode", manifest.scope, root)
    : null;
  const optionalArtifactCount =
    opencodePluginPath !== null &&
    expectedArtifactPaths.has(pathKey(opencodePluginPath))
      ? 1
      : 0;
  if (
    (manifest.artifacts.length !== requiredArtifactPaths.size &&
      manifest.artifacts.length !== requiredArtifactPaths.size +
        optionalArtifactCount) ||
    manifest.markers.length !== expectedMarkerPaths.size
  ) {
    throw manifestOwnershipError();
  }
  for (const artifact of manifest.artifacts) {
    const expected = expectedArtifactPaths.get(pathKey(artifact.path));
    if (
      expected === undefined ||
      expected.path !== artifact.path ||
      !expected.ids.has(artifact.id)
    ) {
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
  assertSupportedHookRecords(manifest, harnesses, root);
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
): "desired" | "legacy" {
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
  const currentBlock = source.slice(
    startIndex,
    endIndex + marker.endMarker.length
  );
  const candidates: readonly ["desired" | "legacy", string][] = [
    ["desired", expected.content],
    ...expected.legacyContent.map(
      (content): ["desired" | "legacy", string] => ["legacy", content]
    )
  ];
  for (const [kind, content] of candidates) {
    const expectedBlock = applyManagedBlock("", {
      id: expected.id,
      version: 1,
      content
    }).replace(/\n$/u, "");
    if (currentBlock === expectedBlock) {
      return kind;
    }
  }
  throw new AgentOpsError(
    "MANAGED_BLOCK_CHANGED",
    `Managed block content changed after installation: ${marker.path}`
  );
}
