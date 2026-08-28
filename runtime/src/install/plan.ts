import { lstat, readFile } from "node:fs/promises";

import {
  CONFIG_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  type AgentOpsFeatures,
  type ReviewRoleConfig,
  type ReviewTargetId,
  type AgentOpsConfig,
  type Harness,
  type HarnessId,
  type InstallManifest,
  type InstallScope,
  type ManagedHookRecord,
  type ManagedMarkerRecord,
  type ManagedPathRecord,
  type Profile,
  type VerificationCommand,
  type VerificationConfig
} from "../contracts.js";
import { discoverProject } from "../discovery/index.js";
import type { VerifierProposal } from "../discovery/types.js";
import { sha256 } from "../fs/hash.js";
import {
  applyManagedBlock,
  managedBlockMarkers,
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
import type { FileOperation } from "../fs/transaction.js";
import { validateConfig } from "../schema/validate.js";
import {
  planHarnessContributions,
  harnessDescriptor,
  selectHarnessHookSurface,
  type HarnessArtifact,
  type HarnessInstallAdapter,
  type HarnessManagedBlock
} from "./harness.js";
import {
  assertExpectedManagedBlock,
  assertSupportedManifestOwnership,
  type ExpectedManagedMarker
} from "./ownership.js";
import {
  codexHooksExplicitlyDisabled,
  loopLauncherArtifactId,
  loopSeeds,
  planLoopContribution,
  selectedLoopHarnesses
} from "./codex-loop.js";
import { isOpencodeManagedPlugin } from "../adapters/opencode/config.js";
import {
  planHookRegistration,
  planHookRemoval
} from "./hooks.js";
import {
  resolveCapabilities,
  resolveProfiles
} from "./profiles.js";
import type { Capability, HookTargetSelection } from "./types.js";

const CONFIG_PATH = ".agent-ops/config.json";
const MANIFEST_PATH = ".agent-ops/manifest.json";
const MAX_PLANNED_FILE_BYTES = 1024 * 1024;

export interface CreateInstallPlanOptions {
  readonly root: string;
  readonly scope: InstallScope;
  readonly harness: Harness;
  readonly profiles: readonly Profile[];
  readonly adapters: readonly HarnessInstallAdapter[];
  readonly toolkitVersion?: string;
  /**
   * Absolute path to the hook runtime Claude settings should invoke. Hook
   * registration is skipped when the caller cannot supply one.
   */
  readonly hookRuntimePath?: string;
  /** Platform used for generated native hook launchers; defaults to this host. */
  readonly platform?: NodeJS.Platform;
  /** Explicit writable hook surfaces, keyed by harness. */
  readonly hookTargets?: readonly HookTargetSelection[];
  /** Review target CLIs to record in the managed config, in chain order. */
  readonly reviewTargets?: readonly ReviewTargetId[];
  /**
   * Update may reconcile an existing managed installation when the selected
   * harness set or capability-implied hooks changes. Init keeps the existing
   * selection immutable by default.
   */
  readonly allowHarnessChange?: boolean;
  readonly existingConfig?: {
    readonly value: AgentOpsConfig;
    readonly sourceHash: string;
  };
}

export interface InstallPlan {
  readonly scope: InstallScope;
  readonly harness: Harness;
  readonly profiles: readonly Profile[];
  /** Verifier commands proposed by stack detection to fill an empty verification config; empty when none applied. */
  readonly detectedVerification: readonly VerificationCommand[];
  readonly capabilities: readonly Capability[];
  readonly config: AgentOpsConfig;
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

/**
 * Converts a stack-detected verifier proposal into a verification command.
 * Proposal IDs use a colon-separated namespace (e.g. "node:test"); config
 * IDs must be kebab-case identifiers.
 */
function verificationCommandFromProposal(
  proposal: VerifierProposal
): VerificationCommand {
  return {
    id: proposal.id.replace(/:/g, "-"),
    command: proposal.command,
    args: proposal.args,
    cwd: proposal.cwd,
    required: proposal.required,
    evidence: proposal.evidence
  };
}

/**
 * Verification commands are never invented for a project that already
 * declares them; detection only fills the gap while the field is empty, so
 * a deliberate "remove all verifiers" edit is not silently reversed by a
 * different stack adapter next run.
 */
async function detectVerificationCommands(
  root: string
): Promise<VerificationCommand[]> {
  const discovery = await discoverProject(root);
  if (discovery.kind !== "project") {
    return [];
  }
  return discovery.proposals
    .filter((proposal) => proposal.confidence === "high")
    .map(verificationCommandFromProposal);
}

function buildConfig(
  profiles: readonly Profile[],
  existing?: {
    readonly verification: VerificationConfig;
    readonly features: AgentOpsFeatures;
    readonly pathMappings: AgentOpsConfig["pathMappings"];
    readonly securityExceptions: AgentOpsConfig["securityExceptions"];
    readonly reviewRoles?: readonly ReviewRoleConfig[];
  },
  reviewTargets: readonly ReviewTargetId[] = [],
  detectedCommands: readonly VerificationCommand[] = []
): AgentOpsConfig {
  // Absent reviewRoles means external review is disabled; an empty selection
  // must therefore omit the field rather than write an empty array.
  const reviewRoles: readonly ReviewRoleConfig[] | undefined = reviewTargets.length > 0
    ? [{ role: "independent-review", targets: [...reviewTargets] }]
    : existing?.reviewRoles;
  const verification =
    existing?.verification !== undefined &&
    existing.verification.commands.length > 0
      ? existing.verification
      : { commands: [...detectedCommands] };
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    profiles: [...profiles],
    verification,
    features: existing?.features ?? {
      stopVerification: {
        enabled: false
      }
    },
    pathMappings: existing?.pathMappings ?? [],
    securityExceptions: existing?.securityExceptions ?? [],
    ...(reviewRoles === undefined ? {} : { reviewRoles: [...reviewRoles] })
  };
}

async function planConfig(
  root: string,
  profiles: readonly Profile[],
  existingManifest: InstallManifest | null,
  suppliedConfig?: {
    readonly value: AgentOpsConfig;
    readonly sourceHash: string;
  },
  reviewTargets: readonly ReviewTargetId[] = []
): Promise<{
  operation: FileOperation;
  record: ManagedPathRecord;
  config: AgentOpsConfig;
  detectedVerification: readonly VerificationCommand[];
}> {
  const current = await readCurrentFile(root, CONFIG_PATH);
  const owned = findOwnedArtifact(existingManifest, CONFIG_PATH);
  if (current !== null && owned === undefined) {
    throw new AgentOpsError(
      "UNMANAGED_INSTALL_PATH",
      `Refusing to replace an unmanaged install artifact: ${CONFIG_PATH}`
    );
  }

  let existingConfig:
    | {
        readonly verification: VerificationConfig;
        readonly features: AgentOpsFeatures;
        readonly pathMappings: AgentOpsConfig["pathMappings"];
        readonly securityExceptions: AgentOpsConfig["securityExceptions"];
        readonly reviewRoles?: readonly ReviewRoleConfig[];
      }
    | undefined;
  if (suppliedConfig !== undefined) {
    if (
      current === null ||
      current.hash !== suppliedConfig.sourceHash
    ) {
      throw new AgentOpsError(
        "PRECONDITION_CHANGED",
        "Managed configuration changed during plan creation."
      );
    }
    const result = validateConfig(suppliedConfig.value);
    if (!result.ok) {
      throw new AgentOpsError(
        "CONFIG_INVALID",
        `${result.errors[0]?.path ?? "$"}: ${
          result.errors[0]?.message ?? "Invalid managed configuration."
        }`
      );
    }
    existingConfig = result.value;
  } else if (current !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current.content) as unknown;
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
    existingConfig = result.value;
  }

  const detectedCommands =
    existingConfig === undefined ||
    existingConfig.verification.commands.length === 0
      ? await detectVerificationCommands(root)
      : [];
  const config = buildConfig(
    profiles,
    existingConfig,
    reviewTargets,
    detectedCommands
  );
  const content = `${JSON.stringify(config, null, 2)}\n`;
  return {
    operation: {
      kind: "write",
      path: CONFIG_PATH,
      content,
      expectedHash: current?.hash ?? null
    },
    record: {
      id: "config",
      path: CONFIG_PATH,
      hash: sha256(content),
      owner: "agent-ops"
    },
    config,
    detectedVerification: detectedCommands
  };
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
    const markers = managedBlockMarkers(
      block.id,
      block.version,
      block.markerStyle
    );
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
  harness: Harness,
  allowHarnessChange: boolean
): void {
  const harnessChanged =
    existing !== null &&
    (existing.harness.length !== harness.length ||
      !existing.harness.every((id) => harness.includes(id)));
  if (
    existing !== null &&
    (existing.scope !== scope || (harnessChanged && !allowHarnessChange))
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
  if (
    artifact.id === "opencode-plugin" &&
    current !== null &&
    !isOpencodeManagedPlugin(current.content)
  ) {
    throw new AgentOpsError(
      "MANIFEST_OWNERSHIP_INVALID",
      `The recorded opencode plugin is not an agent-ops managed plugin: ${artifact.path}`
    );
  }
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

async function planArtifactRemoval(
  root: string,
  artifact: ManagedPathRecord
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

async function planCreateOnceSeeds(
  root: string,
  seeds: readonly { readonly path: string; readonly content: string }[]
): Promise<FileOperation[]> {
  const operations: FileOperation[] = [];
  for (const seed of seeds) {
    const current = await readCurrentFile(root, seed.path);
    if (current === null) {
      operations.push({
        kind: "write",
        path: seed.path,
        content: seed.content,
        expectedHash: null
      });
    }
  }
  return operations;
}

/**
 * User-owned seed files belong to the first loop install for each harness.
 * An existing loop launcher is the durable installation record: it prevents an
 * update from recreating a file a user intentionally removed, while still
 * allowing loop to be enabled later or for a newly added harness.
 */
function loopHarnessesNeedingSeeds(
  harnesses: Harness,
  existingManifest: InstallManifest | null
): readonly HarnessId[] {
  const existingArtifactIds = new Set(
    existingManifest?.artifacts.map(({ id }) => id) ?? []
  );
  return selectedLoopHarnesses(harnesses).filter(
    (harness) => !existingArtifactIds.has(loopLauncherArtifactId(harness))
  );
}

function markerKey(path: string, id: string): string {
  return `${pathKey(path)}\0${id}`;
}

function assertLoopProfileSupport(
  scope: InstallScope,
  harness: Harness,
  capabilities: readonly Capability[]
): void {
  if (!capabilities.includes("project-loop")) {
    return;
  }
  if (
    scope !== "project" ||
    !harness.some((id) => id === "agy" || id === "codex" || id === "claude")
  ) {
    throw new AgentOpsError(
      "LOOP_PROFILE_UNSUPPORTED",
      "The loop profile requires project scope and the agy, Codex, or Claude harness."
    );
  }
}

async function assertCodexLoopConfiguration(
  root: string,
  harness: Harness,
  capabilities: readonly Capability[]
): Promise<void> {
  if (
    !capabilities.includes("project-loop") ||
    !harness.includes("codex")
  ) {
    return;
  }
  const config = await readCurrentFile(root, ".codex/config.toml");
  if (config !== null && codexHooksExplicitlyDisabled(config.content)) {
    throw new AgentOpsError(
      "CODEX_LOOP_HOOKS_DISABLED",
      "Codex loop installation requires [features] hooks = true; the existing .codex/config.toml explicitly disables hooks."
    );
  }
}

async function planBlocks(
  root: string,
  blocks: readonly HarnessManagedBlock[],
  removals: readonly ManagedMarkerRecord[] = [],
  expectedMarkers: ReadonlyMap<string, ExpectedManagedMarker> = new Map()
): Promise<{
  operations: FileOperation[];
  records: ManagedMarkerRecord[];
}> {
  const grouped = new Map<
    string,
    {
      path: string;
      blocks: HarnessManagedBlock[];
      removals: ManagedMarkerRecord[];
    }
  >();
  for (const block of blocks) {
    const key = pathKey(block.path);
    const existing = grouped.get(key) ?? {
      path: block.path,
      blocks: [],
      removals: []
    };
    existing.blocks.push(block);
    existing.path = block.path;
    grouped.set(key, existing);
  }
  for (const marker of removals) {
    const key = pathKey(marker.path);
    const existing = grouped.get(key) ?? {
      path: marker.path,
      blocks: [],
      removals: []
    };
    existing.removals.push(marker);
    grouped.set(key, existing);
  }

  const operations: FileOperation[] = [];
  const records: ManagedMarkerRecord[] = [];
  for (const {
    path,
    blocks: pathBlocks,
    removals: pathRemovals
  } of grouped.values()) {
    const current = await readCurrentFile(root, path);
    if (pathRemovals.length > 0 && current === null) {
      throw new AgentOpsError(
        "MANAGED_BLOCK_CHANGED",
        `Managed block file is missing: ${path}`
      );
    }
    let content = current?.content ?? "";
    for (const marker of pathRemovals) {
      const expected = expectedMarkers.get(marker.id);
      if (expected === undefined) {
        throw new AgentOpsError(
          "MANIFEST_OWNERSHIP_INVALID",
          "The manifest contains an unsupported managed block."
        );
      }
      assertExpectedManagedBlock(content, marker, expected);
      content = removeManagedBlock(
        content,
        marker.id,
        expected.markerStyle
      );
    }
    for (const block of pathBlocks) {
      content = applyManagedBlock(content, block);
    }
    const hash = sha256(content);
    if (content.length === 0 && current !== null) {
      operations.push({
        kind: "remove",
        path,
        expectedHash: current.hash
      });
    } else {
      operations.push({
        kind: "write",
        path,
        content,
        expectedHash: current?.hash ?? null
      });
    }
    for (const block of pathBlocks) {
      const markers = managedBlockMarkers(
        block.id,
        block.version,
        block.markerStyle
      );
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
  if (
    options.toolkitVersion !== undefined &&
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
      .test(options.toolkitVersion)
  ) {
    throw new AgentOpsError(
      "INVALID_TOOLKIT_VERSION",
      "Toolkit version must be a valid semantic version."
    );
  }
  const resolved =
    options.existingConfig === undefined
      ? resolveProfiles(options.profiles)
      : resolveCapabilities(options.existingConfig.value);
  assertLoopProfileSupport(
    options.scope,
    options.harness,
    resolved.capabilities
  );
  await assertCodexLoopConfiguration(
    options.root,
    options.harness,
    resolved.capabilities
  );
  const existing = await readExistingManifest(options.root);
  assertCompatibleManifest(
    existing?.manifest ?? null,
    options.scope,
    options.harness,
    options.allowHarnessChange === true
  );
  const existingOpencodePluginPath = existing?.manifest.artifacts.find(
    ({ id }) => id === "opencode-plugin"
  )?.path;
  const explicitHookTargets = new Map<HarnessId, string>();
  for (const target of options.hookTargets ?? []) {
    if (
      explicitHookTargets.has(target.harness) ||
      !options.harness.includes(target.harness)
    ) {
      throw new AgentOpsError(
        "HOOK_TARGET_INVALID",
        `Hook target must name one selected harness exactly once: ${target.harness}.`
      );
    }
    if (harnessDescriptor(target.harness).control.buildHooks === undefined) {
      throw new AgentOpsError(
        "HOOK_TARGET_UNSUPPORTED",
        `Harness hook targets are not supported for ${target.harness}.`
      );
    }
    explicitHookTargets.set(target.harness, target.surfaceId);
  }
  if (
    options.hookRuntimePath === undefined &&
    explicitHookTargets.size > 0
  ) {
    throw new AgentOpsError(
      "HOOK_TARGET_REQUIRES_RUNTIME",
      "An explicit hook target requires a hook runtime path."
    );
  }
  const baseContribution = await planHarnessContributions(
    options.harness,
    {
      root: options.root,
      scope: options.scope,
      profiles: resolved.profiles,
      capabilities: resolved.capabilities,
      ...(options.hookRuntimePath === undefined
        ? {}
        : { runtimePath: options.hookRuntimePath }),
      ...(options.toolkitVersion === undefined
        ? {}
        : { toolkitVersion: options.toolkitVersion }),
      ...(existingOpencodePluginPath === undefined
        ? {}
        : { opencodePluginPath: existingOpencodePluginPath })
    },
    options.adapters
  );
  const loopContribution = planLoopContribution({
    scope: options.scope,
    harnesses: options.harness,
    capabilities: resolved.capabilities,
    ...(options.hookRuntimePath === undefined
      ? {}
      : { hookRuntimePath: options.hookRuntimePath })
  });
  const contribution = {
    artifacts: [
      ...baseContribution.artifacts,
      ...loopContribution.artifacts
    ],
    blocks: [...baseContribution.blocks, ...loopContribution.blocks]
  };
  assertUniqueContributions(
    contribution.artifacts,
    contribution.blocks
  );

  const reconcileExisting = existing !== null;
  const expectedExistingMarkers = reconcileExisting
    ? assertSupportedManifestOwnership(existing.manifest, options.root)
    : new Map<string, ExpectedManagedMarker>();
  const desiredArtifactPaths = new Set([
    pathKey(CONFIG_PATH),
    ...contribution.artifacts.map(({ path }) => pathKey(path))
  ]);
  const preservedArtifacts =
    options.hookRuntimePath === undefined &&
    options.allowHarnessChange === true &&
    options.harness.includes("opencode")
      ? (existing?.manifest.artifacts.filter(
          ({ id }) => id === "opencode-plugin"
        ) ?? [])
      : [];
  for (const artifact of preservedArtifacts) {
    const current = await readCurrentFile(options.root, artifact.path);
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
  }
  for (const artifact of preservedArtifacts) {
    desiredArtifactPaths.add(pathKey(artifact.path));
  }
  const artifactsToRemove = reconcileExisting
    ? existing.manifest.artifacts.filter(
        ({ path }) => !desiredArtifactPaths.has(pathKey(path))
      )
    : [];
  const desiredMarkerKeys = new Set(
    contribution.blocks.map(({ path, id }) => markerKey(path, id))
  );
  const markersToRemove = reconcileExisting
    ? existing.manifest.markers.filter(
        ({ path, id }) => !desiredMarkerKeys.has(markerKey(path, id))
      )
    : [];

  const operations: FileOperation[] = [];
  const artifacts: ManagedPathRecord[] = [];
  const config = await planConfig(
    options.root,
    resolved.profiles,
    existing?.manifest ?? null,
    options.existingConfig,
    options.reviewTargets ?? []
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

  if (resolved.capabilities.includes("project-loop")) {
    const seedHarnesses = loopHarnessesNeedingSeeds(
      options.harness,
      existing?.manifest ?? null
    );
    operations.push(
      ...await planCreateOnceSeeds(
        options.root,
        loopSeeds(seedHarnesses)
      )
    );
  }

  artifacts.push(...preservedArtifacts);

  for (const artifact of artifactsToRemove) {
    operations.push(
      await planArtifactRemoval(options.root, artifact)
    );
  }

  const plannedBlocks = await planBlocks(
    options.root,
    contribution.blocks,
    markersToRemove,
    expectedExistingMarkers
  );
  operations.push(...plannedBlocks.operations);

  const hooks: ManagedHookRecord[] = [];
  if (options.hookRuntimePath !== undefined) {
    for (const harness of options.harness) {
      if (harnessDescriptor(harness).control.buildHooks === undefined) {
        continue;
      }
      const existingHook = existing?.manifest.hooks?.find(
        ({ harness: recordHarness }) => recordHarness === harness
      );
      const selectedSurface = selectHarnessHookSurface({
        harness,
        scope: options.scope,
        root: options.root,
        ...(explicitHookTargets.has(harness)
          ? { surfaceId: explicitHookTargets.get(harness) }
          : existingHook === undefined
            ? {}
            : { persistedPath: existingHook.path })
      });
      const hookPath = selectedSurface.path;
      const current = await readCurrentFile(
        options.root,
        hookPath
      );
      const planned = planHookRegistration({
        harness,
        scope: options.scope,
        path: hookPath,
        capabilities: resolved.capabilities,
        runtimePath: options.hookRuntimePath,
        platform: options.platform,
        currentSource: current?.content ?? null
      });
      if (planned === null) {
        continue;
      }
      operations.push({
        kind: "write",
        path: planned.record.path,
        content: planned.content,
        expectedHash: current?.hash ?? null,
        disclosure: planned.disclosure
      });
      hooks.push(planned.record);
    }
  } else if (existing !== null) {
    const selectedHarnesses = new Set(options.harness);
    hooks.push(
      ...(existing.manifest.hooks ?? []).filter(({ harness }) =>
        selectedHarnesses.has(harness)
      )
    );
  }

  if (reconcileExisting) {
    const desiredHookPaths = new Set(
      hooks.map(({ path }) => pathKey(path))
    );
    for (const hook of existing.manifest.hooks ?? []) {
      if (desiredHookPaths.has(pathKey(hook.path))) {
        continue;
      }
      const current = await readCurrentFile(options.root, hook.path);
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
  }

  const manifest: InstallManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    scope: options.scope,
    harness: options.harness,
    artifacts,
    markers: plannedBlocks.records,
    ...(hooks.length === 0 ? {} : { hooks })
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
    config: config.config,
    manifest,
    operations,
    detectedVerification: config.detectedVerification
  };
}
