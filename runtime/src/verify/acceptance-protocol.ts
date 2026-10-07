/**
 * The small, framework-neutral result protocol used by acceptance adapters.
 *
 * Adapters are deliberately consumers of structured harness output. They do
 * not infer assertion failures from arbitrary stdout, and this module keeps
 * the final safety decision in one place.
 */

export const ACCEPTANCE_PROTOCOL_VERSION = 1 as const;

export type AcceptancePhase = "baseline" | "candidate";
export type AcceptanceStatus = "PASS" | "FAIL" | "UNKNOWN";

export const ACCEPTANCE_FAILURE = {
  assertion: "assertion-failed",
  collection: "collection-error",
  duplicate: "duplicate-check",
  emptyEvidence: "empty-evidence",
  fixture: "fixture-error",
  hook: "hook-error",
  incomplete: "incomplete-output",
  infrastructure: "infrastructure-error",
  malformed: "malformed-output",
  missing: "missing-check",
  retry: "retry",
  skipped: "skipped",
  timeout: "timeout",
  todo: "todo",
  unexpected: "unexpected-check",
  unsupported: "unsupported-output",
  xfail: "xfail"
} as const;

export type AcceptanceFailureClass =
  | "none"
  | (typeof ACCEPTANCE_FAILURE)[keyof typeof ACCEPTANCE_FAILURE]
  | (string & {});

export interface AcceptanceCheckResult {
  readonly executionId: string;
  readonly framework: string;
  readonly frameworkVersion: string;
  readonly checkId: string;
  readonly phase: AcceptancePhase;
  readonly status: AcceptanceStatus;
  readonly failureClass: AcceptanceFailureClass;
  /** Number of observed attempts. Unknown attempt counts are never proof. */
  readonly attempts: number | null;
  /** Bounded, non-secret references into the adapter's captured output. */
  readonly evidence: readonly string[];
}

export interface AcceptanceRun {
  readonly protocolVersion: typeof ACCEPTANCE_PROTOCOL_VERSION;
  readonly executionId: string;
  readonly framework: string;
  readonly frameworkVersion: string;
  readonly phase: AcceptancePhase;
  readonly results: readonly AcceptanceCheckResult[];
  /** An explicit terminal marker emitted by the adapter/harness. */
  readonly completed: boolean;
  readonly completionEvidence: readonly string[];
  readonly diagnostics: readonly string[];
}

export interface AcceptanceCheckInput {
  readonly executionId: string;
  readonly framework: string;
  readonly frameworkVersion: string;
  readonly checkId: string;
  readonly phase: AcceptancePhase;
  readonly status: AcceptanceStatus;
  readonly failureClass?: AcceptanceFailureClass;
  readonly attempts?: number | null;
  readonly evidence: readonly string[];
}

export interface AcceptanceRunInput {
  readonly executionId: string;
  readonly framework: string;
  readonly frameworkVersion: string;
  readonly phase: AcceptancePhase;
  readonly results: readonly AcceptanceCheckResult[];
  readonly completed: boolean;
  readonly completionEvidence?: readonly string[];
  readonly diagnostics?: readonly string[];
}

export interface AcceptanceAggregate {
  readonly status: AcceptanceStatus;
  readonly failureClass: AcceptanceFailureClass;
  readonly results: readonly AcceptanceCheckResult[];
  readonly missingCheckIds: readonly string[];
  readonly duplicateCheckIds: readonly string[];
  readonly unexpectedCheckIds: readonly string[];
  readonly diagnostics: readonly string[];
}

export interface ParsedJsonLines {
  readonly values: readonly unknown[];
  readonly invalidLines: readonly number[];
}

const MAX_TEXT = 4096;
const MAX_RESULTS = 4096;
const MAX_EVIDENCE = 32;

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > MAX_TEXT || value.includes("\0") ||
      /[\r\n]/u.test(value)) {
    throw new TypeError(`${field} must be a bounded single-line string.`);
  }
  return value;
}

