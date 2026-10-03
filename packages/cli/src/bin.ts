#!/usr/bin/env node

import { readFile, readdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
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
  repositoryTrustProbe,
  smokeAvailabilityStatus
} from "../../../runtime/src/install/probes.js";
import { parseInstallManifest } from "../../../runtime/src/fs/manifest.js";
import {
  readRecordedSessionId,
  resolveCommandSessionId,
  sessionIdFromEnvironment
} from "../../../runtime/src/hooks/codex-loop.js";
import { codexHomeDirectory } from "../../../runtime/src/install/preauth.js";
import { NpmRegistryClient } from "../../../runtime/src/registry/npm.js";
import { TaskService } from "../../../runtime/src/task/service.js";
import { FileTaskStore } from "../../../runtime/src/task/store.js";
import { calculateConfigHash } from "../../../runtime/src/config/hash.js";
import { FileEvidenceStore } from "../../../runtime/src/verify/evidence.js";
import { calculateSourceFingerprint } from "../../../runtime/src/verify/source-fingerprint.js";
import { VerificationService } from "../../../runtime/src/verify/service.js";
import { NodeVerificationProcessRunner } from "../../../runtime/src/verify/spawn.js";
import { COMMAND_NAMES, parseArgs, type ParsedArgs } from "./args.js";
import { runCli } from "./cli.js";
import {
  loadEffectiveConfig,
  repositoryTrust,
  repositoryTrustBinding
} from "./context.js";
import { runHookProcess } from "./hook-process.js";
import { gitRunner, trustStore, worktreeDependencies } from "./parallel-deps.js";
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
import {
  hasFreshVerification,
  runReviewCommand,
  type ReviewCommandOptions
} from "./commands/review.js";
import { runBatchCommand } from "./commands/batch.js";
import { createSourceGuard } from "../../../runtime/src/review/batch-guard.js";
import { withReviewSlot } from "../../../runtime/src/review/slots.js";
import { memoizePreflight } from "../../../runtime/src/review/batch.js";
import {
  createReviewExecutor,
  ReviewInterruptedError,
  type ReviewExecutorOptions
} from "../../../runtime/src/review/execute.js";
import { probeReviewTargetDetailed } from "../../../runtime/src/review/probe.js";
import { resolveReviewScope } from "../../../runtime/src/review/scope.js";
import { resolveReviewRole } from "../../../runtime/src/review/roles.js";
import { runTrustCommand } from "./commands/trust.js";
import { runVerifyCommand } from "./commands/verify.js";
import { runAdvanceCommand } from "./commands/advance.js";
import { runAllowStopCommand } from "./commands/allow-stop.js";
import { CompletionGateService } from "../../../runtime/src/hooks/completion-gate.js";
import {
  formatUpdatePlan,
  runUpdateCommand
} from "./commands/update.js";
import { errorEnvelope } from "./output.js";
import { runAgyHeadless } from "./agy-headless.js";
import { runWorktreeCommand } from "./commands/parallel.js";
import {
  ensureSessionWorktree,
  readWorktreeRecord,
  resolveCheckouts
} from "../../../runtime/src/parallel/service.js";
import {
  listWorktrees,
  branchLockDoctorResult,
  worktreeDoctorResult
} from "../../../runtime/src/parallel/manage.js";
import {
  detectGhostFiles,
  ghostFilesDoctorResult
} from "../../../runtime/src/install/doctor.js";

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


async function plannedTrustBinding(
  root: string,
  projectConfig?: AgentOpsConfig
) {
  const config = (await loadEffectiveConfig(root, "project", projectConfig)).config;
  return config.verification.commands.length === 0
    ? null
    : await repositoryTrustBinding(root, config, CLI_VERSION);
}


async function worktreeDoctorProbe(root: string) {
  let statuses;
  try {
    statuses = await listWorktrees(worktreeDependencies(), root);
  } catch {
    return { status: "PASS" as const, message: "No agent-ops worktrees to inspect." };
  }
  return worktreeDoctorResult(statuses, Date.now());
}

const GHOST_SCAN_ALLOWLIST = new Set([
  ".git", ".worktrees", ".agent-ops", ".tmp", "node_modules", "dist"
]);

async function worktreeBranchLockProbe(root: string) {
  try {
    const result = await worktreeDependencies().git(root, ["worktree", "list", "--porcelain"]);
    if (result.exitCode !== 0) {
      return { status: "UNKNOWN" as const, message: "Git could not list worktrees." };
    }
    return branchLockDoctorResult(result.stdout);
  } catch {
    return { status: "UNKNOWN" as const, message: "Git could not list worktrees." };
  }
}

