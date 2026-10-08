import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

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
import { localStatePaths, readPrivateFile } from "../../../runtime/src/security/permissions.js";
import {FileRunRepository} from "../../../runtime/src/run/service.js";
import {readRunPolicy, runRuntimeHash} from "../../../runtime/src/run/policy.js";
import {
  calculateTrustBinding,
  FileTrustStore
} from "../../../runtime/src/security/trust.js";

export const DEFAULT_CONFIG: AgentOpsConfig = {
  schemaVersion: 3,
  profiles: [],
  verification: { commands: [] },
  features: {
    office: { enabled: false },
    stopVerification: {
      enabled: false
    },
    completionGate: {
      enabled: false
    }
  },
  pathMappings: [],
  securityExceptions: []
};

/**
 * Where a checkout's project config lives. Inside an agent-ops worktree it is
 * the main checkout's: a branch must not change the config that decides its
 * own gate, verifiers and trust before that change is merged, and a copy of a
 * gitignored file can be missing or stale. Anything git cannot confirm is a
 * worktree of this repository falls back to the checkout itself.
 */
export function projectConfigRoot(root: string): string {
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }
    ).trim();
    if (basename(common) !== ".git") {
      return root;
    }
    const main = realpathSync(dirname(common));
    const here = realpathSync(root);
    return here.startsWith(`${join(main, ".worktrees")}${sep}`) &&
      existsSync(join(main, ".agent-ops", "config.json"))
      ? main
      : root;
  } catch {
    return root;
  }
}

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
  if (scope === "project" && projectOverride === undefined) {
    const run = await runPolicyContext(root);
    if (run !== null) return mergeConfigLayers([defaultConfigLayer(), {
      source: "project", sourcePath: join(run.state.commonDir, "agent-ops/runs", run.state.runId, "policies", run.state.policyBinding!.artifactDigest + ".json"),
      config: run.policy.config
    }]);
  }
  const home = process.env.AGENT_OPS_HOME ?? homedir();
  const userPath = join(home, ".agent-ops", "config.json");
  const projectPath = join(
    scope === "user" ? root : projectConfigRoot(root),
    ".agent-ops",
    "config.json"
  );
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
  const projectPath = join(projectConfigRoot(root), ".agent-ops", "config.json");
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
      encoding: "utf8",
      windowsHide: true
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
    const run = await runPolicyContext(root);
    if (run !== null) {
      if (run.state.status !== "active" || run.state.disableRestart || run.state.awaitingResume ||
        Date.parse(run.policy.expiresAt) <= Date.now() || calculateConfigHash(config) !== run.state.policyBinding!.configHash) return "STALE";
      const store = new FileTrustStore(state.trustStore, state.anchorDirectory);
      return (await store.status(run.policy.baseTrustBinding)).status;
    }
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

/** A run-private capability is usable only by its registered checkout or proof group. */
export async function runPolicyContext(root: string) {
  let common: string;
  try {common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true}).trim();} catch {return null;}
  const source = await readPrivateFile(join(root, ".agent-ops/tasks/worktree.json"), root);
  const record = source === null ? null : JSON.parse(source) as {runId?: string; workerId?: string; workerGeneration?: number;
    ownerSessionId?: string; coordinatorId?: string};
  const runId = process.env.AGENT_OPS_RUN_ID ?? record?.runId;
  if (runId === undefined) return null;
  const repository = new FileRunRepository(join(common, "agent-ops/runs"), common);
  const saved = await repository.read(runId);
  if (saved === null || saved.policyBinding === undefined) return null;
  const here = realpathSync(root);
  const worker = saved.workers.find(w => w.worktree === here);
  const proofProcess = worker?.proofProcess ?? saved.proofProcess;
  let proof = false;
  if (proofProcess != null && String(proofProcess.processId) === process.env.AGENT_OPS_RUN_PROOF_PID) {
    try {proof = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true}).trim() === String(proofProcess.processId) &&
      execFileSync("ps", ["-o", "lstart=", "-p", String(proofProcess.processId)], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true}).trim() === proofProcess.processIdentity;}
    catch {proof = false;}
  }
  if ((!proof && (worker === undefined || record?.runId !== runId || record.workerId !== worker.workerId ||
      record.ownerSessionId !== worker.ownerSessionId || record.coordinatorId !== saved.coordinatorId || record.workerGeneration !== worker.generation)) ||
    (worker === undefined && !(proof && saved.root === here)) ||
    (process.env.AGENT_OPS_WORKER_ID !== undefined && (process.env.AGENT_OPS_WORKER_ID !== (worker?.workerId ?? saved.coordinatorId) ||
      process.env.AGENT_OPS_WORKER_GENERATION !== String((worker ?? saved.workers.find(w => w.workerId === saved.coordinatorId))?.generation))))
    throw new AgentOpsError("RUN_WORKER_STALE", "Run policy requires the current registered worker generation or proof process.");
  if (saved.status !== "active" || saved.disableRestart || saved.awaitingResume)
    throw new AgentOpsError("RUN_POLICY_DISABLED", "Run execution policy is inactive; explicit resume is required.");
  const policy = await readRunPolicy(saved, await runRuntimeHash());
  if (policy === null) return null;
  return {repository, state: saved, policy, worker};
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
