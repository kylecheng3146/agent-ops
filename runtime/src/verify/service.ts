import type {
  AgentOpsConfig,
  AgentTask,
  InstallScope,
  VerificationCommand
} from "../contracts.js";
import {taskContractHash} from "../task/contract.js";
import {replayAcceptance, type AcceptanceReplayResult} from "./acceptance-replay.js";
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
  readonly noChangePaths?: readonly string[];
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
  readonly acceptance?: readonly AcceptanceReplayResult[];
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
    criterion.verifierIds.includes(commandId) || criterion.acceptance !== undefined
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
        ...(task.goal === undefined && (task.contractRevision ?? 0) === 0 && task.criteria.every(c => c.acceptance === undefined) ? {} : {taskContractHash: taskContractHash(task)}),
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

    const missingCriteria = validation.value.criteria.filter((criterion) =>
      criterion.acceptance === undefined && !this.#options.config.verification.commands.some(({ id, required }) =>
        required && criterion.verifierIds.includes(id))
    );
    if (missingCriteria.length > 0) {
      throw verificationError(
        "VERIFICATION_UNKNOWN",
        `Criteria without required coverage: ${missingCriteria.map(({ id }) => id).join(", ")}. Configure at least one required verifier for each criterion and recreate the task; no verifier commands were run.`
      );
    }

    const reviewScope = await resolveReviewScope({
      root: this.#options.root,
      runner: this.#options.gitRunner,
      ...(this.#options.noChangePaths === undefined && stored.noChangePaths === undefined ? {} : {noChangePaths: this.#options.noChangePaths ?? stored.noChangePaths}),
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
    const mappedSelection = selectVerificationScope(
      surface.paths,
      this.#options.config
    );
    const taskVerifierIds = new Set(validation.value.criteria.flatMap((criterion) => criterion.verifierIds));
    const selection: ScopeSelection = {
      ...mappedSelection,
      verifierIds: [...new Set([...mappedSelection.verifierIds,
        ...this.#options.config.verification.commands
          .filter(({ id, required }) => required && (validation.value.criteria.some(c => c.acceptance !== undefined) || taskVerifierIds.has(id)))
          .map(({ id }) => id)])]
    };
    const results: VerificationCommandReport[] = [];
    for (const commandId of selection.verifierIds) {
      results.push(
        await this.#runCommand(
          validation.value,
          commandById(this.#options.config, commandId)
        )
      );
    }

    const acceptance = validation.value.criteria.some(c => c.acceptance !== undefined && c.acceptance.mode !== "review-only")
      ? await replayAcceptance({...this.#options, task: validation.value, sourceFingerprint}) : [];
    let status = aggregateVerificationStatus([...results, ...acceptance.map(a => ({required: true, status: a.status}))]);
    let sourceChanged = false;
    const postflightScope = await resolveReviewScope({
      root: this.#options.root,
      runner: this.#options.gitRunner,
      ...(this.#options.noChangePaths === undefined && stored.noChangePaths === undefined ? {} : {noChangePaths: this.#options.noChangePaths ?? stored.noChangePaths}),
      ...(this.#options.base === undefined ? {} : { base: this.#options.base })
    });
    const postflightFingerprint = await calculateSourceFingerprint(
      this.#options.root,
      postflightScope,
      this.#options.gitRunner
    );
    if (
      reviewScopeSignature(reviewScope) !== reviewScopeSignature(postflightScope) ||
      sourceFingerprint !== postflightFingerprint ||
      taskContractHash((await this.#options.taskService.status({taskId})).task) !== taskContractHash(stored.task)
    ) {
      status = "UNKNOWN";
      sourceChanged = true;
    }
    const acceptanceEvidence: Record<string, string[]> = {};
    for (const proof of acceptance) acceptanceEvidence[proof.criterionId] = [...(acceptanceEvidence[proof.criterionId] ?? []), proof.reference];
    if (status !== "PASS" && stored.status === "active" && acceptance.length > 0)
      await this.#options.taskService.recordEvidence(taskId, acceptanceEvidence);
    let signal: FailureApproachSignal = null;
    if (status === "PASS") {
      const taskEvidence: Record<string, string[]> = {...acceptanceEvidence};
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
        await this.#options.taskService.recordVerificationEvidence(stored, taskEvidence, sourceFingerprint);
      }
    } else {
      const required = [...results.filter((result) => result.required), ...acceptance.map(a => ({commandId: a.runnerId, required: true,
        status: a.status, failureClass: a.failureClass, exitCode: null, timedOut: false, testCount: null,
        diagnostic: a.criterionId + ":" + a.phase + ":" + a.failureClass, evidenceReferences: [a.reference], startedAt: "", finishedAt: ""}))];
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
        return { taskId, status, surface, selection, results, signal, reviewScope, sourceFingerprint, acceptance };
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
      acceptance,
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
