import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import type {
  Harness,
  HarnessId,
  InstallManifest,
  ManagedMarkerRecord
} from "../contracts.js";
import { sha256 } from "../fs/hash.js";
import {
  applyManagedBlock,
  removeManagedBlock
} from "../fs/managed-block.js";
import {
  formatInstallManifest,
  parseInstallManifest
} from "../fs/manifest.js";
import {
  AgentOpsError,
  resolveContainedPath
} from "../fs/paths.js";
import {
  FileTransaction,
  type FileOperation
} from "../fs/transaction.js";
import { planHookRemoval } from "./hooks.js";
import {
  assertExpectedManagedBlock,
  assertSupportedManifestOwnership,
  type ExpectedManagedMarker
} from "./ownership.js";
import { isOpencodeManagedPlugin } from "../adapters/opencode/config.js";
import {
  isHarnessId
} from "./harness.js";
import {
  loopLauncherArtifactId,
  loopWindowsLauncherArtifactId,
  loopIgnoreContent,
  selectedLoopHarnesses
} from "./codex-loop.js";
import { validateConfig } from "../schema/validate.js";

const MANIFEST_PATH = ".agent-ops/manifest.json";
const MAX_UNINSTALL_FILE_BYTES = 1024 * 1024;

export interface UninstallPlan {
  readonly installed: boolean;
  readonly manifest: InstallManifest | null;
  readonly manifestHash: string | null;
  readonly operations: FileOperation[];
  /** Present only when `uninstall --harness` keeps part of the installation. */
  readonly selectedHarnesses?: Harness;
  readonly resultingManifest?: InstallManifest;
}

interface CurrentFile {
  content: string;
  hash: string;
}

function pathKey(path: string): string {
  return path.toLowerCase();
}

function selectedSet(harnesses: readonly HarnessId[]): Set<HarnessId> {
  return new Set(harnesses);
}

function artifactOwners(
  manifest: InstallManifest,
  artifact: { readonly id: string; readonly path: string }
): readonly HarnessId[] {
  if (artifact.id === "config") return [];
  if (artifact.id === "opencode-plugin") return ["opencode"];
  if (
    artifact.id === "claude-loop-launcher" ||
    artifact.id === "claude-loop-launcher-windows"
  ) return ["claude"];
  if (artifact.id === "codex-loop-launcher") return ["codex"];
  if (
    artifact.id === "gemini-rules" ||
    pathKey(artifact.path) === pathKey(".agent-ops/GEMINI.md")
  ) return ["agy"];
  if (
    artifact.id === "claude-rules" ||
    pathKey(artifact.path) === pathKey(".agent-ops/CLAUDE.md")
  ) return ["claude"];
  if (
    artifact.id === "agents-rules" ||
    artifact.id === "codex-rules" ||
    artifact.id === "opencode-rules" ||
    pathKey(artifact.path) === pathKey(".agent-ops/AGENTS.md")
  ) {
    return manifest.harness.filter((id) =>
      id === "agy" || id === "codex" || id === "opencode"
    );
  }
  const prefix = artifact.id.replace(/-rules$/u, "");
  return isHarnessId(prefix) ? [prefix] : [];
}

function markerOwners(
  manifest: InstallManifest,
  marker: Pick<ManagedMarkerRecord, "id" | "path">
): readonly HarnessId[] {
  if (marker.id === "loop-state") {
    return selectedLoopHarnesses(manifest.harness);
  }
  if (
    marker.id === "agents-routing" ||
    (manifest.scope === "project" && pathKey(marker.path) === pathKey("AGENTS.md"))
  ) {
    return manifest.harness.filter((id) =>
      id === "agy" || id === "codex" || id === "opencode"
    );
  }
  const prefix = marker.id.replace(/-routing$/u, "");
  return isHarnessId(prefix) ? [prefix] : [];
}

function shouldRemove(
  owners: readonly HarnessId[],
  selected: ReadonlySet<HarnessId>
): boolean {
  return owners.length > 0 && owners.every((id) => selected.has(id));
}

