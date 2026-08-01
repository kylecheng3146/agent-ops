import type {
  AgentOpsConfig,
  VerificationCommand
} from "../contracts.js";
import { calculateConfigHash } from "../config/hash.js";
import { AgentOpsError, resolveContainedPath } from "../fs/paths.js";
import type { StopVerifierReport } from "./events.js";
import {
  aggregateVerificationStatus,
  executeConfiguredCommand,
  type ConfiguredCommandExecution
} from "../verify/command-executor.js";
import {
  collectChangeSurface,
  type GitRunner
} from "../verify/change-surface.js";
import { selectVerificationScope } from "../verify/scope.js";
import type { VerificationProcessRunner } from "../verify/spawn.js";

export const STOP_VERIFICATION_ENV = "AGENT_OPS_STOP_VERIFY_ACTIVE";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface StopVerificationServiceOptions {
  readonly root: string;
  readonly config: AgentOpsConfig;
  readonly trusted: boolean;
  readonly gitRunner: GitRunner;
  readonly processRunner: VerificationProcessRunner;
  readonly recursionActive: boolean;
  readonly configHash: string;
}

function stopError(code: string, message: string): AgentOpsError {
  return new AgentOpsError(code, message);
}

function commandById(
  config: AgentOpsConfig,
  commandId: string
): VerificationCommand {
  const command = config.verification.commands.find(
    (candidate) => candidate.id === commandId
  );
  if (command === undefined) {
    throw stopError(
      "STOP_VERIFICATION_COMMAND_NOT_FOUND",
      `Stop verification command not found: ${commandId}`
    );
  }
  return command;
}

export class StopVerificationService {
  readonly #options: StopVerificationServiceOptions;

  constructor(options: StopVerificationServiceOptions) {
    this.#options = options;
  }

  #assertReady(): void {
    if (!this.#options.config.features.stopVerification.enabled) {
      throw stopError(
        "STOP_VERIFICATION_DISABLED",
        "Stop verification is not enabled in configuration."
      );
    }
    if (this.#options.config.verification.commands.length === 0) {
      throw stopError(
        "STOP_VERIFICATION_COMMANDS_REQUIRED",
        "Stop verification requires at least one configured command."
      );
    }
    if (!this.#options.trusted) {
      throw stopError(
        "STOP_VERIFICATION_UNTRUSTED",
        "Stop verification requires a trusted repository."
      );
    }
    if (
      this.#options.recursionActive ||
      process.env[STOP_VERIFICATION_ENV] === "1"
    ) {
      throw stopError(
        "STOP_VERIFICATION_RECURSION",
        "Stop verification recursion is active."
      );
    }
    if (
      !HASH_PATTERN.test(this.#options.configHash) ||
      calculateConfigHash(this.#options.config) !== this.#options.configHash
    ) {
      throw stopError(
        "STOP_VERIFICATION_UNCONFIRMED",
        "Stop verification configuration is stale or unconfirmed."
      );
    }
  }

  async verify(): Promise<StopVerifierReport> {
    this.#assertReady();
    const surface = await collectChangeSurface(this.#options.gitRunner);
    const selection = selectVerificationScope(
      surface.paths,
      this.#options.config
    );
    const executions: ConfiguredCommandExecution[] = [];
    for (const commandId of selection.verifierIds) {
      const command = commandById(this.#options.config, commandId);
      const cwd =
        command.cwd === "."
          ? this.#options.root
          : await resolveContainedPath(this.#options.root, command.cwd);
      const result = await executeConfiguredCommand(command, {
        cwd,
        runner: this.#options.processRunner,
        trusted: true,
        env: { [STOP_VERIFICATION_ENV]: "1" }
      });
      executions.push(result);
    }
    const results: StopVerifierReport["results"] = executions.map(
      ({ commandId, exitCode, testCount }) => ({
        commandId,
        exitCode,
        testCount
      })
    );
    return {
      status: aggregateVerificationStatus(executions),
      results
    };
  }
}
