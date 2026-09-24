import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentOpsConfig } from "../../../runtime/src/contracts.js";
import { CompletionGateService } from "../../../runtime/src/hooks/completion-gate.js";
import type { FinishDependencies } from "../../../runtime/src/parallel/finish.js";
import { localStatePaths } from "../../../runtime/src/security/permissions.js";
import { FileTrustStore } from "../../../runtime/src/security/trust.js";
import { TaskService } from "../../../runtime/src/task/service.js";
import { FileTaskStore } from "../../../runtime/src/task/store.js";
import { FileEvidenceStore } from "../../../runtime/src/verify/evidence.js";
import { NodeVerificationProcessRunner } from "../../../runtime/src/verify/spawn.js";
import {
  loadEffectiveConfig,
  repositoryTrust,
  repositoryTrustBinding
} from "./context.js";
import { CLI_VERSION } from "./version.js";

// Shared by the CLI and the hook entry point: Claude Code runs hooks through
// hook-entry.js, never bin.js, and its worktree guard needs these too.

export function gitRunner(root: string) {
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

export function trustStore(): FileTrustStore {
  const state = localStatePaths(process.env.AGENT_OPS_HOME ?? homedir());
  return new FileTrustStore(state.trustStore, state.anchorDirectory);
}

export function worktreeDependencies(): FinishDependencies {
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