function filterConfigForHarnesses(
  source: string,
  remaining: readonly HarnessId[]
): { content: string; changed: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new AgentOpsError(
      "CONFIG_INVALID_JSON",
      "Managed configuration is not valid JSON.",
      { cause: error }
    );
  }
  const result = validateConfig(parsed);
  if (!result.ok) {
    throw new AgentOpsError(
      "CONFIG_INVALID",
      `${result.errors[0]?.path ?? "$"}: ${
        result.errors[0]?.message ?? "Invalid managed configuration."
      }`
    );
  }
  const config = result.value;
  const reviewRoles = config.reviewRoles
    ?.map((role) => ({
      ...role,
      targets: role.targets.filter((target) => remaining.includes(target))
    }))
    .filter((role) => role.targets.length > 0);
  const next = reviewRoles === undefined
    ? config
    : {
        ...config,
        ...(reviewRoles.length === 0 ? {} : { reviewRoles })
      };
  if (reviewRoles !== undefined && reviewRoles.length === 0) {
    const { reviewRoles: _removed, ...withoutReviewRoles } = next as typeof config;
    return {
      content: `${JSON.stringify(withoutReviewRoles, null, 2)}\n`,
      changed: config.reviewRoles !== undefined
    };
  }
  const content = `${JSON.stringify(next, null, 2)}\n`;
  return { content, changed: content !== source };
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
      !opened.isFile() ||
      opened.size > BigInt(MAX_UNINSTALL_FILE_BYTES) ||
      after.dev !== before.dev ||
      after.ino !== before.ino
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

