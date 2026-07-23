import { AgentOpsError } from "../fs/paths.js";
import type { RegistryClient } from "../registry/npm.js";
import { applyInstallPlan } from "./apply.js";
import { doctorInstallation } from "./doctor.js";
import type { HarnessInstallAdapter } from "./harness.js";
import {
  createInstallPlan,
  type InstallPlan
} from "./plan.js";

const PACKAGE_NAME = "@kylecheng3146/agent-ops";

export interface CreateUpdatePlanOptions {
  readonly root: string;
  readonly adapters: readonly HarnessInstallAdapter[];
  readonly targetVersion?: string;
  readonly registry?: RegistryClient;
  readonly packageName?: string;
}

export interface UpdatePlan {
  readonly targetVersion: string;
  readonly migrationSteps: readonly {
    readonly fromVersion: number;
    readonly toVersion: number;
  }[];
  readonly installation: InstallPlan;
}

function statusOf(
  report: Awaited<ReturnType<typeof doctorInstallation>>,
  id: "config" | "manifest" | "markers" | "node-version"
): "FAIL" | "PASS" | "UNKNOWN" | undefined {
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

  const report = await doctorInstallation({ root: options.root });
  for (const id of [
    "node-version",
    "manifest",
    "config",
    "markers"
  ] as const) {
    if (statusOf(report, id) !== "PASS") {
      throw new AgentOpsError(
        "UPDATE_INSTALLATION_INVALID",
        `Update requires a passing ${id} doctor check.`
      );
    }
  }
  if (report.manifest === undefined || report.config === undefined) {
    throw new AgentOpsError(
      "UPDATE_INSTALLATION_INVALID",
      "Update requires a valid manifest and configuration."
    );
  }

  const installation = await createInstallPlan({
    root: options.root,
    scope: report.manifest.scope,
    harness: report.manifest.harness,
    profiles: report.config.profiles,
    adapters: options.adapters,
    toolkitVersion: targetVersion
  });
  return {
    targetVersion,
    migrationSteps: [],
    installation
  };
}

export async function applyUpdatePlan(
  root: string,
  plan: UpdatePlan
): Promise<void> {
  await applyInstallPlan(root, plan.installation);
}
