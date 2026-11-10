import { withActivity } from "../../../../runtime/src/office/activity.js";
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
  /** Advisory surface gate lines, shown so a review-time SURFACE_* stop is fixed before review. */
  readonly surface?: (taskId: string) => Promise<readonly string[]>;
  /** Display only: where the Office learns that QA is at work. */
  readonly activity?: {readonly commonDir: string | undefined; readonly root: string; readonly sessionId?: string};
}

export type PublicVerificationCommandReport = Omit<
  VerificationCommandReport,
  "diagnostic" | "startedAt" | "finishedAt" | "output"
> & {
  /** Failing command only: the last 2KB of its redacted output. */
  readonly failureTail?: string;
};

const FAILURE_TAIL_BYTES = 2048;

/** The last `bytes` of `text`, never starting inside a UTF-8 sequence. */
function tail(text: string, bytes = FAILURE_TAIL_BYTES): string {
  const buffer = Buffer.from(text, "utf8");
  return buffer.length <= bytes ? text : buffer.subarray(buffer.length - bytes).toString("utf8").replace(/^�+/u, "");
}

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
  /** Advisory only: never changes the verification status. */
  readonly surface?: readonly string[];
}

function safe(value: string): string {
  return safeTaskText(redactSecrets(value));
}

function publicReport(
  report: VerificationReport
): PublicVerificationReport {
  return {
    ...(report.acceptance === undefined ? {} : {acceptance: report.acceptance}),
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
        result.evidenceReferences.map(redactSecrets),
      ...(result.output === undefined ? {} : {failureTail: tail(redactSecrets(result.output))}),
      ...(result.logPath === undefined ? {} : {logPath: redactSecrets(result.logPath)})
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
    result.testCount === null ? "" : ` (passed tests: ${result.testCount})`;
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
  return [...lines, ...failureLines(result)];
}

// Read the failure here or in the log; rerunning the suite to see it costs a full verify.
function failureLines(result: PublicVerificationCommandReport): string[] {
  return [
    ...(result.failureTail === undefined || result.failureTail.trim() === "" ? [] : [
      `  Output (last ${FAILURE_TAIL_BYTES} bytes, redacted):`,
      ...result.failureTail.replace(/\s+$/u, "").split("\n").map(line => `    ${safe(line.replace(/\t/gu, "  "))}`)
    ]),
    ...(result.logPath === undefined ? [] : [`  Log: ${safe(result.logPath)}`])
  ];
}

function acceptanceLines(report: PublicVerificationReport): string[] {
  return (report.acceptance ?? []).filter(row => row.status !== "PASS").map(row =>
    `- ${row.status} ${safe(row.runnerId)} (${safe(row.criterionId)}, ${row.phase}): ${safe(row.failureClass)}` +
    (row.failedChecks === undefined || row.failedChecks.length === 0 ? "" : `; checks: ${row.failedChecks.map(safe).join(", ")}`) +
    // A timed-out runner step says which step and which limit; plain UNKNOWN left people guessing.
    (row.detail === undefined ? "" : `; ${safe(row.detail)}`));
}

/** Why verification did not pass, safe to print: failing commands with their output tail and log, then non-PASS acceptance rows. */
export function failureDetailLines(report: VerificationReport): string[] {
  const visible = publicReport(report);
  return [
    ...visible.results.filter(result => result.status !== "PASS").flatMap(result => [`- ${result.status} ${safe(result.commandId)}`, ...failureLines(result)]),
    ...acceptanceLines(visible)
  ];
}

function formatReport(report: PublicVerificationReport): string {
  const lines = [
    `Verification task ${safe(report.taskId)}: ${report.status}`,
    `Scope: ${report.selection.reason} (${
      report.selection.fallback ? "fallback" : "bounded"
    })`,
    ...report.results.flatMap(formatResult),
    ...acceptanceLines(report)
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
    const taskId = await resolveTaskId(options), activity = options.activity;
    const report = publicReport(await withActivity(activity?.commonDir,
      {kind: "verify", root: activity?.root ?? "", taskId, ...(activity?.sessionId === undefined ? {} : {sessionId: activity.sessionId})},
      async () => await options.service.verify(taskId)));
    // A broken surface check must not hide the verification result.
    const surface = options.surface === undefined ? [] : await options.surface(taskId).catch(() => []);
    const text = formatReport(report) + surface.map(line => `${safe(line)}\n`).join("");
    const advisory = surface.length === 0 ? {} : {surface};
    if (report.status === "PASS") {
      return okEnvelope("VERIFICATION_PASSED", {
        message: "Required verification passed.",
        report,
        text,
        ...advisory
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
      data: { message, report, text, ...advisory },
      errors: [{ code, message }]
    };
  } catch (error) {
    if (error instanceof AgentOpsError) {
      return errorEnvelope(error.code, safe(error.message));
    }
    throw error;
  }
}
