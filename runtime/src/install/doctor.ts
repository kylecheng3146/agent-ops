import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import type {
  AgentOpsConfig,
  InstallManifest,
  ReviewTargetId
} from "../contracts.js";
import { sha256 } from "../fs/hash.js";
import {
  parseInstallManifest,
  PROJECT_MANIFEST_PATH
} from "../fs/manifest.js";
import {
  resolveContainedPath
} from "../fs/paths.js";
import { validateConfig } from "../schema/validate.js";
import type { ReviewTargetProbeResult } from "../review/probe.js";
import {
  assertExpectedManagedBlock,
  assertSupportedManifestOwnership
} from "./ownership.js";
import { isOpencodeManagedPlugin } from "../adapters/opencode/config.js";
import { harnessDescriptor, managedRules } from "./harness.js";
import { resolveCapabilities, resolveProfiles } from "./profiles.js";
import {
  inspectHarnessSurfaces,
  inspectHarnessRegistrations,
  type HarnessSurfaceStatus
} from "./surface-inspection.js";

const CONFIG_PATH = ".agent-ops/config.json";
const MINIMUM_NODE_VERSION = [22, 14, 0] as const;
const MAX_DOCTOR_FILE_BYTES = 1024 * 1024;

export type DoctorStatus =
  | "PASS"
  | "FAIL"
  | "UNKNOWN"
  | "DEGRADED"
  | "UNSUPPORTED";

export type DoctorCheckId =
  | "node-version"
  | "manifest"
  | "config"
  | "artifacts"
  | "artifact-staleness"
  | "markers"
  | "surface-inventory"
  | "registration-drift"
  | "hook-registration"
  | "lifecycle-summary"
  | "project-loop"
  | "agy-runtime"
  | "repository-trust"
  | "review-targets"
  | "smoke-availability";

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  readonly status: DoctorStatus;
  readonly message: string;
  readonly code?: string;
  readonly remediation?: string;
}

export type DoctorProbeResult =
  | boolean
  | DoctorStatus
  | {
      readonly status: DoctorStatus;
      readonly message?: string;
      readonly remediation?: string;
      readonly code?: string;
    };

export type DoctorProbe = () =>
  | DoctorProbeResult
  | Promise<DoctorProbeResult>;

export type DoctorReviewTargetProbe = (
  target: ReviewTargetId,
  deep: boolean
) => Promise<ReviewTargetProbeResult> | ReviewTargetProbeResult;

export interface DoctorProbes {
  readonly agyRuntime?: DoctorProbe;
  readonly hookRegistration?: DoctorProbe;
  readonly repositoryTrust?: DoctorProbe;
  readonly smokeAvailability?: DoctorProbe;
  readonly reviewTarget?: DoctorReviewTargetProbe;
}

export interface DoctorInstallationOptions {
  readonly root: string;
  readonly nodeVersion?: string;
  /** Version of the toolkit running doctor, used for generated baseline checks. */
  readonly toolkitVersion?: string;
  readonly probes?: DoctorProbes;
  /**
   * Authorizes the expensive depth of the review-targets check: a real print
   * call per target. Off by default because doctor runs often, including in
   * CI, and must not spend tokens or reach the network unasked. Deliberately
   * not `--yes`, which stays inert for doctor.
   */
  readonly checkReviewTargetAuth?: boolean;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly surfaces?: readonly HarnessSurfaceStatus[];
  readonly manifest?: InstallManifest;
  readonly config?: AgentOpsConfig;
}

interface ManifestCheckResult {
  readonly check: DoctorCheck;
  readonly manifest?: InstallManifest;
}

interface ConfigCheckResult {
  readonly check: DoctorCheck;
  readonly config?: AgentOpsConfig;
}

interface ArtifactCheckResult {
  readonly check: DoctorCheck;
  /** Hashes computed while checking managed artifact integrity, keyed by path. */
  readonly hashesByPath: ReadonlyMap<string, string>;
}

function check(
  id: DoctorCheckId,
  status: DoctorStatus,
  message: string,
  code?: string,
  remediation?: string
): DoctorCheck {
  return {
    id,
    status,
    message,
    ...(code === undefined ? {} : { code }),
    ...(remediation === undefined ? {} : { remediation })
  };
}

function parseNodeVersion(
  version: string
): readonly [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match === null) {
    return null;
  }
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parsed.every(Number.isSafeInteger) ? parsed : null;
}

