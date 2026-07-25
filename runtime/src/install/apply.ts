import { readFile } from "node:fs/promises";

import { sha256 } from "../fs/hash.js";
import {
  formatInstallManifest,
  parseInstallManifest
} from "../fs/manifest.js";
import {
  AgentOpsError,
  resolveContainedPath
} from "../fs/paths.js";
import { FileTransaction } from "../fs/transaction.js";
import { validateConfig } from "../schema/validate.js";
import type { InstallPlan } from "./plan.js";

const CONFIG_PATH = ".agent-ops/config.json";
const MANIFEST_PATH = ".agent-ops/manifest.json";

async function readInstalledFile(
  root: string,
  path: string
): Promise<string> {
  return await readFile(await resolveContainedPath(root, path), "utf8");
}

function markerCount(source: string, marker: string): number {
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(marker, index)) !== -1) {
    count += 1;
    index += marker.length;
  }
  return count;
}

async function validateAppliedPlan(
  root: string,
  plan: InstallPlan
): Promise<void> {
  const installedManifestSource = await readInstalledFile(
    root,
    MANIFEST_PATH
  );
  const installedManifest = parseInstallManifest(
    installedManifestSource
  );
  if (
    formatInstallManifest(installedManifest) !==
    formatInstallManifest(plan.manifest)
  ) {
    throw new AgentOpsError(
      "INSTALL_VALIDATION_FAILED",
      "The installed manifest does not match the approved plan."
    );
  }

  for (const artifact of installedManifest.artifacts) {
    const content = await readInstalledFile(root, artifact.path);
    if (sha256(content) !== artifact.hash) {
      throw new AgentOpsError(
        "INSTALL_VALIDATION_FAILED",
        `Installed artifact hash mismatch: ${artifact.path}`
      );
    }
  }
  for (const marker of installedManifest.markers) {
    const content = await readInstalledFile(root, marker.path);
    if (
      sha256(content) !== marker.hash ||
      markerCount(content, marker.startMarker) !== 1 ||
      markerCount(content, marker.endMarker) !== 1 ||
      content.indexOf(marker.startMarker) >=
        content.indexOf(marker.endMarker)
    ) {
      throw new AgentOpsError(
        "INSTALL_VALIDATION_FAILED",
        `Installed managed block is invalid: ${marker.path}`
      );
    }
  }

  const configSource = await readInstalledFile(root, CONFIG_PATH);
  let config: unknown;
  try {
    config = JSON.parse(configSource) as unknown;
  } catch (error) {
    throw new AgentOpsError(
      "INSTALL_VALIDATION_FAILED",
      "Installed configuration is not valid JSON.",
      { cause: error }
    );
  }
  const configResult = validateConfig(config);
  if (!configResult.ok) {
    throw new AgentOpsError(
      "INSTALL_VALIDATION_FAILED",
      `${configResult.errors[0]?.path ?? "$"}: ${
        configResult.errors[0]?.message ?? "Invalid installed configuration."
      }`
    );
  }
}

function assertManifestOperation(plan: InstallPlan): void {
  const manifestOperations = plan.operations.filter(
    (operation) => operation.path === MANIFEST_PATH
  );
  const manifestOperation = manifestOperations[0];
  if (
    manifestOperations.length !== 1 ||
    manifestOperation?.kind !== "write" ||
    manifestOperation.content !== formatInstallManifest(plan.manifest)
  ) {
    throw new AgentOpsError(
      "INVALID_INSTALL_PLAN",
      "Install plan must contain one matching manifest write."
    );
  }
}

export async function applyInstallPlan(
  root: string,
  plan: InstallPlan
): Promise<void> {
  assertManifestOperation(plan);
  const transaction = new FileTransaction(root);
  await transaction.apply(
    { operations: plan.operations },
    async () => await validateAppliedPlan(root, plan)
  );
}
