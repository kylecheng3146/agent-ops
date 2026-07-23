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
  buildVerificationEvidence,
  type FileEvidenceStore
} from "./evidence.js";
import {
  createFailureFingerprint,
  type FailureApproachSignal
} from "./fingerprint.js";
import {
  selectVerificationScope,
  type ScopeSelection
} from "./scope.js";
import {
  runVerificationCommand,
  type SpawnResult,
  type VerificationProcessRunner,
  type VerificationStatus
} from "./spawn.js";
import {
  evaluateTestCount,
  parseTestCount,
  type TestCountCode
} from "./test-count.js";

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
}

export interface VerificationReport {
  readonly taskId: string;
  readonly status: VerificationStatus;
  readonly surface: ChangeSurface;
  readonly selection: ScopeSelection;
  readonly results: readonly VerificationCommandReport[];
  readonly signal: FailureApproachSignal;
}

interface ClassifiedResult {
  readonly status: VerificationStatus;
  readonly failureClass: string;
  readonly testCount: number | null;
}

type CommandExecutionResult = Omit<
  SpawnResult,
  "failureClass"
> & {
  readonly failureClass: string;
};

function verificationError(
  code: string,
  message: string
): AgentOpsError {
  return new AgentOpsError(code, message);
}

function classifyTestCountCode(code: TestCountCode): string {
  const classes: Record<TestCountCode, string> = {
    TEST_COUNT_BELOW_MINIMUM: "test-count-below-minimum",
    TEST_COUNT_INVALID: "test-count-invalid",
    TEST_COUNT_OK: "none",
    TEST_COUNT_REQUIREMENT_INVALID:
      "test-count-requirement-invalid",
    TEST_COUNT_UNPARSEABLE: "test-count-unparseable",
    ZERO_TESTS: "zero-tests"
  };
  return classes[code];
}

function classifyResult(
  command: VerificationCommand,
  spawned: CommandExecutionResult
): ClassifiedResult {
  if (command.evidence.kind === "file") {
    return {
      status:
        spawned.status === "PASS" ? "UNKNOWN" : spawned.status,
      failureClass:
        spawned.status === "PASS"
          ? "file-evidence-unsupported"
          : spawned.failureClass,
      testCount: null
    };
  }
  if (command.evidence.kind !== "test-count") {
    return {
      status: spawned.status,
      failureClass: spawned.failureClass,
      testCount: null
    };
  }
  const testCount = parseTestCount(
    `${spawned.stdout}\n${spawned.stderr}`
  );
  if (spawned.status !== "PASS") {
    return {
      status: spawned.status,
      failureClass: spawned.failureClass,
      testCount
    };
  }
  const evaluation = evaluateTestCount(
    testCount,
    command.evidence.minimum
  );
  return {
    status: evaluation.status,
    failureClass: classifyTestCountCode(evaluation.code),
    testCount: evaluation.testCount
  };
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

function overallStatus(
  results: readonly VerificationCommandReport[]
): VerificationStatus {
  const required = results.filter((result) => result.required);
  const gating = required.length > 0 ? required : results;
  if (gating.some((result) => result.status === "FAIL")) {
    return "FAIL";
  }
  if (gating.some((result) => result.status === "UNKNOWN")) {
    return "UNKNOWN";
  }
  return "PASS";
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

function diagnostics(spawned: CommandExecutionResult): string {
  return spawned.stderr || spawned.stdout || spawned.failureClass;
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
    result: ClassifiedResult,
    exitCode: number | null
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
        exitCode,
        testCount: result.testCount,
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
    const spawned = this.#options.trusted
      ? await runVerificationCommand(command, {
          cwd: await this.#commandCwd(command),
          runner: this.#options.processRunner
        })
      : {
          commandId: command.id,
          status: "UNKNOWN",
          failureClass: "repository-untrusted",
          exitCode: null,
          signal: null,
          timedOut: false,
          durationMs: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false
        } as const;
    const classified = classifyResult(command, spawned);
    const fingerprint = classified.status === "PASS"
      ? null
      : createFailureFingerprint({
          commandId: command.id,
          failureClass: classified.failureClass,
          exitCategory:
            spawned.timedOut
              ? "timeout"
              : spawned.signal !== null
                ? "signal-exit"
                : spawned.exitCode === null
                  ? "no-exit"
                  : spawned.exitCode === 0
                    ? "exit-zero"
                    : "nonzero-exit",
          diagnostics: diagnostics(spawned)
        });
    const finishedAt = (this.#options.now ?? (() =>
      new Date().toISOString()))();
    const evidenceReferences = await this.#persistEvidence(
      task,
      command,
      startedAt,
      finishedAt,
      classified,
      spawned.exitCode
    );
    return {
      commandId: command.id,
      required: command.required,
      status: classified.status,
      failureClass: classified.failureClass,
      exitCode: spawned.exitCode,
      timedOut: spawned.timedOut,
      testCount: classified.testCount,
      diagnostic: fingerprint?.diagnostics ?? "",
      evidenceReferences
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

    const surface = await collectChangeSurface(
      this.#options.gitRunner
    );
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

    const status = overallStatus(results);
    let signal: FailureApproachSignal = null;
    if (status === "PASS") {
      await this.#options.taskService.clearFailure(taskId);
    } else {
      const required = results.filter((result) => result.required);
      const gating = required.length > 0 ? required : results;
      const failed = gating.find(
        (result) => result.status !== "PASS"
      );
      if (failed === undefined) {
        throw verificationError(
          "VERIFICATION_RESULT_INVALID",
          "Verification failed without a gating result."
        );
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
      signal
    };
  }
}
