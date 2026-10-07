import {
  ACCEPTANCE_FAILURE,
  makeAcceptanceCheck,
  makeAcceptanceRun,
  type AcceptanceCheckResult,
  type AcceptanceFailureClass,
  type AcceptancePhase,
  type AcceptanceRun,
  type AcceptanceStatus
} from "../acceptance-protocol.js";

export interface AcceptanceAdapterOptions {
  readonly executionId: string;
  readonly frameworkVersion: string;
  readonly phase: AcceptancePhase;
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export function array(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function attempts(value: unknown, fallback: number | null = 1): number | null {
  const parsed = number(value);
  return parsed === undefined ? fallback : parsed;
}

export function result(
  options: AcceptanceAdapterOptions,
  framework: string,
  checkId: string,
  status: AcceptanceStatus,
  evidence: readonly string[],
  failureClass: AcceptanceFailureClass = status === "PASS" ? "none" : ACCEPTANCE_FAILURE.infrastructure,
  attemptCount: number | null = 1
): AcceptanceCheckResult {
  return makeAcceptanceCheck({
    executionId: options.executionId,
    framework,
    frameworkVersion: options.frameworkVersion,
    checkId,
    phase: options.phase,
    status,
    failureClass,
    attempts: attemptCount,
    evidence
  });
}

export function unknownResult(
  options: AcceptanceAdapterOptions,
  framework: string,
  checkId: string,
  failureClass: AcceptanceFailureClass,
  evidence: readonly string[] = ["adapter:unknown"],
  attemptCount: number | null = 1
): AcceptanceCheckResult {
  return result(options, framework, checkId, "UNKNOWN", evidence, failureClass, attemptCount);
}

export function run(
  options: AcceptanceAdapterOptions,
  framework: string,
  results: readonly AcceptanceCheckResult[],
  completed: boolean,
  completionEvidence: readonly string[],
  diagnostics: readonly string[] = []
): AcceptanceRun {
  return makeAcceptanceRun({
    executionId: options.executionId,
    framework,
    frameworkVersion: options.frameworkVersion,
    phase: options.phase,
    results,
    completed,
    completionEvidence,
    diagnostics
  });
}

export function lower(value: unknown): string | undefined {
  const text = string(value);
  return text?.toLowerCase();
}

export function hasRetry(value: Record<string, unknown>): boolean {
  if (value.retry === true || value.retried === true) return true;
  const retryCount = number(value.retryCount);
  if (retryCount !== undefined && retryCount > 0) return true;
  const repeatCount = number(value.repeatCount);
  if (repeatCount !== undefined && repeatCount > 0) return true;
  const rerun = number(value.rerun);
  if (rerun !== undefined && rerun > 0) return true;
  const invocations = number(value.invocations);
  if (invocations !== undefined && invocations > 1) return true;
  if (Array.isArray(value.retryReasons) && value.retryReasons.length > 0) return true;
  const attemptsValue = number(value.attempts);
  return attemptsValue !== undefined && attemptsValue > 1;
}

export function terminal(value: Record<string, unknown>): boolean {
  if (value.completed === true || value.complete === true || value.terminal === true) return true;
  const type = lower(value.type ?? value.event);
  return type === "complete" || type === "completed" || type === "finished" ||
    type === "session-finished" || type === "run-complete";
}

export function terminalEvidence(value: Record<string, unknown>, fallback: string): string {
  const id = string(value.executionId) ?? string(value.id) ?? fallback;
  return `terminal:${id}`;
}
