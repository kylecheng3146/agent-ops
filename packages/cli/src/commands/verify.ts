import { AgentOpsError } from "../../../../runtime/src/fs/paths.js";
import { redactSecrets } from "../../../../runtime/src/security/redact.js";
import { safeTaskText } from "../../../../runtime/src/task/render.js";
import type {
  TaskStatusQuery
} from "../../../../runtime/src/task/service.js";
import type {
  VerificationCommandReport,
  VerificationReport
} from "../../../../runtime/src/verify/service.js";
import type { ParsedArgs } from "../args.js";
import {
  errorEnvelope,
  okEnvelope,
  type CliEnvelope
} from "../output.js";

export interface VerificationExecutor {
  verify(taskId: string): Promise<VerificationReport>;
}

export interface VerifyTaskResolver {
  status(
    query: TaskStatusQuery
  ): Promise<{ readonly task: { readonly id: string } }>;
}

export interface VerifyCommandOptions {
  readonly args: ParsedArgs;
  readonly service: VerificationExecutor;
  readonly taskService: VerifyTaskResolver;
  readonly sessionId?: string;
}

export type PublicVerificationCommandReport = Omit<
  VerificationCommandReport,
  "diagnostic" | "startedAt" | "finishedAt"
>;

export interface PublicVerificationReport extends Omit<
  VerificationReport,
  "results"
> {
  readonly results: readonly PublicVerificationCommandReport[];
}

export interface VerifyCommandData {
  readonly message: string;
  readonly report: PublicVerificationReport;
  readonly text: string;
}

function safe(value: string): string {
  return safeTaskText(redactSecrets(value));
}

function publicReport(
  report: VerificationReport
): PublicVerificationReport {
  return {
    taskId: report.taskId,
    status: report.status,
    surface: {
      staged: report.surface.staged.map(redactSecrets),
      unstaged: report.surface.unstaged.map(redactSecrets),
      untracked: report.surface.untracked.map(redactSecrets),
      paths: report.surface.paths.map(redactSecrets)
    },
    selection: {
      verifierIds: [...report.selection.verifierIds],
      fallback: report.selection.fallback,
      reason: report.selection.reason,
      evidence: {
        changedPaths:
          report.selection.evidence.changedPaths.map(redactSecrets),
        mappings: report.selection.evidence.mappings.map(
          (mapping) => ({
            changedPath: redactSecrets(mapping.changedPath),
            mappingPaths: mapping.mappingPaths.map(redactSecrets),
            verifierIds: [...mapping.verifierIds]
          })
        ),
        requiredVerifierIds: [
          ...report.selection.evidence.requiredVerifierIds
        ]
      }
    },
    results: report.results.map((result) => ({
      commandId: result.commandId,
      required: result.required,
      status: result.status,
      failureClass: result.failureClass,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      testCount: result.testCount,
      evidenceReferences:
        result.evidenceReferences.map(redactSecrets)
    })),
    signal: report.signal,
    reviewScope: report.reviewScope.mode === "base"
      ? {
          mode: "base",
          baseRef: redactSecrets(report.reviewScope.baseRef),
          resolvedBase: report.reviewScope.resolvedBase,
          changedFiles: report.reviewScope.changedFiles.map(redactSecrets)
        }
      : {
          mode: "worktree",
          changedFiles: report.reviewScope.changedFiles.map(redactSecrets)
        },
    sourceFingerprint: report.sourceFingerprint
  };
}

function formatResult(
  result: PublicVerificationCommandReport
): string[] {
  const testCount =
    result.testCount === null ? "" : ` (tests: ${result.testCount})`;
  const lines = [
    `- ${result.status} ${safe(result.commandId)}${testCount}`
  ];
  if (result.evidenceReferences.length > 0) {
    lines.push(
      ...result.evidenceReferences.map(
        (reference) => `  Evidence: ${safe(reference)}`
      )
    );
  }
  return lines;
}

function formatReport(report: PublicVerificationReport): string {
  const lines = [
    `Verification task ${safe(report.taskId)}: ${report.status}`,
    `Scope: ${report.selection.reason} (${
      report.selection.fallback ? "fallback" : "bounded"
    })`,
    ...report.results.flatMap(formatResult)
  ];
  if (report.signal !== null) {
    lines.push(`Signal: ${report.signal}`);
  }
  return `${lines.join("\n")}\n`;
}

async function resolveTaskId(
  options: VerifyCommandOptions
): Promise<string> {
  if (options.args.taskId !== undefined) {
    return options.args.taskId;
  }
  const sessionId = options.args.sessionId ?? options.sessionId;
  if (sessionId === undefined) {
    throw new AgentOpsError(
      "VERIFY_TASK_REQUIRED",
      "Verification requires --task, --session, or an injected session identity."
    );
  }
  return (
    await options.taskService.status({ sessionId })
  ).task.id;
}

export async function runVerifyCommand(
  options: VerifyCommandOptions
): Promise<CliEnvelope<VerifyCommandData | null>> {
  try {
    const report = publicReport(
      await options.service.verify(await resolveTaskId(options))
    );
    const text = formatReport(report);
    if (report.status === "PASS") {
      return okEnvelope("VERIFICATION_PASSED", {
        message: "Required verification passed.",
        report,
        text
      });
    }
    const code =
      report.status === "FAIL"
        ? "VERIFICATION_FAILED"
        : "VERIFICATION_UNKNOWN";
    const message =
      report.status === "FAIL"
        ? "Required verification failed."
        : "Required verification could not be established.";
    return {
      code,
      status: "error",
      data: { message, report, text },
      errors: [{ code, message }]
    };
  } catch (error) {
    if (error instanceof AgentOpsError) {
      return errorEnvelope(error.code, safe(error.message));
    }
    throw error;
  }
}
