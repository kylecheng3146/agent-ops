import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  AgentOpsConfig,
  InstallScope
} from "../../../runtime/src/contracts.js";
import { calculateConfigHash } from "../../../runtime/src/config/hash.js";
import { sha256 } from "../../../runtime/src/fs/hash.js";
import { loadConfigFile } from "../../../runtime/src/config/load.js";
import {
  mergeConfigLayers,
  type ConfigLayer,
  type MergedConfig
} from "../../../runtime/src/config/merge.js";
import { AgentOpsError } from "../../../runtime/src/fs/paths.js";
import { localStatePaths } from "../../../runtime/src/security/permissions.js";
import {
  calculateTrustBinding,
  FileTrustStore
} from "../../../runtime/src/security/trust.js";

export const DEFAULT_CONFIG: AgentOpsConfig = {
  schemaVersion: 2,
  profiles: [],
  verification: { commands: [] },
  features: {
    stopVerification: {
      enabled: false
    }
  },
  pathMappings: [],
  securityExceptions: []
};

export type ProjectHookConfigOutcome =
  | { readonly kind: "absent"; readonly config: AgentOpsConfig }
  | { readonly kind: "loaded"; readonly config: AgentOpsConfig }
  | { readonly kind: "invalid"; readonly path: string };

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
  scope: InstallScope,
  projectOverride?: AgentOpsConfig
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
  const project = projectOverride === undefined
    ? await loadOptionalConfig(projectPath)
    : { sourcePath: projectPath, config: projectOverride };
  if (project !== null) {
    layers.push({
      source: "project",
      sourcePath: project.sourcePath,
      config: project.config
    });
  }
  return mergeConfigLayers(layers);
}

/**
 * Classifies only configuration that can participate in a project hook. The
 * regular command loader intentionally keeps its throwing contract so CLI
 * commands continue to surface configuration errors to the human.
 */
export async function loadProjectHookConfig(
  root: string
): Promise<ProjectHookConfigOutcome> {
  const home = process.env.AGENT_OPS_HOME ?? homedir();
  const userPath = join(home, ".agent-ops", "config.json");
  const projectPath = join(root, ".agent-ops", "config.json");
  const layers: ConfigLayer[] = [defaultConfigLayer()];

  let project;
  try {
    project = await loadOptionalConfig(projectPath);
  } catch {
    return { kind: "invalid", path: projectPath };
  }
  if (project === null && projectPath === userPath) {
    return { kind: "absent", config: DEFAULT_CONFIG };
  }

  if (projectPath !== userPath) {
    try {
      const user = await loadOptionalConfig(userPath);
      if (user !== null) {
        layers.push({
          source: "user",
          sourcePath: user.sourcePath,
          config: user.config
        });
      }
    } catch {
      // A user-level error cannot make a project with no own config deny a
      // tool call, but it remains a classified failure for an installed
      // project that does own a config.
      return project === null
        ? { kind: "absent", config: DEFAULT_CONFIG }
        : { kind: "invalid", path: userPath };
    }
  }
  if (project === null) {
    try {
      return { kind: "absent", config: mergeConfigLayers(layers).config };
    } catch {
      return { kind: "absent", config: DEFAULT_CONFIG };
    }
  }
  layers.push({
    source: "project",
    sourcePath: project.sourcePath,
    config: project.config
  });
  try {
    return { kind: "loaded", config: mergeConfigLayers(layers).config };
  } catch {
    return { kind: "invalid", path: projectPath };
  }
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
    const binding = await repositoryTrustBinding(root, config, cliVersion);
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

export async function repositoryTrustBinding(
  root: string,
  config: AgentOpsConfig,
  cliVersion: string
) {
  return await calculateTrustBinding({
    repositoryPath: root,
    remoteUrl: repositoryRemoteUrl(root),
    configHash: calculateConfigHash(config),
    runtimeHash: sha256(cliVersion)
  });
}