function boundedEvidence(values: readonly string[]): readonly string[] {
  if (values.length === 0 || values.length > MAX_EVIDENCE ||
      values.some((value) => {
        try {
          text(value, "evidence");
          return false;
        } catch {
          return true;
        }
      })) {
    throw new TypeError("evidence must contain one to 32 bounded strings.");
  }
  return [...values];
}

function attempts(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new TypeError("attempts must be a positive safe integer or null.");
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function stableCheckId(parts: readonly string[]): string {
  const normalized = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (normalized.length === 0) {
    throw new TypeError("A check needs a stable identity.");
  }
  return normalized.join("::");
}

export function makeAcceptanceCheck(input: AcceptanceCheckInput): AcceptanceCheckResult {
  const status = input.status;
  if (status !== "PASS" && status !== "FAIL" && status !== "UNKNOWN") {
    throw new TypeError("Invalid acceptance status.");
  }
  if (input.phase !== "baseline" && input.phase !== "candidate") {
    throw new TypeError("Invalid acceptance phase.");
  }
  const failureClass = input.failureClass ?? (status === "PASS" ? "none" : ACCEPTANCE_FAILURE.infrastructure);
  if (status === "PASS" && failureClass !== "none") {
    throw new TypeError("A passing check must have failureClass none.");
  }
  if (status === "FAIL" && failureClass === "none") {
    throw new TypeError("A failed check needs a failure class.");
  }
  return {
    executionId: text(input.executionId, "executionId"),
    framework: text(input.framework, "framework"),
    frameworkVersion: text(input.frameworkVersion, "frameworkVersion"),
    checkId: text(input.checkId, "checkId"),
    phase: input.phase,
    status,
    failureClass,
    attempts: attempts(input.attempts),
    evidence: boundedEvidence(input.evidence)
  };
}

export function makeAcceptanceRun(input: AcceptanceRunInput): AcceptanceRun {
  if (input.results.length > MAX_RESULTS) {
    throw new TypeError("An acceptance run contains too many check results.");
  }
  if (input.phase !== "baseline" && input.phase !== "candidate") {
    throw new TypeError("Invalid acceptance phase.");
  }
  const completionEvidence = input.completionEvidence ?? [];
  if (input.completed) boundedEvidence(completionEvidence);
  const diagnostics = input.diagnostics ?? [];
  diagnostics.forEach((value) => text(value, "diagnostic"));
  for (const result of input.results) {
    if (result.executionId !== input.executionId ||
        result.framework !== input.framework ||
        result.frameworkVersion !== input.frameworkVersion ||
        result.phase !== input.phase) {
      throw new TypeError("Every check result must use the run execution identity.");
    }
  }
  return {
    protocolVersion: ACCEPTANCE_PROTOCOL_VERSION,
    executionId: text(input.executionId, "executionId"),
    framework: text(input.framework, "framework"),
    frameworkVersion: text(input.frameworkVersion, "frameworkVersion"),
    phase: input.phase,
    results: [...input.results],
    completed: input.completed,
    completionEvidence: [...completionEvidence],
    diagnostics: [...diagnostics]
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function unknown(
  run: AcceptanceRun,
  results: readonly AcceptanceCheckResult[],
  failureClass: AcceptanceFailureClass,
  diagnostics: readonly string[],
  missingCheckIds: readonly string[] = [],
  duplicateCheckIds: readonly string[] = [],
  unexpectedCheckIds: readonly string[] = []
): AcceptanceAggregate {
  return {
    status: "UNKNOWN",
    failureClass,
    results,
    missingCheckIds,
    duplicateCheckIds,
    unexpectedCheckIds,
    diagnostics: [...run.diagnostics, ...diagnostics]
  };
}

export function aggregateAcceptanceRun(
  run: AcceptanceRun,
  requestedCheckIds: readonly string[]
): AcceptanceAggregate {
  const requested = sortedUnique(requestedCheckIds);
  if (requested.length !== requestedCheckIds.length || requested.length === 0) {
    return unknown(run, run.results, ACCEPTANCE_FAILURE.malformed, [
      "Requested check IDs must be non-empty and unique."
    ]);
  }
  if (!run.completed || run.completionEvidence.length === 0) {
    return unknown(run, run.results, ACCEPTANCE_FAILURE.incomplete, [
      "The adapter did not emit a complete terminal marker."
    ]);
  }

  const expected = new Set(requested);
  const counts = new Map<string, number>();
  for (const result of run.results) {
    counts.set(result.checkId, (counts.get(result.checkId) ?? 0) + 1);
  }
  const duplicateCheckIds = sortedUnique(
    [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id)
  );
  const unexpectedCheckIds = sortedUnique(
    run.results.filter((result) => !expected.has(result.checkId)).map((result) => result.checkId)
  );
  const missingCheckIds = requested.filter((id) => !counts.has(id));
  if (duplicateCheckIds.length > 0 || unexpectedCheckIds.length > 0 || missingCheckIds.length > 0) {
    return unknown(
      run,
      run.results,
      duplicateCheckIds.length > 0 ? ACCEPTANCE_FAILURE.duplicate :
        missingCheckIds.length > 0 ? ACCEPTANCE_FAILURE.missing : ACCEPTANCE_FAILURE.unexpected,
      ["The observed checks do not match the requested checks exactly."],
      missingCheckIds,
      duplicateCheckIds,
      unexpectedCheckIds
    );
  }

  const requestedResults = requested.map((id) => run.results.find((result) => result.checkId === id)!);
  if (run.diagnostics.length > 0) {
    return unknown(run, requestedResults, ACCEPTANCE_FAILURE.infrastructure, [
      "The adapter reported execution diagnostics.",
      ...run.diagnostics
    ]);
  }
  for (const result of requestedResults) {
    if (result.evidence.length === 0) {
      return unknown(run, requestedResults, ACCEPTANCE_FAILURE.emptyEvidence, [
        `Check ${result.checkId} has no evidence.`
      ]);
    }
    if (result.attempts === null || result.attempts !== 1 || result.failureClass === ACCEPTANCE_FAILURE.retry) {
      return unknown(run, requestedResults, ACCEPTANCE_FAILURE.retry, [
        `Check ${result.checkId} has missing or repeated attempts.`
      ]);
    }
    if (result.status === "UNKNOWN") {
      return unknown(run, requestedResults, result.failureClass, [
        `Check ${result.checkId} did not produce a mechanical result.`
      ]);
    }
    if (result.status === "PASS" && result.failureClass !== "none") {
      return unknown(run, requestedResults, ACCEPTANCE_FAILURE.malformed, [
        `Check ${result.checkId} marked PASS with a failure class.`
      ]);
    }
    if (result.status === "FAIL" && result.failureClass !== ACCEPTANCE_FAILURE.assertion) {
      return unknown(run, requestedResults, result.failureClass, [
        `Check ${result.checkId} failed outside an assertion.`
      ]);
    }
  }
  if (requestedResults.some((result) => result.status === "FAIL")) {
    return {
      status: "FAIL",
      failureClass: ACCEPTANCE_FAILURE.assertion,
      results: requestedResults,
      missingCheckIds: [],
      duplicateCheckIds: [],
      unexpectedCheckIds: [],
      diagnostics: [...run.diagnostics]
    };
  }
  return {
    status: "PASS",
    failureClass: "none",
    results: requestedResults,
    missingCheckIds: [],
    duplicateCheckIds: [],
    unexpectedCheckIds: [],
    diagnostics: [...run.diagnostics]
  };
}

export function parseJsonLines(source: string): ParsedJsonLines {
  const values: unknown[] = [];
  const invalidLines: number[] = [];
  source.split(/\r?\n/u).forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    try {
      values.push(JSON.parse(trimmed) as unknown);
    } catch {
      invalidLines.push(index + 1);
    }
  });
  return { values, invalidLines };
}

export function parseJsonDocument(source: string): unknown | undefined {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
}
