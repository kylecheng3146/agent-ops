#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  commonHarnessAdapters,
  harnessHookPath,
  HARNESS_IDS
} from "../../../runtime/src/install/harness.js";
import type {
  Harness,
  HarnessId,
  InstallManifest,
  InstallScope
} from "../../../runtime/src/contracts.js";
import {
  hookRegistrationSatisfied,
  repositoryTrustStatus,
  smokeAvailabilityStatus
} from "../../../runtime/src/install/probes.js";
import { parseInstallManifest } from "../../../runtime/src/fs/manifest.js";
import { NpmRegistryClient } from "../../../runtime/src/registry/npm.js";
import { TaskService } from "../../../runtime/src/task/service.js";
import { FileTaskStore } from "../../../runtime/src/task/store.js";
import { FileTrustStore, calculateTrustBinding } from "../../../runtime/src/security/trust.js";
import { localStatePaths } from "../../../runtime/src/security/permissions.js";
import { sha256 } from "../../../runtime/src/fs/hash.js";
import { FileEvidenceStore } from "../../../runtime/src/verify/evidence.js";
import { VerificationService } from "../../../runtime/src/verify/service.js";
import { NodeVerificationProcessRunner } from "../../../runtime/src/verify/spawn.js";
import { runCli } from "./cli.js";
import { loadEffectiveConfig, repositoryTrust } from "./context.js";
import { runHookProcess } from "./hook-process.js";
import { selectYesNo, writeBanner } from "./ui.js";
import { CLI_VERSION } from "./version.js";
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
import { errorEnvelope } from "./output.js";

const HOOK_RUNTIME_PATH = fileURLToPath(
  new URL("./hook-entry.js", import.meta.url)
);

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function hookSources(
  root: string,
  scope: InstallScope
): Promise<Partial<Record<HarnessId, unknown>>> {
  const sources: Partial<Record<HarnessId, unknown>> = {};
  const manifest = await installedManifest(root);
  const recordedOpencodePluginPath = manifest?.artifacts.find(
    ({ id }) => id === "opencode-plugin"
  )?.path;
  for (const id of HARNESS_IDS) {
    const path =
      id === "opencode" && recordedOpencodePluginPath !== undefined
        ? recordedOpencodePluginPath
        : harnessHookPath(id, scope, root);
    sources[id] = await readOptionalText(
      join(root, path)
    );
  }
  return sources;
}

async function installedManifest(root: string): Promise<InstallManifest | null> {
  try {
    return parseInstallManifest(
      await readFile(join(root, ".agent-ops", "manifest.json"), "utf8")
    );
  } catch {
    return null;
  }
}

async function installedHarness(root: string): Promise<Harness> {
  return (await installedManifest(root))?.harness ?? [...HARNESS_IDS];
}

async function confirmInit(
  plan: Parameters<typeof formatInstallPlan>[0]
): Promise<boolean> {
  writeBanner({
    isTTY: process.stdout.isTTY === true,
    columns: process.stdout.columns,
    write: (value) => process.stdout.write(value)
  });
  return await confirmPlan(formatInstallPlan(plan));
}

async function confirmPlan(text: string): Promise<boolean> {
  process.stdout.write(text);
  return await selectYesNo(
    "Apply this installation plan?",
    { input: process.stdin, output: process.stdout },
    false
  );
}

const argv = process.argv.slice(2);

if (argv[0] === "hook") {
  process.exitCode = await runHookProcess(
    argv.slice(1),
    {
      stdin: process.stdin,
      writeStdout: (value) => process.stdout.write(value),
      writeStderr: (value) => process.stderr.write(value)
    },
    CLI_VERSION
  );
} else {
process.exitCode = await runCli(
  argv,
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
              hookRuntimePath: HOOK_RUNTIME_PATH,
              confirm: async (plan) => await confirmInit(plan)
            });
          }
          if (args.command === "doctor") {
            const config = (await loadEffectiveConfig(
              root,
              args.scope === "user" ? "user" : "project"
            )).config;
            return await runDoctorCommand({
              root,
              probes: {
                hookRegistration: async () =>
                  hookRegistrationSatisfied({
                    harness: await installedHarness(root),
                    profiles: config.profiles,
                    sources: await hookSources(
                      root,
                      args.scope === "user" ? "user" : "project"
                    )
                  }),
                repositoryTrust: async () =>
                  repositoryTrustStatus(
                    await repositoryTrust(root, config, CLI_VERSION)
                  ),
                smokeAvailability: () => smokeAvailabilityStatus(config)
              }
            });
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
              hookRuntimePath: HOOK_RUNTIME_PATH,
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
            const trustStatus = await repositoryTrust(
              root,
              config,
              CLI_VERSION
            );
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
}
