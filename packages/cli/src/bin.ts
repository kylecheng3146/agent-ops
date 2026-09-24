#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  commonHarnessAdapters,
  harnessHookPath,
  HARNESS_IDS
} from "../../../runtime/src/install/harness.js";
import type {
  AgentOpsConfig,
  Harness,
  HarnessId,
  InstallManifest,
  InstallScope
} from "../../../runtime/src/contracts.js";
import {
  agyRuntimeStatus,
  agyVersionSupported,
  hookRegistrationDrift,
  repositoryTrustStatus,
  smokeAvailabilityStatus
} from "../../../runtime/src/install/probes.js";
import { parseInstallManifest } from "../../../runtime/src/fs/manifest.js";
import { readRecordedSessionId } from "../../../runtime/src/hooks/codex-loop.js";
import { NpmRegistryClient } from "../../../runtime/src/registry/npm.js";
import { TaskService } from "../../../runtime/src/task/service.js";
import { FileTaskStore } from "../../../runtime/src/task/store.js";
import { FileTrustStore } from "../../../runtime/src/security/trust.js";
import { localStatePaths } from "../../../runtime/src/security/permissions.js";
import { calculateConfigHash } from "../../../runtime/src/config/hash.js";
import { FileEvidenceStore } from "../../../runtime/src/verify/evidence.js";
import { calculateSourceFingerprint } from "../../../runtime/src/verify/source-fingerprint.js";
import { VerificationService } from "../../../runtime/src/verify/service.js";
import { NodeVerificationProcessRunner } from "../../../runtime/src/verify/spawn.js";
import { runCli } from "./cli.js";
import {
  loadEffectiveConfig,
  repositoryTrust,
  repositoryTrustBinding
} from "./context.js";
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
import {
  createReviewExecutor,
  ReviewInterruptedError
} from "../../../runtime/src/review/execute.js";
import { probeReviewTarget } from "../../../runtime/src/review/probe.js";
import { resolveReviewScope } from "../../../runtime/src/review/scope.js";
import { resolveReviewRole } from "../../../runtime/src/review/roles.js";
import { runTrustCommand } from "./commands/trust.js";
import { runVerifyCommand } from "./commands/verify.js";
import { runAllowStopCommand } from "./commands/allow-stop.js";
import { CompletionGateService } from "../../../runtime/src/hooks/completion-gate.js";
import {
  formatUpdatePlan,
  runUpdateCommand
} from "./commands/update.js";
import { errorEnvelope } from "./output.js";
import { runAgyHeadless } from "./agy-headless.js";
import { runWorktreeCommand } from "./commands/worktree.js";
import type { FinishDependencies } from "../../../runtime/src/worktree/finish.js";

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
  const recordedHookPaths = new Map(
    (manifest?.hooks ?? []).map(({ harness, path }) => [harness, path])
  );
  for (const id of HARNESS_IDS) {
    const path =
      id === "opencode" && recordedOpencodePluginPath !== undefined
        ? recordedOpencodePluginPath
        : recordedHookPaths.get(id) ??
          harnessHookPath(id, scope, root);
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

function gitRunner(root: string) {
  return {
    run: async (gitArgs: readonly string[]) => {
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
  };
}

async function confirmInit(
  plan: Parameters<typeof formatInstallPlan>[0],
  trust: NonNullable<Parameters<typeof formatInstallPlan>[1]>,
  warnings: readonly string[] = []
): Promise<boolean> {
  writeBanner({
    isTTY: process.stdout.isTTY === true,
    columns: process.stdout.columns,
    write: (value) => process.stdout.write(value)
  });
  return await confirmPlan(formatInstallPlan(plan, trust, warnings));
}

async function confirmPlan(text: string): Promise<boolean> {
  process.stdout.write(text);
  return await selectYesNo(
    "Apply this installation plan?",
    { input: process.stdin, output: process.stdout },
    false
  );
}

function trustStore(): FileTrustStore {
  const state = localStatePaths(process.env.AGENT_OPS_HOME ?? homedir());
  return new FileTrustStore(state.trustStore, state.anchorDirectory);
}

async function plannedTrustBinding(
  root: string,
  projectConfig?: AgentOpsConfig
) {
  const config = (await loadEffectiveConfig(root, "project", projectConfig)).config;
  return config.verification.commands.length === 0
    ? null
    : await repositoryTrustBinding(root, config, CLI_VERSION);
}

function worktreeDependencies(): FinishDependencies {
  const gateFor = async (root: string, config: AgentOpsConfig) =>
    new CompletionGateService({
      root,
      config,
      gitRunner: gitRunner(root),
      taskService: new TaskService(
        new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root)
      ),
      evidenceStore: new FileEvidenceStore(root, root)
    });
  return {
    git: async (cwd, gitArgs) => await new Promise((resolve) => {
      execFile("git", [...gitArgs], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({
          exitCode: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr
        }));
    }),
    loadConfig: async (root) => (await loadEffectiveConfig(root, "project")).config,
    trust: {
      status: async (root, config) => await repositoryTrust(root, config, CLI_VERSION),
      grant: async (root, config) =>
        await trustStore().grant(await repositoryTrustBinding(root, config, CLI_VERSION)),
      revoke: async (root, config) => {
        await trustStore().revoke(await repositoryTrustBinding(root, config, CLI_VERSION));
      }
    },
    gate: gateFor,
    tasks: (root) => new TaskService(
      new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root)
    ),
    processRunner: new NodeVerificationProcessRunner(),
    runSetup: async (cwd, step) => await new Promise((resolve) => {
      execFile(step.command, [...step.args], {
        cwd,
        encoding: "utf8",
        timeout: step.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        ...(process.platform === "win32" ? { shell: true } : {})
      }, (error, stdout, stderr) => resolve({
        exitCode: error === null
          ? 0
          : typeof error.code === "number" && error.killed !== true ? error.code : null,
        output: `${stdout}${stderr}`
      }));
    })
  };
}