function meetsMinimumNodeVersion(
  version: readonly [number, number, number]
): boolean {
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    const actual = version[index];
    const minimum = MINIMUM_NODE_VERSION[index];
    if (actual !== minimum) {
      return actual > minimum;
    }
  }
  return true;
}

function checkNodeVersion(version: string): DoctorCheck {
  const parsed = parseNodeVersion(version);
  if (parsed === null || !meetsMinimumNodeVersion(parsed)) {
    return check(
      "node-version",
      "FAIL",
      `Node ${version} does not meet the minimum version 22.14.0.`,
      undefined,
      "Install Node 22.14.0 or newer."
    );
  }
  return check(
    "node-version",
    "PASS",
    `Node ${version} meets the minimum version 22.14.0.`
  );
}

async function readContained(
  root: string,
  path: string
): Promise<Buffer> {
  const resolvedPath = await resolveContainedPath(root, path);
  const before = await lstat(resolvedPath, { bigint: true });
  if (
    !before.isFile() ||
    before.size > BigInt(MAX_DOCTOR_FILE_BYTES)
  ) {
    throw new Error("Doctor targets must be bounded regular files.");
  }
  const handle = await open(
    resolvedPath,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const resolvedAgain = await resolveContainedPath(root, path);
    const after = await lstat(resolvedAgain, { bigint: true });
    if (
      !opened.isFile() ||
      opened.size > BigInt(MAX_DOCTOR_FILE_BYTES) ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error("Doctor target identity changed during inspection.");
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_DOCTOR_FILE_BYTES) {
      const remaining = MAX_DOCTOR_FILE_BYTES + 1 - totalBytes;
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(
        chunk,
        0,
        chunk.length,
        null
      );
      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes);
      }
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    throw new Error("Doctor target exceeded its inspection limit.");
  } finally {
    await handle.close();
  }
}

async function readContainedText(
  root: string,
  path: string
): Promise<string> {
  return (await readContained(root, path)).toString("utf8");
}

async function checkManifest(root: string): Promise<ManifestCheckResult> {
  try {
    const manifest = parseInstallManifest(
      await readContainedText(root, PROJECT_MANIFEST_PATH)
    );
    assertSupportedManifestOwnership(manifest, root);
    return {
      check: check("manifest", "PASS", "Installation manifest is valid."),
      manifest
    };
  } catch {
    return {
      check: check(
        "manifest",
        "FAIL",
        "Installation manifest is missing, unsafe, or invalid.",
        undefined,
        "Run `agent-ops init` to create a managed installation."
      )
    };
  }
}

async function checkConfig(root: string): Promise<ConfigCheckResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readContainedText(root, CONFIG_PATH)
    ) as unknown;
  } catch {
    return {
      check: check(
        "config",
        "FAIL",
        "Configuration is missing, unsafe, or invalid JSON.",
        undefined,
        `Fix ${CONFIG_PATH}. Do not run \`agent-ops init\` — it would discard configuration.`
      )
    };
  }

  const result = validateConfig(parsed);
  if (!result.ok) {
    const error = result.errors[0];
    return {
      check: check(
        "config",
        "FAIL",
        error === undefined
          ? "Configuration failed validation."
          : `Configuration failed validation: ${error.code} at ${error.path}.`,
        undefined,
        error === undefined
          ? `Fix ${CONFIG_PATH}. Do not run \`agent-ops init\` — it would discard configuration.`
          : `Fix ${error.path} in ${CONFIG_PATH}. Do not run \`agent-ops init\` — it would discard configuration.`
      )
    };
  }
  return {
    check: check("config", "PASS", "Configuration is valid."),
    config: result.value
  };
}

