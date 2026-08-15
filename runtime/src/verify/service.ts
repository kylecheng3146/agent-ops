import type {
  AgentOpsConfig,
  AgentTask,
  InstallScope,
  VerificationCommand
} from "../contracts.js";
import { AgentOpsError, resolveContainedPath } from "../fs/paths.js";
import { validateTaskAgainstConfig } from "../schema/validate.js";
import type { TaskService } from "../task/service.js";
import {
  collectChangeSurface,
  type ChangeSurface,
  type GitRunner
} from "./change-surface.js";
import {
  resolveReviewScope,
  reviewScopeSignature,
  type ReviewScope
} from "../review/scope.js";
import { calculateSourceFingerprint } from "./source-fingerprint.js";
import {
  buildVerificationEvidence,
  type FileEvidenceStore
} from "./evidence.js";
import {
  createFailureFingerprint,
  type FailureApproachSignal
} from "./fingerprint.js";
import {
  aggregateVerificationStatus,
  executeConfiguredCommand,
  type ConfiguredCommandExecution
} from "./command-executor.js";
import {
  selectVerificationScope,
  type ScopeSelection
} from "./scope.js";
import type {
  VerificationProcessRunner,
  VerificationStatus
} from "./spawn.js";

export interface VerificationServiceOptions {
  readonly root: string;
  readonly scope: InstallScope;
  readonly config: AgentOpsConfig;
  readonly gitRunner: GitRunner;
  readonly processRunner: VerificationProcessRunner;
  readonly taskService: TaskService;
  readonly evidenceStore: FileEvidenceStore;
  readonly trusted: boolean;
  readonly now?: () => string;
  readonly toolVersions?: Readonly<Record<string, string>>;
  readonly base?: string;
}

export interface VerificationCommandReport {
  readonly commandId: string;
  readonly required: boolean;
  readonly status: VerificationStatus;
  readonly failureClass: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly testCount: number | null;
  readonly diagnostic: string;
  readonly evidenceReferences: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface VerificationReport {
  readonly taskId: string;
  readonly status: VerificationStatus;
  readonly surface: ChangeSurface;
  readonly selection: ScopeSelection;
  readonly results: readonly VerificationCommandReport[];
  readonly signal: FailureApproachSignal;
  readonly reviewScope: ReviewScope;
  readonly sourceFingerprint: string;
}

function verificationError(
  code: string,
  message: string
): AgentOpsError {
  return new AgentOpsError(code, message);
}

function exitCategory(
  result: VerificationCommandReport
): string {
  if (result.timedOut) {
    return "timeout";
  }
  if (result.failureClass === "signal-exit") {
    return "signal-exit";
  }
  if (result.exitCode === null) {
    return "no-exit";
  }
  return result.exitCode === 0 ? "exit-zero" : "nonzero-exit";
}

function relevantCriteria(
  task: AgentTask,
  commandId: string
): AgentTask["criteria"] {
  return task.criteria.filter((criterion) =>
    criterion.verifierIds.includes(commandId)
  );
}

function commandById(
  config: AgentOpsConfig,
  commandId: string
): VerificationCommand {
  const command = config.verification.commands.find(
    (candidate) => candidate.id === commandId
  );
  if (command === undefined) {
    throw verificationError(
      "VERIFICATION_COMMAND_NOT_FOUND",
      `Verification command not found: ${commandId}`
    );
  }
  return command;
}

export class VerificationService {
  readonly #options: VerificationServiceOptions;

  constructor(options: VerificationServiceOptions) {
    this.#options = options;
  }

  async #commandCwd(command: VerificationCommand): Promise<string> {
    if (command.cwd === ".") {
      return this.#options.root;
    }
    return await resolveContainedPath(
      this.#options.root,
      command.cwd
    );
  }