async function rootGhostFilesProbe(root: string) {
  try {
    const listing = await worktreeDependencies().git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const untracked = listing.exitCode === 0
      ? new Set(listing.stdout.split("\0").filter((entry) => entry.length > 0 && !entry.includes("/")))
      : new Set<string>();
    const names = (await readdir(root)).filter((name) => !GHOST_SCAN_ALLOWLIST.has(name)).slice(0, 512);
    const candidates = await Promise.all(names.map(async (name) => {
      try {
        const info = await stat(join(root, name));
        return {
          name,
          size: info.size,
          isFile: info.isFile(),
          tracked: !untracked.has(name)
        };
      } catch {
        return { name, size: -1, isFile: false, tracked: true };
      }
    }));
    return ghostFilesDoctorResult(detectGhostFiles(candidates.filter((candidate) => candidate.size >= 0)));
  } catch {
    return { status: "UNKNOWN" as const, message: "The repository root could not be scanned." };
  }
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
    CLI_VERSION,
    { worktree: worktreeDependencies() }
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
        // Every command the parser knows is registered: a hand-kept list here
        // once left a parsed command answering CLI_COMMAND_UNAVAILABLE.
        COMMAND_NAMES.map((command) => [command, async (args: Parameters<NonNullable<import("./commands/index.js").CommandHandler>>[0]) => {
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
              codexHome: codexHomeDirectory(),
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
                  return repositoryTrustProbe(
                    await repositoryTrust(root, config, CLI_VERSION),
                    config.verification.commands.length > 0
                  );
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
                  await probeReviewTargetDetailed(target, { cwd: root, deep }),
                worktrees: async () => await worktreeDoctorProbe(root),
                worktreeBranchLock: async () => await worktreeBranchLockProbe(root),
                rootGhostFiles: async () => await rootGhostFilesProbe(root)
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
              codexHome: codexHomeDirectory(),
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
              codexHome: codexHomeDirectory(),
              ...(updateArgs.hookTargets === undefined
                ? {}
                : { hookTargets: updateArgs.hookTargets }),
              trustStore: store,
              calculateTrustBinding: async (config) =>
                await plannedTrustBinding(root, config),
              confirm: async (plan, trust) =>
                await confirmPlan(formatUpdatePlan(plan, trust)),
              promptWorktree: async (message) =>
                await selectYesNo(
                  message,
                  { input: process.stdin, output: process.stdout },
                  true
                ),
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
            // Only create, attach and status act as a session; a contested
            // record refuses those rather than guess, and leaves the rest.
            const actsAsSession = args.action === "create" ||
              args.action === "attach" || args.action === "status";
            const sessionId = args.sessionId ?? (actsAsSession
              ? await resolveCommandSessionId(root)
              : sessionIdFromEnvironment() ?? await readRecordedSessionId(root));
            if (args.action === "advance") {
              return await runAdvanceCommand({
                cwd: root,
                sessionId: sessionId ?? await resolveCommandSessionId(root),
                parentTaskId: args.taskId,
                deps: worktreeDependencies()
              });
            }
            const createConfig = args.action === "create"
              ? (await loadEffectiveConfig(
                  root,
                  args.scope === "user" ? "user" : "project"
                )).config
              : undefined;
            const policyConfigHash = createConfig === undefined
              ? undefined
              : calculateConfigHash(createConfig);
            // Auto mode starts the work where it belongs: a task created from
            // the main checkout lands in the session's own worktree.
            const worktreeDeps = worktreeDependencies();
            const fromMain = createConfig?.worktree?.mode === "auto" &&
              args.scope !== "user" &&
              await resolveCheckouts(worktreeDeps, root)
                .then(({ mainRoot, currentRoot }) => mainRoot === currentRoot)
                .catch(() => false);
            return await runTaskCommand({
              args,
              service: taskService,
              ...(policyConfigHash === undefined ? {} : { policyConfigHash }),
              ...(sessionId === undefined ? {} : { sessionId }),
              ...(fromMain
                ? {
                    sessionWorktree: async (session: string) => {
                      const record = await ensureSessionWorktree(worktreeDeps, {
                        cwd: root,
                        sessionId: session
                      });
                      return {
                        path: record.path,
                        base: record.base,
                        service: new TaskService(new FileTaskStore(
                          join(record.path, ".agent-ops", "tasks", "state.json"),
                          record.path
                        ))
                      };
                    }
                  }
                : {})
            });
          }
          const probeTarget: NonNullable<ReviewExecutorOptions["preflightTarget"]> =
            async (target, budget) =>
              await probeReviewTargetDetailed(target, {
                cwd: root,
                deep: true,
                // The probe answers within the chain's remaining budget
                // or not at all; its own default would outlast it.
                ...(budget === undefined ? {} : { timeoutMs: budget.timeoutMs })
              });
          // One place builds a review's options, so `review` and each task of
          // a `batch` are reviewed identically.
          const buildReviewOptions = async (
            reviewArgs: ParsedArgs,
            signal: AbortSignal,
            preflightTarget: typeof probeTarget = probeTarget,
            progressPrefix = ""
          ): Promise<ReviewCommandOptions> => {
            const reviewSessionId = process.env.AGENT_OPS_SESSION_ID;
            const reviewGit = gitRunner(root);
            const reviewConfig = (await loadEffectiveConfig(
              root,
              reviewArgs.scope === "user" ? "user" : "project"
            )).config;
            const reviewRole = resolveReviewRole(
              "independent-review",
              reviewConfig.reviewRoles ?? []
            );
            const configuredReviewTargets = reviewRole?.targets ?? [];
            // Every worktree of the repository shares this directory, so the
            // slots bound reviews across writers, not just within one process.
            const commonDirResult = await reviewGit.run([
              "rev-parse",
              "--path-format=absolute",
              "--git-common-dir"
            ]);
            const slotDir = commonDirResult.exitCode === 0
              ? new TextDecoder().decode(commonDirResult.stdout).trim()
              : undefined;
            const inSlot = (
              executor: ReturnType<typeof createReviewExecutor>
            ): ReturnType<typeof createReviewExecutor> =>
              slotDir === undefined
                ? executor
                : async (request) => await withReviewSlot({
                    dir: slotDir,
                    signal,
                    onWait: (line) => {
                      process.stderr.write(`${progressPrefix}${line}\n`);
                    }
                  }, async () => await executor(request));
            return {
              args: reviewArgs,
              authorized: reviewArgs.yes,
              tasks: taskService,
              ...(reviewArgs.taskId === undefined ? {} : { taskId: reviewArgs.taskId }),
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
                  reviewArgs.scope === "user" ? "user" : "project"
                )
              ).config),
              config: reviewConfig,
              evidenceStore: new FileEvidenceStore(root, root),
              execute: inSlot(createReviewExecutor({
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
                preflightTarget,
                verifySourceFingerprint: async (expected) => {
                  const currentScope = await resolveReviewScope({
                    root,
                    runner: reviewGit,
                    ...(reviewArgs.base === undefined ? {} : { base: reviewArgs.base })
                  });
                  return await calculateSourceFingerprint(
                    root,
                    currentScope,
                    reviewGit
                  ) === expected;
                },
                signal,
                onProgress: (line) => {
                  process.stderr.write(`${progressPrefix}${line}\n`);
                }
              }))
            };
          };
          if (args.command === "review") {
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
              return await runReviewCommand(
                await buildReviewOptions(args, controller.signal)
              );
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
          if (args.command === "batch") {
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
              const batchScope = args.scope === "user" ? "user" : "project";
              const batchConfig = (await loadEffectiveConfig(root, batchScope)).config;
              const batchGit = gitRunner(root);
              const trusted = await repositoryTrust(root, batchConfig, CLI_VERSION) === "TRUSTED";
              const guard = await createSourceGuard(batchGit);
              const preflight = memoizePreflight(probeTarget);
              const taskArgs = (taskId: string, base: string): ParsedArgs =>
                parseArgs(["review", "--task", taskId, "--base", base, "--yes"]);
              const worktreeRecord = await readWorktreeRecord(root);
              const envelope = await runBatchCommand({
                args,
                tasks: taskService,
                ...(worktreeRecord === null ? {} : { worktreeBase: worktreeRecord.base }),
                guard,
                isVerified: async (taskId, base) => await hasFreshVerification(
                  await buildReviewOptions(taskArgs(taskId, base), controller.signal, preflight),
                  taskId,
                  base
                ),
                verify: async (taskId, base) => {
                  const report = await new VerificationService({
                    root,
                    scope: batchScope,
                    config: batchConfig,
                    gitRunner: batchGit,
                    processRunner: new NodeVerificationProcessRunner(),
                    taskService,
                    evidenceStore: new FileEvidenceStore(root, root),
                    trusted,
                    base
                  }).verify(taskId);
                  return report.status === "PASS" ? "PASS" : "FAIL";
                },
                review: async (taskId, base, signal) => {
                  const reviewed = await runReviewCommand(await buildReviewOptions(
                    taskArgs(taskId, base),
                    signal,
                    preflight,
                    `${taskId.slice(5, 13)}: `
                  ));
                  const result = reviewed.data?.result;
                  return result === undefined
                    ? { status: "NOT_RUN", reason: reviewed.errors[0]?.code ?? "review-error" }
                    : {
                        status: result.status,
                        ...(result.reason === undefined ? {} : { reason: result.reason }),
                        ...(result.reused === true ? { reused: true as const } : {})
                      };
                },
                signal: controller.signal,
                onProgress: (line) => {
                  process.stderr.write(`batch: ${line}\n`);
                }
              });
              if (interruptedBy !== undefined) {
                process.exit(interruptedBy === "SIGINT" ? 130 : 143);
              }
              return envelope;
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