async function checkArtifacts(
  root: string,
  manifest: InstallManifest | undefined
): Promise<ArtifactCheckResult> {
  if (manifest === undefined) {
    return {
      check: check(
        "artifacts",
        "FAIL",
        "Artifacts cannot be verified without a valid manifest.",
        undefined,
        "Run `agent-ops init` to create a managed installation."
      ),
      hashesByPath: new Map()
    };
  }

  const failures: string[] = [];
  const hashesByPath = new Map<string, string>();
  for (const artifact of manifest.artifacts) {
    try {
      const content = await readContained(root, artifact.path);
      const hash = sha256(content);
      if (
        hash !== artifact.hash ||
        (artifact.id === "opencode-plugin" &&
          !isOpencodeManagedPlugin(content.toString("utf8")))
      ) {
        failures.push(artifact.path);
      } else {
        hashesByPath.set(artifact.path, hash);
      }
    } catch {
      failures.push(artifact.path);
    }
  }
  return {
    check:
      failures.length === 0
        ? check(
            "artifacts",
            "PASS",
            "All managed artifacts match their hashes."
          )
        : check(
            "artifacts",
            "FAIL",
            `Managed artifacts failed verification: ${failures.join(", ")}.`,
            "UPDATE_REQUIRED",
            `Run \`agent-ops update\` to restore managed artifacts. This overwrites ` +
              `${failures.join(", ")}; any local edits to those files will be lost.`
          ),
    hashesByPath
  };
}

function checkArtifactStaleness(
  manifest: InstallManifest | undefined,
  config: AgentOpsConfig | undefined,
  artifacts: ArtifactCheckResult,
  toolkitVersion: string | undefined
): DoctorCheck {
  if (manifest === undefined || config === undefined) {
    return check(
      "artifact-staleness",
      "UNKNOWN",
      "Managed artifact staleness cannot be assessed without a valid manifest and configuration.",
      undefined,
      "No action needed; fix the manifest or config check above first."
    );
  }
  if (artifacts.check.status !== "PASS") {
    return check(
      "artifact-staleness",
      "UNKNOWN",
      "Managed artifact staleness cannot be assessed until artifact integrity passes.",
      undefined,
      "No action needed; fix the artifacts check above first."
    );
  }
  if (toolkitVersion === undefined) {
    return check(
      "artifact-staleness",
      "UNKNOWN",
      "Managed artifact staleness cannot be assessed without the running toolkit version.",
      undefined,
      "No action needed; the CLI did not report its own version."
    );
  }

  const expectedHashesByPath = new Map<string, string>();
  try {
    const resolved =
      config.profiles.length === 0
        ? { profiles: [], capabilities: [] }
        : resolveCapabilities(config);
    for (const id of manifest.harness) {
      const descriptor = harnessDescriptor(id);
      const path = `.agent-ops/${descriptor.control.instructionFile}`;
      if (!expectedHashesByPath.has(path)) {
        expectedHashesByPath.set(
          path,
          sha256(
            managedRules(descriptor, {
              scope: manifest.scope,
              profiles: resolved.profiles,
              capabilities: resolved.capabilities,
              toolkitVersion
            })
          )
        );
      }
    }
  } catch {
    return check(
      "artifact-staleness",
      "UNKNOWN",
      "Managed artifact staleness could not be assessed safely.",
      undefined,
      "No action needed; staleness could not be computed."
    );
  }

  const stalePaths: string[] = [];
  for (const [path, expectedHash] of expectedHashesByPath) {
    const actualHash = artifacts.hashesByPath.get(path);
    if (actualHash === undefined) {
      return check(
        "artifact-staleness",
        "UNKNOWN",
        "Managed artifact staleness could not be assessed safely.",
        undefined,
        "No action needed; staleness could not be computed."
      );
    }
    if (actualHash !== expectedHash) {
      stalePaths.push(path);
    }
  }
  return stalePaths.length === 0
    ? check(
        "artifact-staleness",
        "PASS",
        "Managed artifacts match the current toolkit and configuration."
      )
    : check(
        "artifact-staleness",
        "DEGRADED",
        `Managed artifacts need update: ${stalePaths.join(", ")}; run agent-ops update.`,
        "UPDATE_REQUIRED",
        "Run `agent-ops update`."
      );
}

