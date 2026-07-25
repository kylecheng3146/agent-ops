#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";

import { commonHarnessAdapters } from "../../../runtime/src/install/harness.js";
import type {
  AgentOpsConfig,
  InstallScope
} from "../../../runtime/src/contracts.js";
import { NpmRegistryClient } from "../../../runtime/src/registry/npm.js";
import { TaskService } from "../../../runtime/src/task/service.js";
import { FileTaskStore } from "../../../runtime/src/task/store.js";
import { mergeConfigLayers } from "../../../runtime/src/config/merge.js";
import { loadConfigFile } from "../../../runtime/src/config/load.js";
import { AgentOpsError } from "../../../runtime/src/fs/paths.js";
import { FileTrustStore, calculateTrustBinding } from "../../../runtime/src/security/trust.js";
import { localStatePaths } from "../../../runtime/src/security/permissions.js";
import { sha256 } from "../../../runtime/src/fs/hash.js";
import { FileEvidenceStore } from "../../../runtime/src/verify/evidence.js";
import { VerificationService } from "../../../runtime/src/verify/service.js";
import { NodeVerificationProcessRunner } from "../../../runtime/src/verify/spawn.js";
import { runCli } from "./cli.js";
import { createCommandRegistry } from "./commands/index.js";
import { explainConfigCommand } from "./commands/config.js";
import { runDoctorCommand } from "./commands/doctor.js";
import {
  formatInstallPlan,
  runInitCommand
} from "./commands/init.js";
import {
  formatUninstallPlan,
  runUninstallCommand
} from "./commands/uninstall.js";
import { runTaskCommand } from "./commands/task.js";
import { runReviewCommand } from "./commands/review.js";
import { runTrustCommand } from "./commands/trust.js";
import { runVerifyCommand } from "./commands/verify.js";
import {
  formatUpdatePlan,
  runUpdateCommand
} from "./commands/update.js";
import { errorEnvelope, type CliEnvelope } from "./output.js";
import type {
  ConfigLayer,
  MergedConfig
} from "../../../runtime/src/config/merge.js";

const CLI_VERSION = "0.0.0-development";

const DEFAULT_CONFIG: AgentOpsConfig = {
  schemaVersion: 1,
  profiles: [],
  verification: { commands: [] },
  pathMappings: [],
  securityExceptions: []
};

