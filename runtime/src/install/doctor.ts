import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import type {
  AgentOpsConfig,
  InstallManifest
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
import {
  assertExpectedManagedBlock,
  assertSupportedManifestOwnership
} from "./ownership.js";
import { isOpencodeManagedPlugin } from "../adapters/opencode/config.js";
import { resolveProfiles } from "./profiles.js";

const CONFIG_PATH = ".agent-ops/config.json";
const MINIMUM_NODE_VERSION = [22, 14, 0] as const;
const MAX_DOCTOR_FILE_BYTES = 1024 * 1024;

export type DoctorStatus = "PASS" | "FAIL" | "UNKNOWN" | "DEGRADED";

export type DoctorCheckId =
  | "node-version"
  | "manifest"
  | "config"
  | "artifacts"
  | "markers"
  | "hook-registration"
  | "lifecycle-summary"
  | "repository-trust"
  | "smoke-availability";

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  readonly status: DoctorStatus;
  readonly message: string;
}

export type DoctorProbeResult = boolean | DoctorStatus;

export type DoctorProbe = () =>
  | DoctorProbeResult
  | Promise<DoctorProbeResult>;

export interface DoctorProbes {
  readonly hookRegistration?: DoctorProbe;
  readonly repositoryTrust?: DoctorProbe;
  readonly smokeAvailability?: DoctorProbe;
}

export interface DoctorInstallationOptions {
  readonly root: string;
  readonly nodeVersion?: string;
  readonly probes?: DoctorProbes;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
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

function check(
  id: DoctorCheckId,
  status: DoctorStatus,
  message: string
): DoctorCheck {
  return { id, status, message };
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
      `Node ${version} does not meet the minimum version 22.14.0.`
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
        "Installation manifest is missing, unsafe, or invalid."
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
        "Configuration is missing, unsafe, or invalid JSON."
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
          : `Configuration failed validation: ${error.code} at ${error.path}.`
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
): Promise<DoctorCheck> {
  if (manifest === undefined) {
    return check(
      "artifacts",
      "FAIL",
      "Artifacts cannot be verified without a valid manifest."
    );
  }

  const failures: string[] = [];
  for (const artifact of manifest.artifacts) {
    try {
      const content = await readContained(root, artifact.path);
      if (
        sha256(content) !== artifact.hash ||
        (artifact.id === "opencode-plugin" &&
          !isOpencodeManagedPlugin(content.toString("utf8")))
      ) {
        failures.push(artifact.path);
      }
    } catch {
      failures.push(artifact.path);
    }
  }
  return failures.length === 0
    ? check("artifacts", "PASS", "All managed artifacts match their hashes.")
    : check(
        "artifacts",
        "FAIL",
        `Managed artifacts failed verification: ${failures.join(", ")}.`
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
      "Managed blocks cannot be verified without a valid manifest."
    );
  }

  const failures: string[] = [];
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
      assertExpectedManagedBlock(source, marker, expected);
    } catch {
      failures.push(marker.path);
    }
  }
  return failures.length === 0
    ? check("markers", "PASS", "All managed block markers are intact.")
    : check(
        "markers",
        "FAIL",
        `Managed block markers failed verification: ${failures.join(", ")}.`
      );
}

async function checkProbe(
  id:
    | "hook-registration"
    | "repository-trust"
    | "smoke-availability",
  probe: DoctorProbe | undefined
): Promise<DoctorCheck> {
  if (probe === undefined) {
    return check(id, "UNKNOWN", "No probe was provided.");
  }
  try {
    const result = await probe();
    const status: DoctorStatus =
      typeof result === "boolean" ? (result ? "PASS" : "FAIL") : result;
    return check(
      id,
      status,
      status === "PASS"
        ? "Probe passed."
        : status === "FAIL"
          ? "Probe failed."
          : "Probe has nothing to verify yet."
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
      "Lifecycle summary cannot be assessed without a valid manifest and configuration."
    );
  }
  const hasLifecycleSummary =
    config.profiles.length > 0 &&
    resolveProfiles(config.profiles).capabilities.includes(
      "lifecycle-summary"
    );
  if (!hasLifecycleSummary || !manifest.harness.includes("opencode")) {
    return check(
      "lifecycle-summary",
      "PASS",
      "Lifecycle summary has no harness-specific degradation."
    );
  }
  return check(
    "lifecycle-summary",
    "DEGRADED",
    "opencode initializes lifecycle-summary at app init rather than once per session."
  );
}

export async function doctorInstallation(
  options: DoctorInstallationOptions
): Promise<DoctorReport> {
  const manifest = await checkManifest(options.root);
  const config = await checkConfig(options.root);
  const checks: DoctorCheck[] = [
    checkNodeVersion(options.nodeVersion ?? process.versions.node),
    manifest.check,
    config.check,
    await checkArtifacts(options.root, manifest.manifest),
    await checkMarkers(options.root, manifest.manifest),
    await checkProbe(
      "hook-registration",
      options.probes?.hookRegistration
    ),
    checkLifecycleSummary(manifest.manifest, config.config),
    await checkProbe(
      "repository-trust",
      options.probes?.repositoryTrust
    ),
    await checkProbe(
      "smoke-availability",
      options.probes?.smokeAvailability
    )
  ];
  return {
    checks,
    ...(manifest.manifest === undefined
      ? {}
      : { manifest: manifest.manifest }),
    ...(config.config === undefined ? {} : { config: config.config })
  };
}