async function checkMarkers(
  root: string,
  manifest: InstallManifest | undefined
): Promise<DoctorCheck> {
  if (manifest === undefined) {
    return check(
      "markers",
      "FAIL",
      "Managed blocks cannot be verified without a valid manifest.",
      undefined,
      "Run `agent-ops init` to create a managed installation."
    );
  }

  const failures: string[] = [];
  const legacyPaths: string[] = [];
  const expectedMarkers =
    assertSupportedManifestOwnership(manifest, root);
  for (const marker of manifest.markers) {
    try {
      const source = await readContainedText(root, marker.path);
      const expected = expectedMarkers.get(marker.id);
      if (expected === undefined) {
        failures.push(marker.path);
        continue;
      }
      const match = assertExpectedManagedBlock(source, marker, expected);
      if (match === "legacy") {
        legacyPaths.push(marker.path);
      }
    } catch {
      failures.push(marker.path);
    }
  }
  if (failures.length > 0) {
    return check(
      "markers",
      "FAIL",
      `Managed block markers failed verification: ${failures.join(", ")}.`,
      "UPDATE_REQUIRED",
      "Run `agent-ops update`."
    );
  }
  if (legacyPaths.length > 0) {
    return check(
      "markers",
      "DEGRADED",
      `Legacy managed routing blocks need migration: ${legacyPaths.join(", ")}.`,
      "UPDATE_REQUIRED",
      "Run `agent-ops update`."
    );
  }
  return check("markers", "PASS", "All managed block markers are intact.");
}

function defaultProbeRemediation(status: DoctorStatus): string | undefined {
  return status === "PASS" || status === "FAIL"
    ? undefined
    : "No action needed; nothing to verify yet.";
}

async function checkProbe(
  id:
    | "agy-runtime"
    | "hook-registration"
    | "repository-trust"
    | "smoke-availability",
  probe: DoctorProbe | undefined
): Promise<DoctorCheck> {
  if (probe === undefined) {
    return check(
      id,
      "UNKNOWN",
      "No probe was provided.",
      undefined,
      "No action needed; this check requires wiring from the CLI."
    );
  }
  try {
    const result = await probe();
    if (typeof result === "object") {
      const status = result.status;
      return check(
        id,
        status,
        result.message ??
          (status === "PASS"
            ? "Probe passed."
            : status === "FAIL"
              ? "Probe failed."
              : "Probe has nothing to verify yet."),
        result.code,
        result.remediation ?? defaultProbeRemediation(status)
      );
    }
    const status: DoctorStatus =
      typeof result === "boolean" ? (result ? "PASS" : "FAIL") : result;
    return check(
      id,
      status,
      status === "PASS"
        ? "Probe passed."
        : status === "FAIL"
          ? "Probe failed."
          : "Probe has nothing to verify yet.",
      undefined,
      defaultProbeRemediation(status)
    );
  } catch {
    return check(id, "FAIL", "Probe failed.");
  }
}

function checkLifecycleSummary(
  manifest: InstallManifest | undefined,
  config: AgentOpsConfig | undefined
): DoctorCheck {
  if (manifest === undefined || config === undefined) {
    return check(
      "lifecycle-summary",
      "UNKNOWN",
      "Lifecycle summary cannot be assessed without a valid manifest and configuration.",
      undefined,
      "No action needed; fix the manifest or config check above first."
    );
  }
  const hasLifecycleSummary =
    config.profiles.length > 0 &&
    resolveProfiles(config.profiles).capabilities.includes(
      "lifecycle-summary"
    );
  if (!hasLifecycleSummary) {
    return check(
      "lifecycle-summary",
      "PASS",
      "Lifecycle summary has no harness-specific degradation."
    );
  }
  const registrations = manifest.harness.map((id) => ({
    id,
    registration: harnessDescriptor(id).control.registrations.find(
      (candidate) => candidate.capability === "lifecycle-summary"
    )
  }));
  const missing = registrations
    .filter(({ registration }) => registration === undefined)
    .map(({ id }) => id);
  if (missing.length > 0) {
    return check(
      "lifecycle-summary",
      "UNKNOWN",
      `Lifecycle summary registration is missing for ${missing.join(", ")}.`,
      undefined,
      "No action needed; the named harness has no lifecycle-summary registration."
    );
  }
  const unsupported = registrations
    .filter(({ registration }) => registration?.support === "unsupported")
    .map(({ id }) => id);
  if (unsupported.length > 0) {
    return check(
      "lifecycle-summary",
      "UNSUPPORTED",
      `Lifecycle summary is not dispatched for ${unsupported.join(", ")}; advisory runtime wiring is unavailable.`,
      undefined,
      "No action needed; the named harness does not dispatch lifecycle-summary."
    );
  }
  const degraded = registrations
    .filter(({ registration }) => registration?.support === "degraded")
    .map(({ id }) => id);
  if (degraded.length > 0) {
    return check(
      "lifecycle-summary",
      "DEGRADED",
      `Lifecycle summary is degraded for ${degraded.join(", ")}.`,
      undefined,
      "No action needed; the named harness only partially supports lifecycle-summary."
    );
  }
  const unknown = registrations
    .filter(({ registration }) => registration?.support === "unknown")
    .map(({ id }) => id);
  if (unknown.length > 0) {
    return check(
      "lifecycle-summary",
      "UNKNOWN",
      `Lifecycle summary support is unknown for ${unknown.join(", ")}.`,
      undefined,
      "No action needed; support for the named harness has not been characterized."
    );
  }
  return check(
    "lifecycle-summary",
    "PASS",
    "Lifecycle summary is reachable for every selected harness."
  );
}