async function planMarkerFiles(
  root: string,
  markers: readonly ManagedMarkerRecord[],
  expectedMarkers: ReadonlyMap<string, ExpectedManagedMarker>
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
        throw new AgentOpsError(
          "MANIFEST_OWNERSHIP_INVALID",
          "The manifest contains an unsupported managed block."
        );
      }
      assertExpectedManagedBlock(content, marker, expected);
      try {
        content = removeManagedBlock(
          content,
          marker.id,
          expected.markerStyle
        );
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

async function planArtifactRemoval(
  root: string,
  artifact: { readonly id: string; readonly path: string; readonly hash: string }
): Promise<FileOperation> {
  const current = await readCurrentFile(root, artifact.path);
  if (current === null || current.hash !== artifact.hash) {
    throw new AgentOpsError(
      "MANAGED_ARTIFACT_CHANGED",
      `Managed artifact changed after installation: ${artifact.path}`
    );
  }
  if (
    artifact.id === "opencode-plugin" &&
    !isOpencodeManagedPlugin(current.content)
  ) {
    throw new AgentOpsError(
      "MANIFEST_OWNERSHIP_INVALID",
      `The recorded opencode plugin is not an agent-ops managed plugin: ${artifact.path}`
    );
  }
  return {
    kind: "remove",
    path: artifact.path,
    expectedHash: current.hash
  };
}

async function createFullUninstallPlan(
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
    assertSupportedManifestOwnership(manifest, root);
  const operations: FileOperation[] = [];
  for (const artifact of manifest.artifacts) {
    const current = await readCurrentFile(root, artifact.path);
    if (current === null || current.hash !== artifact.hash) {
      throw new AgentOpsError(
        "MANAGED_ARTIFACT_CHANGED",
        `Managed artifact changed after installation: ${artifact.path}`
      );
    }
    if (
      artifact.id === "opencode-plugin" &&
      !isOpencodeManagedPlugin(current.content)
    ) {
      throw new AgentOpsError(
        "MANIFEST_OWNERSHIP_INVALID",
        `The recorded opencode plugin is not an agent-ops managed plugin: ${artifact.path}`
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
  for (const hook of manifest.hooks ?? []) {
    const current = await readCurrentFile(root, hook.path);
    if (current === null) {
      continue;
    }
    const removal = planHookRemoval(hook, current.content);
    operations.push(
      removal.content === null
        ? {
            kind: "remove",
            path: hook.path,
            expectedHash: current.hash,
            disclosure: removal.disclosure
          }
        : {
            kind: "write",
            path: hook.path,
            content: removal.content,
            expectedHash: current.hash,
            disclosure: removal.disclosure
          }
    );
  }
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

async function planLoopMarkerUpdate(
  root: string,
  marker: ManagedMarkerRecord,
  expected: ExpectedManagedMarker,
  remaining: readonly HarnessId[]
): Promise<{ operation?: FileOperation; record: ManagedMarkerRecord }> {
  const current = await readCurrentFile(root, marker.path);
  if (current === null) {
    throw new AgentOpsError(
      "MANAGED_BLOCK_CHANGED",
      `Managed block file is missing: ${marker.path}`
    );
  }
  assertExpectedManagedBlock(current.content, marker, expected);
  const content = applyManagedBlock(
    removeManagedBlock(current.content, marker.id, "hash"),
    {
      id: marker.id,
      version: 1,
      markerStyle: "hash",
      content: loopIgnoreContent(selectedLoopHarnesses(remaining))
    }
  );
  return {
    ...(content === current.content
      ? {}
      : {
          operation: {
            kind: "write" as const,
            path: marker.path,
            content,
            expectedHash: current.hash
          }
        }),
    record: content === current.content
      ? marker
      : {
          ...marker,
          hash: sha256(content)
        }
  };
}

async function planSelectiveUninstall(
  root: string,
  currentManifest: CurrentFile,
  manifest: InstallManifest,
  expectedMarkers: ReadonlyMap<string, ExpectedManagedMarker>,
  selectedHarnesses: Harness
): Promise<UninstallPlan> {
  if (
    selectedHarnesses.length === 0 ||
    selectedHarnesses.some((id) => !isHarnessId(id)) ||
    new Set(selectedHarnesses).size !== selectedHarnesses.length ||
    selectedHarnesses.some((id) => !manifest.harness.includes(id))
  ) {
    throw new AgentOpsError(
      "UNINSTALL_HARNESS_NOT_INSTALLED",
      "Uninstall harness selection must name unique installed harnesses."
    );
  }
  const selected = selectedSet(selectedHarnesses);
  const remaining = manifest.harness.filter((id) => !selected.has(id));
  if (remaining.length === 0) {
    return await createFullUninstallPlan(root);
  }

  const operations: FileOperation[] = [];
  const removedArtifacts = manifest.artifacts.filter((artifact) =>
    shouldRemove(artifactOwners(manifest, artifact), selected)
  );
  const artifacts = manifest.artifacts.filter(
    (artifact) => !removedArtifacts.includes(artifact)
  );
  for (const artifact of removedArtifacts) {
    operations.push(await planArtifactRemoval(root, artifact));
  }

  const removedMarkers = manifest.markers.filter((marker) =>
    shouldRemove(markerOwners(manifest, marker), selected)
  );
  const retainedMarkers = manifest.markers.filter(
    (marker) => !removedMarkers.includes(marker)
  );
  operations.push(...await planMarkerFiles(root, removedMarkers, expectedMarkers));

  const updatedMarkers: ManagedMarkerRecord[] = [];
  for (const marker of retainedMarkers) {
    if (marker.id !== "loop-state") {
      updatedMarkers.push(marker);
      continue;
    }
    const expected = expectedMarkers.get(marker.id);
    if (expected === undefined) {
      throw new AgentOpsError(
        "MANIFEST_OWNERSHIP_INVALID",
        "The manifest contains an unsupported loop marker."
      );
    }
    const planned = await planLoopMarkerUpdate(
      root,
      marker,
      expected,
      remaining
    );
    if (planned.operation !== undefined) {
      operations.push(planned.operation);
    }
    updatedMarkers.push(planned.record);
  }

  const removedHooks = (manifest.hooks ?? []).filter(({ harness }) =>
    selected.has(harness)
  );
  const hooks = (manifest.hooks ?? []).filter(
    (hook) => !removedHooks.includes(hook)
  );
  for (const hook of removedHooks) {
    const current = await readCurrentFile(root, hook.path);
    if (current === null) continue;
    const removal = planHookRemoval(hook, current.content);
    operations.push(
      removal.content === null
        ? {
            kind: "remove",
            path: hook.path,
            expectedHash: current.hash,
            disclosure: removal.disclosure
          }
        : {
            kind: "write",
            path: hook.path,
            content: removal.content,
            expectedHash: current.hash,
            disclosure: removal.disclosure
          }
    );
  }

  const configArtifact = manifest.artifacts.find(({ id }) => id === "config");
  if (configArtifact === undefined) {
    throw new AgentOpsError(
      "MANIFEST_OWNERSHIP_INVALID",
      "The manifest is missing its managed configuration artifact."
    );
  }
  const configCurrent = await readCurrentFile(root, configArtifact.path);
  if (configCurrent === null || configCurrent.hash !== configArtifact.hash) {
    throw new AgentOpsError(
      "MANAGED_ARTIFACT_CHANGED",
      `Managed artifact changed after installation: ${configArtifact.path}`
    );
  }
  const filteredConfig = filterConfigForHarnesses(
    configCurrent.content,
    remaining
  );
  const nextArtifacts = filteredConfig.changed
    ? artifacts.map((artifact) =>
        artifact.id === "config"
          ? { ...artifact, hash: sha256(filteredConfig.content) }
          : artifact
      )
    : artifacts;
  if (filteredConfig.changed) {
    operations.push({
      kind: "write",
      path: configArtifact.path,
      content: filteredConfig.content,
      expectedHash: configCurrent.hash
    });
  }

  const resultingManifest: InstallManifest = {
    schemaVersion: manifest.schemaVersion,
    scope: manifest.scope,
    harness: remaining,
    artifacts: nextArtifacts,
    markers: updatedMarkers,
    ...(hooks.length === 0 ? {} : { hooks })
  };
  // Validate the residual ownership shape before exposing a plan. This keeps
  // the next update/uninstall operation within the same supported boundaries.
  assertSupportedManifestOwnership(resultingManifest, root);
  operations.push({
    kind: "write",
    path: MANIFEST_PATH,
    content: formatInstallManifest(resultingManifest),
    expectedHash: currentManifest.hash
  });
  return {
    installed: true,
    manifest,
    manifestHash: currentManifest.hash,
    operations,
    selectedHarnesses,
    resultingManifest
  };
}

export async function createUninstallPlan(
  root: string,
  selectedHarnesses?: Harness
): Promise<UninstallPlan> {
  if (selectedHarnesses === undefined) {
    return await createFullUninstallPlan(root);
  }
  const currentManifest = await readCurrentFile(root, MANIFEST_PATH);
  if (currentManifest === null) {
    return await createFullUninstallPlan(root);
  }
  const manifest = parseInstallManifest(currentManifest.content);
  const expectedMarkers = assertSupportedManifestOwnership(manifest, root);
  return await planSelectiveUninstall(
    root,
    currentManifest,
    manifest,
    expectedMarkers,
    selectedHarnesses
  );
}

function allowedPaths(plan: UninstallPlan): Set<string> {
  if (plan.manifest === null) {
    return new Set();
  }
  return new Set([
    ...plan.manifest.artifacts.map(({ path }) => path.toLowerCase()),
    ...plan.manifest.markers.map(({ path }) => path.toLowerCase()),
    ...(plan.manifest.hooks ?? []).map(({ path }) => path.toLowerCase()),
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
  if (plan.resultingManifest !== undefined) {
    const selected = plan.selectedHarnesses;
    const expectedRemaining = selected === undefined
      ? []
      : plan.manifest.harness.filter((id) => !selected.includes(id));
    let residualValid = true;
    try {
      assertSupportedManifestOwnership(plan.resultingManifest);
    } catch {
      residualValid = false;
    }
    const manifestWrites = plan.operations.filter(
      (operation) => operation.path === MANIFEST_PATH
    );
    const manifestWrite = manifestWrites[0];
    if (
      selected === undefined ||
      selected.length === 0 ||
      selected.some((id) => !plan.manifest!.harness.includes(id)) ||
      new Set(selected).size !== selected.length ||
      JSON.stringify(expectedRemaining) !==
        JSON.stringify(plan.resultingManifest.harness) ||
      plan.resultingManifest.scope !== plan.manifest.scope ||
      !residualValid ||
      manifestWrites.length !== 1 ||
      manifestWrite?.kind !== "write" ||
      manifestWrite.expectedHash !== plan.manifestHash ||
      manifestWrite.content !== formatInstallManifest(plan.resultingManifest)
    ) {
      throw new AgentOpsError(
        "INVALID_UNINSTALL_PLAN",
        "Selective uninstall plan does not describe the remaining installation."
      );
    }
    const allowed = allowedPaths(plan);
    if (plan.operations.some(({ path }) => !allowed.has(path.toLowerCase()))) {
      throw new AgentOpsError(
        "INVALID_UNINSTALL_PLAN",
        "Uninstall plan contains an unowned path or manifest mutation."
      );
    }
    return;
  }
  if (plan.selectedHarnesses !== undefined) {
    throw new AgentOpsError(
      "INVALID_UNINSTALL_PLAN",
      "A full uninstall plan cannot carry a harness selection."
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
  manifest: InstallManifest,
  resultingManifest?: InstallManifest
): Promise<void> {
  if (resultingManifest !== undefined) {
    const removedArtifacts = manifest.artifacts.filter(
      (artifact) => !resultingManifest.artifacts.some(
        (retained) => retained.path === artifact.path
      )
    );
    for (const artifact of removedArtifacts) {
      if (await readCurrentFile(root, artifact.path) !== null) {
        throw new AgentOpsError(
          "UNINSTALL_VALIDATION_FAILED",
          `Managed artifact still exists: ${artifact.path}`
        );
      }
    }
    for (const artifact of resultingManifest.artifacts) {
      const current = await readCurrentFile(root, artifact.path);
      if (current === null || current.hash !== artifact.hash) {
        throw new AgentOpsError(
          "UNINSTALL_VALIDATION_FAILED",
          `Retained managed artifact is invalid: ${artifact.path}`
        );
      }
    }
    const residualExpected = assertSupportedManifestOwnership(
      resultingManifest,
      root
    );
    const removedMarkers = manifest.markers.filter(
      (marker) => !resultingManifest.markers.some(
        (retained) => retained.id === marker.id && retained.path === marker.path
      )
    );
    for (const marker of removedMarkers) {
      const current = await readCurrentFile(root, marker.path);
      if (
        current !== null &&
        (current.content.includes(marker.startMarker) ||
          current.content.includes(marker.endMarker))
      ) {
        throw new AgentOpsError(
          "UNINSTALL_VALIDATION_FAILED",
          `Managed block still exists: ${marker.path}`
        );
      }
    }
    for (const marker of resultingManifest.markers) {
      const current = await readCurrentFile(root, marker.path);
      const expected = residualExpected.get(marker.id);
      if (current === null || expected === undefined) {
        throw new AgentOpsError(
          "UNINSTALL_VALIDATION_FAILED",
          `Retained managed block is missing: ${marker.path}`
        );
      }
      assertExpectedManagedBlock(current.content, marker, expected);
    }
    const removedHooks = (manifest.hooks ?? []).filter(
      (hook) => !(resultingManifest.hooks ?? []).some(
        (retained) => retained.id === hook.id && retained.path === hook.path
      )
    );
    for (const hook of removedHooks) {
      const current = await readCurrentFile(root, hook.path);
      if (
        current !== null &&
        planHookRemoval(hook, current.content).content !== current.content
      ) {
        throw new AgentOpsError(
          "UNINSTALL_VALIDATION_FAILED",
          `Managed hook handlers still exist: ${hook.path}`
        );
      }
    }
    const installedManifest = await readCurrentFile(root, MANIFEST_PATH);
    if (
      installedManifest === null ||
      installedManifest.content !== formatInstallManifest(resultingManifest)
    ) {
      throw new AgentOpsError(
        "UNINSTALL_VALIDATION_FAILED",
        "The residual installation manifest does not match the approved plan."
      );
    }
    return;
  }
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
  for (const hook of manifest.hooks ?? []) {
    const current = await readCurrentFile(root, hook.path);
    if (
      current !== null &&
      planHookRemoval(hook, current.content).content !== current.content
    ) {
      throw new AgentOpsError(
        "UNINSTALL_VALIDATION_FAILED",
        `Managed hook handlers still exist: ${hook.path}`
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
  const currentPlan = await createUninstallPlan(root, plan.selectedHarnesses);
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
    async () => await validateUninstalled(root, manifest, plan.resultingManifest)
  );
}
