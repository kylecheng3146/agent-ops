import type {
  AgentOpsConfig,
  VerificationCommand
} from "../contracts.js";
import { calculateConfigHash } from "../config/hash.js";
import { AgentOpsError, resolveContainedPath } from "../fs/paths.js";
import type { HookCommandEvidence, StopVerifierReport } from "./events.js";
import { findReviewAttestation } from "../review/attestation.js";
import { resolveReviewScope } from "../review/scope.js";
import { calculateSourceFingerprint } from "../verify/source-fingerprint.js";
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

export const REVIEW_GATE_COMMAND_ID = "independent-review";

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

  /**
   * Reports whether the current source state carries a passing independent
   * review. Returns null when no gate applies: an unchanged tree, or a
   * repository this service cannot inspect. Infrastructure that cannot answer
   * stays fail-open — only a resolvable change surface with no attestation
   * fails closed.
   */
  async #reviewGate(): Promise<HookCommandEvidence | null> {
    if ((this.#options.config.reviewRoles ?? []).length === 0) {
      return null;
    }
    let fingerprint: string;
    try {
      const scope = await resolveReviewScope({
        root: this.#options.root,
        runner: this.#options.gitRunner
      });
      fingerprint = await calculateSourceFingerprint(
        this.#options.root,
        scope,
        this.#options.gitRunner
      );
    } catch {
      return null;
    }
    const attestation = await findReviewAttestation(
      this.#options.root,
      fingerprint
    );
    return {
      commandId: REVIEW_GATE_COMMAND_ID,
      exitCode: attestation === null ? 1 : 0,
      testCount: null
    };
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
    const reviewGate = await this.#reviewGate();
    const results: StopVerifierReport["results"] = [
      ...executions.map(({ commandId, exitCode, testCount }) => ({
        commandId,
        exitCode,
        testCount
      })),
      ...(reviewGate === null ? [] : [reviewGate])
    ];
    return {
      status:
        reviewGate !== null && reviewGate.exitCode !== 0
          ? "FAIL"
          : aggregateVerificationStatus(executions),
      results
    };
  }
}