function checkProjectLoop(
  manifest: InstallManifest | undefined,
  config: AgentOpsConfig | undefined
): DoctorCheck | undefined {
  if (manifest === undefined || config === undefined || !config.profiles.includes("loop")) {
    return undefined;
  }
  return manifest.harness.includes("agy")
    ? check(
        "project-loop",
        "DEGRADED",
        config.features.completionGate.enabled
          ? "agy completion gate uses PreInvocation, PreToolUse(run_command), and Stop; native Stop continuation is host-bounded. Use `agent-ops agy-run -- <args>` for a process-exit gate in headless or CI runs."
          : "agy loop uses only PreInvocation and PreToolUse(run_command); prompt, permission, compact, and subagent events are unavailable."
      )
    : check("project-loop", "PASS", "Project loop events are fully registered.");
}

async function checkSurfaceInventory(
  root: string,
  manifest: InstallManifest | undefined,
  config: AgentOpsConfig | undefined
): Promise<{
  readonly check: DoctorCheck;
  readonly surfaces: readonly HarnessSurfaceStatus[];
}> {
  if (manifest === undefined || config === undefined) {
    return {
      check: check(
        "surface-inventory",
        "UNKNOWN",
        "Harness surfaces cannot be inventoried without a valid manifest and configuration.",
        undefined,
        "No action needed; fix the manifest or config check above first."
      ),
      surfaces: []
    };
  }
  try {
    const surfaces = await inspectHarnessSurfaces({
      root,
      scope: manifest.scope,
      harness: manifest.harness,
      profiles: config.profiles
    });
    const unknown = surfaces.filter(({ status }) => status === "unknown");
    return {
      check: check(
        "surface-inventory",
        unknown.length > 0 ? "UNKNOWN" : "PASS",
        unknown.length > 0
          ? `${unknown.length} harness surface(s) could not be inspected.`
          : "Harness surfaces were inventoried without exposing settings values.",
        undefined,
        unknown.length > 0
          ? "No action needed; see Surfaces below for which ones and why."
          : undefined
      ),
      surfaces
    };
  } catch {
    return {
      check: check(
        "surface-inventory",
        "UNKNOWN",
        "Harness surfaces could not be inspected safely.",
        undefined,
        "No action needed; inspection failed safely."
      ),
      surfaces: []
    };
  }
}

async function checkRegistrationDrift(
  root: string,
  manifest: InstallManifest | undefined,
  config: AgentOpsConfig | undefined
): Promise<DoctorCheck> {
  if (manifest === undefined || config === undefined) {
    return check(
      "registration-drift",
      "UNKNOWN",
      "Hook registration drift cannot be assessed without a valid manifest and configuration.",
      undefined,
      "No action needed; fix the manifest or config check above first."
    );
  }
  try {
    const statuses = await inspectHarnessRegistrations({
      root,
      manifest,
      config
    });
    const drifted = statuses
      .filter(({ registered }) => !registered)
      .map(({ harness }) => harness);
    return drifted.length === 0
      ? check(
          "registration-drift",
          "PASS",
          "Managed hook registrations match the desired capabilities."
        )
      : check(
          "registration-drift",
          "FAIL",
          `Hook registration drift detected for ${drifted.join(", ")}; run agent-ops update.`,
          "UPDATE_REQUIRED",
          "Run `agent-ops update`."
        );
  } catch {
    return check(
      "registration-drift",
      "UNKNOWN",
      "Hook registration drift could not be assessed safely.",
      undefined,
      "No action needed; drift could not be computed."
    );
  }
}

