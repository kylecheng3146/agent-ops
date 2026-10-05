import { canonicalJson } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import type { AcceptanceReplayResult } from "../verify/acceptance-replay.js";
import type { VerificationCommandReport, VerificationReport } from "../verify/service.js";

export type ConvergenceStatus = "PASS" | "FAIL" | "UNKNOWN";
export type ConvergencePhase = "verification" | "baseline" | "candidate" | "review" | "native";

export type VerificationReportForConvergence = Pick<VerificationReport, "taskId"> & {
  readonly status?: ConvergenceStatus;
  readonly results: readonly Pick<VerificationCommandReport, "commandId" | "required" | "status" | "failureClass">[];
  readonly acceptance?: readonly Pick<AcceptanceReplayResult, "criterionId" | "runnerId" | "phase" | "status" | "failureClass">[];
};

export interface FailureCheckObservation {
  readonly criterionId: string | null;
  readonly runnerId: string | null;
  readonly checkId: string;
  readonly phase: ConvergencePhase;
  readonly status: ConvergenceStatus;
  readonly failureClass: string;
  readonly pinId: string | null;
}

export interface FailureObservation {
  readonly taskId: string;
  /** Deterministic semantic PASS/FAIL/UNKNOWN vector; diagnostics are absent. */
  readonly checks: readonly FailureCheckObservation[];
  readonly pendingPinIds: readonly string[];
  /** A digest of the currently failing semantic checks, or null when green. */
  readonly failureKey: string | null;
  /** A digest of all checked statuses and pending stable pins. */
  readonly progressDigest: string;
}

export interface FailureObservationOptions {
  /** Stable report references returned by the finding ratchet. */
  readonly pendingPinIds?: readonly string[];
}

export interface FailureObservationComparison {
  readonly sameFailure: boolean;
  readonly usefulProgress: boolean;
  readonly failureKey: string | null;
  readonly progressDigest: string;
}

const MAX_ID = 4_096;

function bounded(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded single-line string.`);
  }
  return value;
}

function status(value: unknown): ConvergenceStatus {
  return value === "PASS" || value === "FAIL" ? value : "UNKNOWN";
}

function failureClass(value: unknown, current: ConvergenceStatus): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID || value.includes("\0") || /[\r\n]/u.test(value)) {
    return current === "PASS" ? "none" : "unknown";
  }
  return value;
}

function stablePins(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => bounded(value, "pinId")))].sort();
}

function itemKey(check: FailureCheckObservation): Record<string, string | null> {
  return {
    criterionId: check.criterionId,
    runnerId: check.runnerId,
    checkId: check.checkId,
    phase: check.phase,
    pinId: check.pinId
  };
}

function identity(check: FailureCheckObservation): Record<string, string | null> {
  return {
    ...itemKey(check),
    status: check.status,
    failureClass: check.failureClass
  };
}

function sortedChecks(checks: readonly FailureCheckObservation[]): FailureCheckObservation[] {
  return [...checks].sort((left, right) => canonicalJson(identity(left)).localeCompare(canonicalJson(identity(right))));
}

function commandObservation(result: Pick<VerificationCommandReport, "commandId" | "required" | "status" | "failureClass">): FailureCheckObservation {
  const current = status(result.status);
  return {
    criterionId: null,
    runnerId: null,
    checkId: bounded(result.commandId, "commandId"),
    phase: "verification",
    status: current,
    failureClass: failureClass(result.failureClass, current),
    pinId: null
  };
}

function acceptanceObservation(result: Pick<AcceptanceReplayResult, "criterionId" | "runnerId" | "phase" | "status" | "failureClass">): FailureCheckObservation {
  const current = status(result.status);
  const criterionId = bounded(result.criterionId, "criterionId");
  return {
    criterionId,
    runnerId: bounded(result.runnerId, "runnerId"),
    checkId: criterionId,
    phase: result.phase === "baseline" || result.phase === "candidate" ? result.phase : "candidate",
    status: current,
    failureClass: failureClass(result.failureClass, current),
    pinId: null
  };
}

function pinObservation(pinId: string): FailureCheckObservation {
  return {
    criterionId: null,
    runnerId: null,
    checkId: pinId,
    phase: "review",
    status: "FAIL",
    failureClass: "pinned-finding",
    pinId
  };
}

/**
 * Turn a verifier report and the saved finding ratchet into a stable semantic
 * observation. Raw diagnostics, source commits, timestamps, and task failure
 * fingerprints are deliberately not read by this function.
 */
export function deriveFailureObservation(
  report: VerificationReportForConvergence,
  options: FailureObservationOptions = {}
): FailureObservation {
  const checks: FailureCheckObservation[] = [
    ...report.results.filter((result) => result.required).map(commandObservation),
    ...(report.acceptance ?? []).map(acceptanceObservation),
    ...stablePins(options.pendingPinIds).map(pinObservation)
  ];
  if (checks.length === 0 && report.status !== undefined && report.status !== "PASS") {
    checks.push({
      criterionId: null,
      runnerId: null,
      checkId: "verification",
      phase: "verification",
      status: status(report.status),
      failureClass: "verification-failed",
      pinId: null
    });
  }
  const ordered = sortedChecks(checks);
  const pendingPinIds = stablePins(options.pendingPinIds);
  const failing = ordered.filter((check) => check.status !== "PASS").map(identity);
  return {
    taskId: bounded(report.taskId, "taskId"),
    checks: ordered,
    pendingPinIds,
    failureKey: failing.length === 0 ? null : sha256(canonicalJson({taskId: report.taskId, failing})),
    progressDigest: sha256(canonicalJson({
      taskId: report.taskId,
      checks: ordered.map((check) => identity(check)),
      pendingPinIds
    }))
  };
}

/** Compare only stable check identities; diagnostic text never participates. */
export function compareFailureObservations(
  previous: FailureObservation,
  current: FailureObservation
): FailureObservationComparison {
  const currentByItem = new Map(current.checks.map((check) => [canonicalJson(itemKey(check)), check]));
  const passed = previous.checks.some((check) => {
    if (check.status === "PASS") return false;
    return currentByItem.get(canonicalJson(itemKey(check)))?.status === "PASS";
  });
  const currentPins = new Set(current.pendingPinIds);
  const dischargedPin = previous.pendingPinIds.some((pinId) => !currentPins.has(pinId));
  return {
    sameFailure: previous.failureKey !== null && previous.failureKey === current.failureKey,
    usefulProgress: passed || dischargedPin,
    failureKey: current.failureKey,
    progressDigest: current.progressDigest
  };
}
