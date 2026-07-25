#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";

import { commonHarnessAdapters } from "../../../runtime/src/install/harness.js";
import { NpmRegistryClient } from "../../../runtime/src/registry/npm.js";
import { TaskService } from "../../../runtime/src/task/service.js";
import { FileTaskStore } from "../../../runtime/src/task/store.js";
import { mergeConfigLayers } from "../../../runtime/src/config/merge.js";
import { FileTrustStore, calculateTrustBinding } from "../../../runtime/src/security/trust.js";
import { localStatePaths } from "../../../runtime/src/security/permissions.js";
import { sha256 } from "../../../runtime/src/fs/hash.js";
import { AgentOpsError } from "../../../runtime/src/fs/paths.js";
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

const CLI_VERSION = "0.0.0-development";

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
                await confirmPlan(formatUpdatePlan(plan))
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
            return explainConfigCommand(
              mergeConfigLayers([{
                source: "default",
                sourcePath: "built-in defaults",
                config: {
                  schemaVersion: 1,
                  profiles: [],
                  verification: { commands: [] },
                  pathMappings: [],
                  securityExceptions: []
                }
              }])
            );
          }
          if (args.command === "verify") {
            return await runVerifyCommand({
              args,
              taskService,
              service: {
                verify: async () => {
                  throw new AgentOpsError(
                    "VERIFY_CONFIG_REQUIRED",
                    "Verification requires an installed and trusted configuration."
                  );
                }
              }
            });
          }
          if (args.command === "trust") {
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
              configHash: sha256("built-in-default-config"),
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
