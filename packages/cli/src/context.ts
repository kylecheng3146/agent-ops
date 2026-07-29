import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AgentOpsConfig,
  InstallScope
} from "../../../runtime/src/contracts.js";
import { loadConfigFile } from "../../../runtime/src/config/load.js";
import {
  mergeConfigLayers,
  type ConfigLayer,
  type MergedConfig
} from "../../../runtime/src/config/merge.js";
import { sha256 } from "../../../runtime/src/fs/hash.js";
import { AgentOpsError } from "../../../runtime/src/fs/paths.js";
import { localStatePaths } from "../../../runtime/src/security/permissions.js";
import {
  calculateTrustBinding,
  FileTrustStore
} from "../../../runtime/src/security/trust.js";

export const DEFAULT_CONFIG: AgentOpsConfig = {
  schemaVersion: 1,
  profiles: [],
  verification: { commands: [] },
  pathMappings: [],
  securityExceptions: []
};

function defaultConfigLayer(): ConfigLayer {
  return {
    source: "default",
    sourcePath: "built-in defaults",
    config: DEFAULT_CONFIG
  };
}

async function loadOptionalConfig(path: string) {
  try {
    return await loadConfigFile(path);
  } catch (error) {
    if (
      error instanceof AgentOpsError &&
      error.code === "CONFIG_READ_FAILED" &&
      typeof error.cause === "object" &&
      error.cause !== null &&
      "code" in error.cause &&
      error.cause.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

export async function loadEffectiveConfig(
  root: string,
  scope: InstallScope
): Promise<MergedConfig> {
  const home = process.env.AGENT_OPS_HOME ?? homedir();
  const userPath = join(home, ".agent-ops", "config.json");
  const projectPath = join(root, ".agent-ops", "config.json");
  const layers: ConfigLayer[] = [defaultConfigLayer()];
  if (scope === "user") {
    const user = await loadOptionalConfig(userPath);
    if (user !== null) {
      layers.push({
        source: "user",
        sourcePath: user.sourcePath,
        config: user.config
      });
    }
    return mergeConfigLayers(layers);
  }
  if (projectPath !== userPath) {
    const user = await loadOptionalConfig(userPath);
    if (user !== null) {
      layers.push({
        source: "user",
        sourcePath: user.sourcePath,
        config: user.config
      });
    }
  }
  const project = await loadOptionalConfig(projectPath);
  if (project !== null) {
    layers.push({
      source: "project",
      sourcePath: project.sourcePath,
      config: project.config
    });
  }
  return mergeConfigLayers(layers);
}

export function repositoryRemoteUrl(root: string): string {
  try {
    return execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: root,
      encoding: "utf8"
    }).trim();
  } catch {
    return `local:${root}`;
  }
}

export async function repositoryTrust(
  root: string,
  config: AgentOpsConfig,
  cliVersion: string
): Promise<"TRUSTED" | "STALE" | "UNTRUSTED"> {
  const home = process.env.AGENT_OPS_HOME ?? homedir();
  const state = localStatePaths(home);
  try {
    const binding = await calculateTrustBinding({
      repositoryPath: root,
      remoteUrl: repositoryRemoteUrl(root),
      configHash: sha256(JSON.stringify(config)),
      runtimeHash: sha256(cliVersion)
    });
    return (
      await new FileTrustStore(
        state.trustStore,
        state.anchorDirectory
      ).status(binding)
    ).status;
  } catch {
    return "UNTRUSTED";
  }
}