function defaultConfigLayer() {
  return {
    source: "default" as const,
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

async function loadEffectiveConfig(
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

async function repositoryTrust(
  root: string,
  config: AgentOpsConfig
): Promise<"TRUSTED" | "STALE" | "UNTRUSTED"> {
  const home = process.env.AGENT_OPS_HOME ?? homedir();
  const state = localStatePaths(home);
  const remote = (() => {
    try {
      return execFileSync("git", ["config", "--get", "remote.origin.url"], {
        cwd: root,
        encoding: "utf8"
      }).trim();
    } catch {
      return `local:${root}`;
    }
  })();
  try {
    const binding = await calculateTrustBinding({
      repositoryPath: root,
      remoteUrl: remote,
      configHash: sha256(JSON.stringify(config)),
      runtimeHash: sha256(CLI_VERSION)
    });
    return (await new FileTrustStore(state.trustStore, state.anchorDirectory).status(binding)).status;
  } catch {
    return "UNTRUSTED";
  }
}

async function confirmInit(
  plan: Parameters<typeof formatInstallPlan>[0]
): Promise<boolean> {
  return await confirmPlan(formatInstallPlan(plan));
}

async function confirmPlan(text: string): Promise<boolean> {
  process.stdout.write(text);
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const answer = await prompt.question(
      "Apply this installation plan? [y/N]: "
    );
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    prompt.close();
  }
}

process.exitCode = await runCli(
  process.argv.slice(2),
  {
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    input: process.stdin,
    output: process.stdout,
    writeStdout: (value) => process.stdout.write(value),
    writeStderr: (value) => process.stderr.write(value)
  },
  {
    version: CLI_VERSION,
    registry: createCommandRegistry(
      Object.fromEntries(
        [
          "init",
          "config",
          "trust",
          "doctor",
          "update",
          "uninstall",
          "task",
          "verify",
          "review"
        ].map((command) => [command, async (args: Parameters<NonNullable<import("./commands/index.js").CommandHandler>>[0]) => {
          const root = args.scope === "user"
            ? process.env.AGENT_OPS_HOME ?? homedir()
            : process.cwd();
          const isTTY =
            !args.json &&
            process.stdin.isTTY === true &&
            process.stdout.isTTY === true;
          if (args.command === "init") {
            return await runInitCommand({
              args,
              root,
              adapters: commonHarnessAdapters(),
              isTTY,
              toolkitVersion: CLI_VERSION,
              confirm: async (plan) => await confirmInit(plan)
            });
          }
          if (args.command === "doctor") {
            return await runDoctorCommand({ root });
          }
          if (args.command === "uninstall") {
            return await runUninstallCommand({
              args,
              root,
              isTTY,
              confirm: async (plan) =>
                await confirmPlan(formatUninstallPlan(plan))
            });
          }
          if (args.command === "update") {
            return await runUpdateCommand({
              args,
              root,
              adapters: commonHarnessAdapters(),
              registry: new NpmRegistryClient(),
              isTTY,
              confirm: async (plan) =>
                await confirmPlan(formatUpdatePlan(plan)),
              ...(args.targetVersion === undefined
                ? {}
                : { targetVersion: args.targetVersion })
            });
          }
          const taskService = new TaskService(
            new FileTaskStore(
              join(root, ".agent-ops", "tasks", "state.json"),
              root
            )
          );
          if (args.command === "task") {
            const sessionId = process.env.AGENT_OPS_SESSION_ID;
            return await runTaskCommand({
              args,
              service: taskService,
              ...(sessionId === undefined ? {} : { sessionId })
            });
          }
          if (args.command === "review") {
            return await runReviewCommand({
              args,
              authorized: args.yes
            });
          }
          if (args.command === "config") {
            return explainConfigCommand(await loadEffectiveConfig(
              root,
              args.scope === "user" ? "user" : "project"
            ));
          }
          if (args.command === "verify") {
            const merged = await loadEffectiveConfig(
              root,
              args.scope === "user" ? "user" : "project"
            );
            const config = merged.config;
            const trustStatus = await repositoryTrust(root, config);
            return await runVerifyCommand({
              args,
              taskService,
              service: new VerificationService({
                root,
                scope: args.scope === "user" ? "user" : "project",
                config,
                gitRunner: {
                  run: async (gitArgs) => {
                    try {
                      return {
                        exitCode: 0,
                        stdout: execFileSync("git", [...gitArgs], {
                          cwd: root,
                          encoding: "buffer",
                          stdio: ["ignore", "pipe", "ignore"]
                        })
                      };
                    } catch (error) {
                      const failure = error as {
                        status?: number | null;
                        stdout?: Uint8Array;
                      };
                      return {
                        exitCode: failure.status ?? 1,
                        stdout: failure.stdout ?? new Uint8Array()
                      };
                    }
                  }
                },
                processRunner: new NodeVerificationProcessRunner(),
                taskService,
                evidenceStore: new FileEvidenceStore(root, root),
                trusted: trustStatus === "TRUSTED"
              })
            });
          }
          if (args.command === "trust") {
            const config = (await loadEffectiveConfig(
              root,
              args.scope === "user" ? "user" : "project"
            )).config;
            const state = localStatePaths(
              process.env.AGENT_OPS_HOME ?? homedir()
            );
            const remote = (() => {
              try {
                return execFileSync("git", ["config", "--get", "remote.origin.url"], {
                  cwd: root,
                  encoding: "utf8"
                }).trim();
              } catch {
                return `local:${root}`;
              }
            })();
            const binding = await calculateTrustBinding({
              repositoryPath: root,
              remoteUrl: remote,
              configHash: sha256(JSON.stringify(config)),
              runtimeHash: sha256(CLI_VERSION)
            });
            return await runTrustCommand({
              action: args.action as "grant" | "revoke" | "status",
              yes: args.yes,
              isTTY,
              calculateBinding: async () => binding,
              presentBinding: async () => undefined,
              confirmGrant: async () => await confirmPlan(JSON.stringify(binding, null, 2)),
              store: new FileTrustStore(state.trustStore, state.anchorDirectory)
            });
          }
          return errorEnvelope(
            "CLI_COMMAND_UNAVAILABLE",
            `Command is not implemented yet: ${args.command}`
          );
        }])
      )
    )
  }
);