const argv = process.argv.slice(2);

function runAgy(
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeout?: number } = {}
): string {
  return execFileSync("agy", [...args], {
    ...options,
    encoding: "utf8",
    ...(process.platform === "win32" ? { shell: true } : {})
  });
}

if (argv[0] === "agy-run") {
  try {
    const root = process.cwd();
    const config = (await loadEffectiveConfig(root, "project")).config;
    if (!config.features.completionGate.enabled) {
      throw new Error("agy-run requires features.completionGate.enabled.");
    }
    const taskService = new TaskService(
      new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root)
    );
    const gate = new CompletionGateService({
      root,
      config,
      gitRunner: gitRunner(root),
      taskService,
      evidenceStore: new FileEvidenceStore(root, root)
    });
    const agyArgs = argv[1] === "--" ? argv.slice(2) : argv.slice(1);
    process.exitCode = await runAgyHeadless({
      root,
      sessionId: `agy-headless-${randomUUID()}`,
      args: agyArgs,
      gate,
      run: async (args, env) => await new Promise<number>((resolve) => {
        const child = spawn("agy", [...args], { cwd: root, env, stdio: "inherit" });
        child.once("error", () => resolve(1));
        child.once("exit", (code) => resolve(code ?? 1));
      })
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "agy-run failed."}\n`
    );
    process.exitCode = 2;
  }
} else if (argv[0] === "hook") {
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
          "review",
          "allow-stop",
          "worktree"
        ].map((command) => [command, async (args: Parameters<NonNullable<import("./commands/index.js").CommandHandler>>[0]) => {
          const root = args.scope === "user"
            ? process.env.AGENT_OPS_HOME ?? homedir()
            : process.cwd();
          const isTTY =
            !args.json &&
            process.stdin.isTTY === true &&
            process.stdout.isTTY === true;
          if (args.command === "init") {
            const store = trustStore();
            return await runInitCommand({
              args,
              root,
              adapters: commonHarnessAdapters(),
              isTTY,
              toolkitVersion: CLI_VERSION,
              hookRuntimePath: HOOK_RUNTIME_PATH,
              agyWarning: () => {
                try {
                  const output = runAgy(["--version"], { timeout: 5_000 });
                  return agyVersionSupported(output)
                    ? undefined
                    : "agy is installed, but version 1.1.12 or newer is required; run `agent-ops doctor` after updating.";
                } catch {
                  return "agy is not installed or could not be started; install agy 1.1.12 or newer, then run `agent-ops doctor`.";
                }
              },
              ...(args.hookTargets === undefined
                ? {}
                : { hookTargets: args.hookTargets }),
              trustStore: store,
              calculateTrustBinding: async (config) =>
                await plannedTrustBinding(root, config),
              confirm: async (plan, trust, warnings) =>
                await confirmInit(plan, trust, warnings)
            });
          }
          if (args.command === "worktree") {
            return await runWorktreeCommand({
              args,
              cwd: root,
              deps: worktreeDependencies()
            });
          }
          if (args.command === "doctor") {
            const doctorManifest = await installedManifest(root);
            const config = (await loadEffectiveConfig(
              root,
              args.scope === "user" ? "user" : "project"
            )).config;
            return await runDoctorCommand({
              root,
              toolkitVersion: CLI_VERSION,
              probes: {
                ...(doctorManifest?.harness.includes("agy") === true
                  ? {
                      agyRuntime: () => {
                        try {
                          return agyRuntimeStatus(
                            runAgy(["--version"]),
                            runAgy([
                              "-p", "/hooks", "--output-format", "json",
                              ...(doctorManifest.scope === "project"
                                ? ["--new-project"]
                                : [])
                            ], { cwd: root }),
                            doctorManifest.hooks?.find(
                              ({ harness }) => harness === "agy"
                            )?.events ?? []
                          );
                        } catch {
                          return {
                            status: "FAIL" as const,
                            message: "agy is missing or could not report its loaded hooks.",
                            remediation: "Install agy 1.1.12 or newer and run `agent-ops doctor` again."
                          };
                        }
                      }
                    }
                  : {}),
                hookRegistration: async () => {
                  const drifted = hookRegistrationDrift({
                    harness: await installedHarness(root),
                    config,
                    sources: await hookSources(
                      root,
                      args.scope === "user" ? "user" : "project"
                    )
                  });
                  return drifted.length === 0
                    ? { status: "PASS" as const }
                    : {
                        status: "FAIL" as const,
                        message: `Hook registration is missing for ${drifted.join(", ")}.`,
                        code: "UPDATE_REQUIRED",
                        remediation: "Run `agent-ops update`."
                      };
                },
                repositoryTrust: async () => {
                  const trust = await repositoryTrust(root, config, CLI_VERSION);
                  const status = repositoryTrustStatus(trust);
                  if (trust === "STALE") {
                    return {
                      status,
                      message: "Repository trust binding is stale.",
                      code: "TRUST_REQUIRED",
                      remediation: "Run `agent-ops trust grant`."
                    };
                  }
                  if (trust === "UNTRUSTED") {
                    const verificationConfigured =
                      config.verification.commands.length > 0;
                    return {
                      status,
                      message: verificationConfigured
                        ? "Repository is not trusted; Stop verification will not run."
                        : "Repository is not trusted.",
                      ...(verificationConfigured
                        ? {
                            code: "TRUST_REQUIRED",
                            remediation: "Run `agent-ops trust grant`."
                          }
                        : {
                            remediation:
                              "No action needed; trust is only required once verification.commands is set."
                          })
                    };
                  }
                  return { status };
                },
                smokeAvailability: () => {
                  const status = smokeAvailabilityStatus(config);
                  return status === "UNKNOWN"
                    ? {
                        status,
                        message: "verification.commands is empty.",
                        remediation:
                          "No action needed; add verification.commands to .agent-ops/config.json to enable smoke checks."
                      }
                    : { status };
                },
                reviewTarget: async (target, deep) =>
                  await probeReviewTarget(target, { cwd: root, deep })
              },
              ...(args.checkAuth === true
                ? { checkReviewTargetAuth: true }
                : {}),
              ...(args.checkAuthTargets === undefined
                ? {}
                : { checkAuthTargets: args.checkAuthTargets })
            });
          }
          if (args.command === "uninstall") {
            const store = trustStore();
            return await runUninstallCommand({
              args,
              root,
              isTTY,
              trustStore: store,
              calculateTrustBinding: async () =>
                await plannedTrustBinding(root),
              confirm: async (plan, trust) =>
                await confirmPlan(formatUninstallPlan(plan, trust))
            });
          }
          if (args.command === "update") {
            const store = trustStore();
            const manifest = await installedManifest(root);
            const addAgy =
              isTTY &&
              !args.yes &&
              args.harness === undefined &&
              manifest !== null &&
              !manifest.harness.includes("agy") &&
              await selectYesNo(
                "Add newly supported harness: agy?",
                { input: process.stdin, output: process.stdout },
                false
              );
            const updateArgs = addAgy
              ? { ...args, harness: [...(manifest?.harness ?? []), "agy" as const] }
              : args;
            return await runUpdateCommand({
              args: updateArgs,
              root,
              adapters: commonHarnessAdapters(),
              registry: new NpmRegistryClient(),
              isTTY,
              toolkitVersion: CLI_VERSION,
              hookRuntimePath: HOOK_RUNTIME_PATH,
              ...(updateArgs.hookTargets === undefined
                ? {}
                : { hookTargets: updateArgs.hookTargets }),
              trustStore: store,
              calculateTrustBinding: async (config) =>
                await plannedTrustBinding(root, config),
              confirm: async (plan, trust) =>
                await confirmPlan(formatUpdatePlan(plan, trust)),
              ...(updateArgs.targetVersion === undefined
                ? {}
                : { targetVersion: updateArgs.targetVersion })
            });
          }
          const taskService = new TaskService(
            new FileTaskStore(
              join(root, ".agent-ops", "tasks", "state.json"),
              root
            ),
            { completion: {
              root,
              gitRunner: gitRunner(root),
              ...(args.base === undefined ? {} : { base: args.base }),
              loadConfig: async () => (await loadEffectiveConfig(
                root, args.scope === "user" ? "user" : "project"
              )).config
            } }
          );
          if (args.command === "allow-stop") {
            const config = (await loadEffectiveConfig(root, "project")).config;
            return await runAllowStopCommand({
              args,
              gate: new CompletionGateService({
                root,
                config,
                gitRunner: gitRunner(root),
                taskService,
                evidenceStore: new FileEvidenceStore(root, root)
              })
            });
          }
          if (args.command === "task") {
            // Explicit `--session` wins, then an injected identity, then the
            // id a SessionStart hook recorded for this checkout: a command
            // run inside a session is never told which session it is in.
            const sessionId = process.env.AGENT_OPS_SESSION_ID ??
              await readRecordedSessionId(root);
            const policyConfigHash = args.action === "create"
              ? calculateConfigHash((await loadEffectiveConfig(
                  root,
                  args.scope === "user" ? "user" : "project"
                )).config)
              : undefined;
            return await runTaskCommand({
              args,
              service: taskService,
              ...(policyConfigHash === undefined ? {} : { policyConfigHash }),
              ...(sessionId === undefined ? {} : { sessionId })
            });
          }
          if (args.command === "review") {
            const reviewSessionId = process.env.AGENT_OPS_SESSION_ID;
            const reviewGit = gitRunner(root);
            const reviewConfig = (await loadEffectiveConfig(
              root,
              args.scope === "user" ? "user" : "project"
            )).config;
            const reviewRole = resolveReviewRole(
              "independent-review",
              reviewConfig.reviewRoles ?? []
            );
            const configuredReviewTargets = reviewRole?.targets ?? [];
            const controller = new AbortController();
            let interruptedBy: "SIGINT" | "SIGTERM" | undefined;
            const interrupt = (signal: "SIGINT" | "SIGTERM"): void => {
              interruptedBy ??= signal;
              controller.abort(signal);
            };
            const onSigint = (): void => interrupt("SIGINT");
            const onSigterm = (): void => interrupt("SIGTERM");
            process.once("SIGINT", onSigint);
            process.once("SIGTERM", onSigterm);
            try {
              return await runReviewCommand({
                args,
                authorized: args.yes,
                tasks: taskService,
                ...(args.taskId === undefined ? {} : { taskId: args.taskId }),
                ...(reviewSessionId === undefined
                  ? {}
                  : { sessionId: reviewSessionId }),
                ...(reviewConfig.reviewRoles === undefined
                  ? {}
                  : { roles: reviewConfig.reviewRoles }),
                targets: configuredReviewTargets,
                root,
                gitRunner: reviewGit,
                policyConfigHash: calculateConfigHash(reviewConfig),
                currentPolicyConfigHash: async () => calculateConfigHash((
                  await loadEffectiveConfig(
                    root,
                    args.scope === "user" ? "user" : "project"
                  )
                ).config),
                config: reviewConfig,
                evidenceStore: new FileEvidenceStore(root, root),
                execute: createReviewExecutor({
                  targets: configuredReviewTargets,
                  cwd: root,
                  ...(reviewRole?.model === undefined
                    ? {}
                    : { model: reviewRole.model }),
                  ...(reviewRole?.effort === undefined
                    ? {}
                    : { effort: reviewRole.effort }),
                  ...(reviewRole?.timeoutMs === undefined
                    ? {}
                    : { timeoutMs: reviewRole.timeoutMs }),
                  preflightTarget: async (target, budget) =>
                    await probeReviewTarget(target, {
                      cwd: root,
                      deep: true,
                      // The probe answers within the chain's remaining budget
                      // or not at all; its own default would outlast it.
                      ...(budget === undefined
                        ? {}
                        : { timeoutMs: budget.timeoutMs })
                    }),
                  verifySourceFingerprint: async (expected) => {
                    const currentScope = await resolveReviewScope({
                      root,
                      runner: reviewGit,
                      ...(args.base === undefined ? {} : { base: args.base })
                    });
                    return await calculateSourceFingerprint(
                      root,
                      currentScope,
                      reviewGit
                    ) === expected;
                  },
                  signal: controller.signal,
                  onProgress: (line) => {
                    process.stderr.write(`${line}\n`);
                  }
                })
              });
            } catch (error) {
              if (
                error instanceof ReviewInterruptedError &&
                interruptedBy !== undefined
              ) {
                process.exit(interruptedBy === "SIGINT" ? 130 : 143);
              }
              throw error;
            } finally {
              process.removeListener("SIGINT", onSigint);
              process.removeListener("SIGTERM", onSigterm);
            }
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
                gitRunner: gitRunner(root),
                processRunner: new NodeVerificationProcessRunner(),
                taskService,
                evidenceStore: new FileEvidenceStore(root, root),
                trusted: trustStatus === "TRUSTED",
                ...(args.base === undefined ? {} : { base: args.base })
              })
            });
          }
          if (args.command === "trust") {
            const config = (await loadEffectiveConfig(
              root,
              args.scope === "user" ? "user" : "project"
            )).config;
            const binding = await repositoryTrustBinding(
              root,
              config,
              CLI_VERSION
            );
            return await runTrustCommand({
              action: args.action as "grant" | "revoke" | "status",
              yes: args.yes,
              isTTY,
              calculateBinding: async () => binding,
              presentBinding: async () => undefined,
              confirmGrant: async () => await confirmPlan(JSON.stringify(binding, null, 2)),
              store: trustStore()
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