async function checkReviewTargets(
  config: AgentOpsConfig | undefined,
  probe: DoctorReviewTargetProbe | undefined,
  checkAuth: boolean
): Promise<DoctorCheck> {
  const targets = config?.reviewRoles?.find(
    (role) => role.role === "independent-review"
  )?.targets ?? [];
  if (targets.length === 0) {
    return check(
      "review-targets",
      "PASS",
      "External review disabled. Re-run agent-ops init to enable."
    );
  }
  if (probe === undefined) {
    return check(
      "review-targets",
      "PASS",
      `External review targets: ${targets.join(", ")}. ` +
        "Login state unverified; run: agent-ops doctor --check-auth"
    );
  }
  // Every target is probed before reporting: an ineligible entry is only
  // DEGRADED, so returning at the first one would hide a genuinely broken
  // eligible target behind it and make the verdict depend on ordering.
  const failures: DoctorCheck[] = [];
  const degraded: DoctorCheck[] = [];
  for (const target of targets) {
    const result = await probe(target, checkAuth);
    if (result === "missing-executable") {
      failures.push(check(
        "review-targets",
        "FAIL",
        `${target} not found.`,
        undefined,
        `Install ${target}, or remove "${target}" from reviewRoles[].targets.`
      ));
      continue;
    }
    if (result === "ineligible") {
      // Not a broken installation: review simply skips this target. A FAIL here
      // would light up every config that merely still names one.
      degraded.push(check(
        "review-targets",
        "DEGRADED",
        `${target} has no read-only mode and is skipped when reviewing.`,
        undefined,
        `Remove "${target}" from reviewRoles[].targets.`
      ));
      continue;
    }
    if (result === "timeout") {
      failures.push(check(
        "review-targets",
        "FAIL",
        `${target} did not answer in time.`,
        undefined,
        "Re-run: agent-ops doctor --check-auth"
      ));
      continue;
    }
    if (checkAuth && result !== "ok") {
      failures.push(check(
        "review-targets",
        "FAIL",
        `${target} is installed but not authenticated, or it rejected the call.`,
        undefined,
        `Run: ${target} login`
      ));
    }
  }
  const worst = failures[0] ?? degraded[0];
  if (worst !== undefined) {
    return worst;
  }
  return check(
    "review-targets",
    "PASS",
    checkAuth
      ? `External review targets authenticated: ${targets.join(", ")}.`
      : `External review targets: ${targets.join(", ")}. ` +
          "Login state unverified; run: agent-ops doctor --check-auth"
  );
}

export async function doctorInstallation(
  options: DoctorInstallationOptions
): Promise<DoctorReport> {
  const manifest = await checkManifest(options.root);
  const config = await checkConfig(options.root);
  const artifacts = await checkArtifacts(options.root, manifest.manifest);
  const surfaceInventory = await checkSurfaceInventory(
    options.root,
    manifest.manifest,
    config.config
  );
  const checks: DoctorCheck[] = [
    checkNodeVersion(options.nodeVersion ?? process.versions.node),
    manifest.check,
    config.check,
    artifacts.check,
    checkArtifactStaleness(
      manifest.manifest,
      config.config,
      artifacts,
      options.toolkitVersion
    ),
    await checkMarkers(options.root, manifest.manifest),
    surfaceInventory.check,
    await checkRegistrationDrift(
      options.root,
      manifest.manifest,
      config.config
    ),
    await checkProbe(
      "hook-registration",
      options.probes?.hookRegistration
    ),
    checkLifecycleSummary(manifest.manifest, config.config),
    ...(() => {
      const projectLoop = checkProjectLoop(manifest.manifest, config.config);
      return projectLoop === undefined ? [] : [projectLoop];
    })(),
    ...(manifest.manifest?.harness.includes("agy") === true
      ? [await checkProbe("agy-runtime", options.probes?.agyRuntime)]
      : []),
    await checkProbe(
      "repository-trust",
      options.probes?.repositoryTrust
    ),
    await checkProbe(
      "smoke-availability",
      options.probes?.smokeAvailability
    ),
    await checkReviewTargets(
      config.config,
      options.probes?.reviewTarget,
      options.checkReviewTargetAuth === true
    )
  ];
  return {
    checks,
    surfaces: surfaceInventory.surfaces,
    ...(manifest.manifest === undefined
      ? {}
      : { manifest: manifest.manifest }),
    ...(config.config === undefined ? {} : { config: config.config })
  };
}
