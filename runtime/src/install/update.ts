import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import {
  previewConfigMigration,
  type ConfigMigrationPreview,
  type MigrationStep
} from "../config/migrate.js";
import { sha256 } from "../fs/hash.js";
import {
  AgentOpsError,
  resolveContainedPath
} from "../fs/paths.js";
import type { RegistryClient } from "../registry/npm.js";
import { applyInstallPlan } from "./apply.js";
import { doctorInstallation, type DoctorStatus } from "./doctor.js";
import type { HarnessInstallAdapter } from "./harness.js";
import type { Harness } from "../contracts.js";
import type { HookTargetSelection } from "./types.js";
import {
  createInstallPlan,
  type InstallPlan
} from "./plan.js";

const PACKAGE_NAME = "@kylecheng3146/agent-ops";
const CONFIG_PATH = ".agent-ops/config.json";
const MAX_UPDATE_CONFIG_BYTES = 1024 * 1024;
const TOOLKIT_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

interface ManagedConfigPreview extends ConfigMigrationPreview {
  readonly sourceHash: string;
}

export interface CreateUpdatePlanOptions {
  readonly root: string;
  readonly adapters: readonly HarnessInstallAdapter[];
  readonly targetVersion?: string;
  /** Version of the toolkit rendering managed baseline content. */
  readonly toolkitVersion?: string;
  readonly registry?: RegistryClient;
  readonly packageName?: string;
  readonly hookRuntimePath?: string;
  readonly hookTargets?: readonly HookTargetSelection[];
  /** Select a new harness set; update reconciles removed managed paths. */
  readonly harness?: Harness;
}

export interface UpdatePlan {
  readonly targetVersion: string;
  readonly migrationSteps: readonly MigrationStep[];
  readonly installation: InstallPlan;
}

async function readBoundedConfig(root: string): Promise<Buffer> {
  const resolvedPath = await resolveContainedPath(root, CONFIG_PATH);
  const before = await lstat(resolvedPath, { bigint: true });
  if (
    !before.isFile() ||
    before.size > BigInt(MAX_UPDATE_CONFIG_BYTES)
  ) {
    throw new AgentOpsError(
      "UPDATE_INSTALLATION_INVALID",
      "Update requires a bounded regular configuration file."
    );
  }

  const handle = await open(
    resolvedPath,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const resolvedAgain = await resolveContainedPath(root, CONFIG_PATH);
    const after = await lstat(resolvedAgain, { bigint: true });
    if (
      !opened.isFile() ||
      opened.size > BigInt(MAX_UPDATE_CONFIG_BYTES) ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new AgentOpsError(
        "UPDATE_INSTALLATION_INVALID",
        "Configuration identity changed during update planning."
      );
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_UPDATE_CONFIG_BYTES) {
      const remaining =
        MAX_UPDATE_CONFIG_BYTES + 1 - totalBytes;
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
    throw new AgentOpsError(
      "UPDATE_INSTALLATION_INVALID",
      "Configuration exceeded the update planning limit."
    );
  } finally {
    await handle.close();
  }
}

async function previewManagedConfig(
  root: string
): Promise<ManagedConfigPreview> {
  let source: Buffer;
  let parsed: unknown;
  try {
    source = await readBoundedConfig(root);
    parsed = JSON.parse(source.toString("utf8")) as unknown;
  } catch (error) {
    if (
      error instanceof AgentOpsError &&
      error.code === "UPDATE_INSTALLATION_INVALID"
    ) {
      throw error;
    }
    throw new AgentOpsError(
      "UPDATE_INSTALLATION_INVALID",
      "Update requires valid configuration JSON."
    );
  }

  try {
    return {
      ...previewConfigMigration(parsed),
      sourceHash: sha256(source)
    };
  } catch {
    throw new AgentOpsError(
      "UPDATE_INSTALLATION_INVALID",
      "Update requires a valid or migratable configuration."
    );
  }
}

function statusOf(
  report: Awaited<ReturnType<typeof doctorInstallation>>,
  id: "config" | "manifest" | "markers" | "node-version"
): DoctorStatus | undefined {
  return report.checks.find((candidate) => candidate.id === id)?.status;
}

export async function createUpdatePlan(
  options: CreateUpdatePlanOptions
): Promise<UpdatePlan> {
  const targetVersion =
    options.targetVersion ??
    (
      options.registry === undefined
        ? undefined
        : await options.registry.latestVersion(
            options.packageName ?? PACKAGE_NAME
          )
    );
  if (targetVersion === undefined) {
    throw new AgentOpsError(
      "UPDATE_TARGET_REQUIRED",
      "Update requires a target version or an explicit registry client."
    );
  }
  if (!TOOLKIT_VERSION_PATTERN.test(targetVersion)) {
    throw new AgentOpsError(
      "INVALID_TOOLKIT_VERSION",
      "Toolkit version must be a valid semantic version."
    );
  }

  const report = await doctorInstallation({ root: options.root });
  for (const id of [
    "node-version",
    "manifest",
    "markers"
  ] as const) {
    const status = statusOf(report, id);
    if (
      status !== "PASS" &&
      !(id === "markers" && status === "DEGRADED")
    ) {
      throw new AgentOpsError(
        "UPDATE_INSTALLATION_INVALID",
        `Update requires a passing ${id} doctor check.`
      );
    }
  }
  if (report.manifest === undefined) {
    throw new AgentOpsError(
      "UPDATE_INSTALLATION_INVALID",
      "Update requires a valid manifest."
    );
  }
  const configPreview = await previewManagedConfig(options.root);
  if (
    statusOf(report, "config") !== "PASS" &&
    configPreview.steps.length === 0
  ) {
    throw new AgentOpsError(
      "UPDATE_INSTALLATION_INVALID",
      "Update requires a passing config doctor check."
    );
  }

  const installation = await createInstallPlan({
    root: options.root,
    scope: report.manifest.scope,
    harness: options.harness ?? report.manifest.harness,
    profiles: configPreview.migrated.profiles,
    adapters: options.adapters,
    toolkitVersion: options.toolkitVersion ?? targetVersion,
    allowHarnessChange: true,
    ...(options.hookRuntimePath === undefined
      ? {}
      : { hookRuntimePath: options.hookRuntimePath }),
    ...(options.hookTargets === undefined
      ? {}
      : { hookTargets: options.hookTargets }),
    existingConfig: {
      value: configPreview.migrated,
      sourceHash: configPreview.sourceHash
    }
  });
  return {
    targetVersion,
    migrationSteps: configPreview.steps,
    installation
  };
}

export async function applyUpdatePlan(
  root: string,
  plan: UpdatePlan
): Promise<void> {
  await applyInstallPlan(root, plan.installation);
}