  async #persistEvidence(
    task: AgentTask,
    command: VerificationCommand,
    startedAt: string,
    finishedAt: string,
    result: Pick<ConfiguredCommandExecution, "testCount" | "status" | "failureClass" | "exitCode">,
    sourceFingerprint: string
  ): Promise<string[]> {
    const references: string[] = [];
    for (const criterion of relevantCriteria(task, command.id)) {
      const evidence = buildVerificationEvidence({
        taskId: task.id,
        criterionId: criterion.id,
        command,
        scope: this.#options.scope,
        startedAt,
        finishedAt,
        exitCode: result.exitCode,
        testCount: result.testCount,
        status: result.status,
        failureClass: result.failureClass,
        sourceFingerprint,
        toolVersions: this.#options.toolVersions ?? {},
        config: this.#options.config
      });
      references.push(
        await this.#options.evidenceStore.save(evidence)
      );
    }
    return references;
  }

  async #runCommand(
    task: AgentTask,
    command: VerificationCommand
  ): Promise<VerificationCommandReport> {
    const startedAt = (this.#options.now ?? (() =>
      new Date().toISOString()))();
    const result = await executeConfiguredCommand(command, {
      cwd: await this.#commandCwd(command),
      runner: this.#options.processRunner,
      trusted: this.#options.trusted
    });
    const fingerprint = result.status === "PASS"
      ? null
      : createFailureFingerprint({
          commandId: command.id,
          failureClass: result.failureClass,
          exitCategory:
            result.timedOut
              ? "timeout"
              : result.signal !== null
                ? "signal-exit"
                : result.exitCode === null
                  ? "no-exit"
                  : result.exitCode === 0
                    ? "exit-zero"
                    : "nonzero-exit",
          diagnostics: result.diagnostic
        });
    const finishedAt = (this.#options.now ?? (() =>
      new Date().toISOString()))();
    return {
      commandId: command.id,
      required: command.required,
      status: result.status,
      failureClass: result.failureClass,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      testCount: result.testCount,
      diagnostic: fingerprint?.diagnostics ?? "",
      evidenceReferences: [],
      startedAt,
      finishedAt
    };
  }

  async verify(taskId: string): Promise<VerificationReport> {
    const stored = await this.#options.taskService.status({ taskId });
    if (stored.status === "archived") {
      throw verificationError(
        "TASK_NOT_ACTIVE",
        "An archived task cannot be verified."
      );
    }
    const validation = validateTaskAgainstConfig(
      stored.task,
      this.#options.config
    );
    if (!validation.ok) {
      throw verificationError(
        "VERIFICATION_INPUT_INVALID",
        validation.errors[0]?.message ??
          "Task and verification configuration are incompatible."
      );
    }

    const reviewScope = await resolveReviewScope({
      root: this.#options.root,
      runner: this.#options.gitRunner,
      ...(this.#options.base === undefined ? {} : { base: this.#options.base })
    });
    const sourceFingerprint = await calculateSourceFingerprint(
      this.#options.root,
      reviewScope,
      this.#options.gitRunner
    );
    const worktreeSurface = reviewScope.mode === "worktree"
      ? await collectChangeSurface(this.#options.gitRunner)
      : { staged: [], unstaged: [], untracked: [], paths: reviewScope.changedFiles };
    const surface = worktreeSurface;
    const selection = selectVerificationScope(
      surface.paths,
      this.#options.config
    );
    const results: VerificationCommandReport[] = [];
    for (const commandId of selection.verifierIds) {
      results.push(
        await this.#runCommand(
          validation.value,
          commandById(this.#options.config, commandId)
        )
      );
    }

    let status = aggregateVerificationStatus(results);
    let sourceChanged = false;
    const postflightScope = await resolveReviewScope({
      root: this.#options.root,
      runner: this.#options.gitRunner,
      ...(this.#options.base === undefined ? {} : { base: this.#options.base })
    });
    const postflightFingerprint = await calculateSourceFingerprint(
      this.#options.root,
      postflightScope,
      this.#options.gitRunner
    );
    if (
      reviewScopeSignature(reviewScope) !== reviewScopeSignature(postflightScope) ||
      sourceFingerprint !== postflightFingerprint
    ) {
      status = "UNKNOWN";
      sourceChanged = true;
    }
    let signal: FailureApproachSignal = null;
    if (status === "PASS") {
      const taskEvidence: Record<string, string[]> = {};
      for (const [index, result] of results.entries()) {
        const command = commandById(this.#options.config, result.commandId);
        const references = await this.#persistEvidence(
          validation.value,
          command,
          result.startedAt,
          result.finishedAt,
          result,
          sourceFingerprint
        );
        results[index] = { ...result, evidenceReferences: references };
        for (const [criterionIndex, criterion] of relevantCriteria(
          validation.value,
          result.commandId
        ).entries()) {
          const reference = references[criterionIndex];
          if (reference !== undefined) {
            taskEvidence[criterion.id] = [
              ...(taskEvidence[criterion.id] ?? []),
              reference
            ];
          }
        }
      }
      if (Object.keys(taskEvidence).length > 0) {
        await this.#options.taskService.recordEvidence(taskId, taskEvidence);
      }
      await this.#options.taskService.clearFailure(taskId);
    } else {
      const required = results.filter((result) => result.required);
      const gating = required;
      const failed = gating.find(
        (result) => result.status !== "PASS"
      );
      if (failed === undefined) {
        if (!sourceChanged) {
          throw verificationError(
            "VERIFICATION_RESULT_INVALID",
            "Verification failed without a required result."
          );
        }
        const advanced = await this.#options.taskService.recordFailure(
          taskId,
          createFailureFingerprint({
            commandId: "source-snapshot",
            failureClass: "source-changed-during-verification",
            exitCategory: "no-exit",
            diagnostics: "source changed during verification"
          })
        );
        signal = advanced.signal;
        return { taskId, status, surface, selection, results, signal, reviewScope, sourceFingerprint };
      }
      const advanced =
        await this.#options.taskService.recordFailure(
          taskId,
          createFailureFingerprint({
            commandId: failed.commandId,
            failureClass: failed.failureClass,
            exitCategory: exitCategory(failed),
            diagnostics: failed.diagnostic
          })
        );
      signal = advanced.signal;
    }

    return {
      taskId,
      status,
      surface,
      selection,
      results,
      signal,
      reviewScope,
      sourceFingerprint
    };
  }
}
