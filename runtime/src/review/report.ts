import type { ReviewCriterionResult } from "./result.js";

export interface ReviewReportCriterionResult {
  readonly criterionId: string;
  readonly status: "PASS" | "FAIL";
  readonly summary: string;
  readonly evidence: readonly string[];
}

export interface ReviewFindingLocation {
  readonly path: string;
  readonly line?: number;
}

export interface ReviewFinding {
  readonly severity: "critical" | "important" | "minor";
  readonly blocking: boolean;
  readonly title: string;
  readonly details: string;
  readonly locations: readonly ReviewFindingLocation[];
  readonly evidence: readonly string[];
  readonly recommendation: string;
  readonly criterionIds: readonly string[];
}

export interface ReviewReport {
  readonly summary: string;
  readonly results: readonly ReviewReportCriterionResult[];
  readonly findings: readonly ReviewFinding[];
  readonly residualRisks: readonly string[];
  readonly changedFilesInspected: readonly string[];
  readonly supportingFilesInspected: readonly string[];
}

export interface ReviewValidationError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type ReviewReportValidation =
  | { readonly ok: true; readonly value: ReviewReport }
  | { readonly ok: false; readonly errors: readonly ReviewValidationError[] };

const MAX_ERRORS = 20;
const MAX_TEXT = 16 * 1024;
const MAX_ARRAY = 128;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" &&
    !value.includes("\0") &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_TEXT;
}

function textArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_ARRAY && value.every(isText);
}

function safePath(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    SAFE_PATH.test(value) &&
    value.split("/").every((segment) => segment.length > 0 && segment !== ".");
}

function invalid(
  errors: ReviewValidationError[],
  path: string,
  code: string,
  message: string
): void {
  if (errors.length < MAX_ERRORS) {
    errors.push({ path, code, message });
  }
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  path: string,
  errors: ReviewValidationError[]
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length === expected.length && actual.every((field, index) => field === expected[index])) {
    return true;
  }
  invalid(errors, path, "INVALID_FIELDS", "Unexpected or missing fields.");
  return false;
}

function reportCriterion(
  value: unknown,
  path: string,
  errors: ReviewValidationError[]
): ReviewReportCriterionResult | undefined {
  if (!isRecord(value) || !exactFields(value, ["criterionId", "status", "summary", "evidence"], path, errors)) {
    return undefined;
  }
  if (!isText(value.criterionId) || (value.status !== "PASS" && value.status !== "FAIL") ||
    !isText(value.summary) || !textArray(value.evidence) || value.evidence.length === 0) {
    invalid(errors, path, "INVALID_CRITERION", "Criterion result is invalid.");
    return undefined;
  }
  return {
    criterionId: value.criterionId,
    status: value.status,
    summary: value.summary,
    evidence: [...value.evidence]
  };
}

function location(
  value: unknown,
  path: string,
  errors: ReviewValidationError[]
): ReviewFindingLocation | undefined {
  if (!isRecord(value) || !exactFields(value, ["path", "line"].filter((field) => field !== "line" || "line" in value), path, errors)) {
    return undefined;
  }
  const line = value.line;
  if (!safePath(value.path) || (line !== undefined && (!Number.isSafeInteger(line) || typeof line !== "number" || line < 1))) {
    invalid(errors, path, "INVALID_LOCATION", "Finding location is invalid.");
    return undefined;
  }
  return line === undefined ? { path: value.path } : { path: value.path, line };
}

function finding(
  value: unknown,
  path: string,
  errors: ReviewValidationError[]
): ReviewFinding | undefined {
  if (!isRecord(value) || !exactFields(value, [
    "severity", "blocking", "title", "details", "locations", "evidence", "recommendation", "criterionIds"
  ], path, errors)) {
    return undefined;
  }
  if ((value.severity !== "critical" && value.severity !== "important" && value.severity !== "minor") ||
    typeof value.blocking !== "boolean" || !isText(value.title) || !isText(value.details) ||
    !Array.isArray(value.locations) || value.locations.length > MAX_ARRAY ||
    !textArray(value.evidence) || value.evidence.length === 0 || !isText(value.recommendation) ||
    !textArray(value.criterionIds) || new Set(value.criterionIds).size !== value.criterionIds.length ||
    (value.severity === "critical" && value.blocking !== true) ||
    (value.severity === "minor" && value.blocking !== false)) {
    invalid(errors, path, "INVALID_FINDING", "Finding is invalid.");
    return undefined;
  }
  const locations = value.locations.map((item, index) => location(item, `${path}.locations[${index}]`, errors));
  if (locations.some((item) => item === undefined)) {
    return undefined;
  }
  return {
    severity: value.severity,
    blocking: value.blocking,
    title: value.title,
    details: value.details,
    locations: locations as ReviewFindingLocation[],
    evidence: [...value.evidence],
    recommendation: value.recommendation,
    criterionIds: [...value.criterionIds]
  };
}

export function validateReviewReport(
  value: unknown,
  requestedCriterionIds: readonly string[],
  changedFiles?: readonly string[]
): ReviewReportValidation {
  const errors: ReviewValidationError[] = [];
  if (!isRecord(value) || !exactFields(value, [
    "summary", "results", "findings", "residualRisks", "changedFilesInspected", "supportingFilesInspected"
  ], "$", errors)) {
    return { ok: false, errors };
  }
  if (!isText(value.summary) || !Array.isArray(value.results) || value.results.length !== requestedCriterionIds.length ||
    !Array.isArray(value.findings) || value.findings.length > MAX_ARRAY || !textArray(value.residualRisks) ||
    !Array.isArray(value.changedFilesInspected) || !Array.isArray(value.supportingFilesInspected) ||
    !value.changedFilesInspected.every(safePath) || !value.supportingFilesInspected.every(safePath) ||
    new Set(value.changedFilesInspected).size !== value.changedFilesInspected.length ||
    new Set(value.supportingFilesInspected).size !== value.supportingFilesInspected.length) {
    invalid(errors, "$", "INVALID_REPORT", "Review report is invalid.");
    return { ok: false, errors };
  }
  const results = value.results.map((item, index) => reportCriterion(item, `$.results[${index}]`, errors));
  const findings = value.findings.map((item, index) => finding(item, `$.findings[${index}]`, errors));
  if (results.some((item) => item === undefined) || findings.some((item) => item === undefined)) {
    return { ok: false, errors };
  }
  const expected = new Set(requestedCriterionIds);
  if (
    changedFiles !== undefined &&
    (value.changedFilesInspected.length !== changedFiles.length ||
      new Set(value.changedFilesInspected).size !== new Set(changedFiles).size ||
      value.changedFilesInspected.some((path) => !changedFiles.includes(path)))
  ) {
    invalid(errors, "$.changedFilesInspected", "INCOMPLETE_SCOPE", "Changed files must match the requested scope exactly.");
  }
  const seen = new Set<string>();
  for (const result of results as ReviewReportCriterionResult[]) {
    if (!expected.has(result.criterionId) || seen.has(result.criterionId)) {
      invalid(errors, "$.results", "UNEXPECTED_CRITERION", "Criterion IDs must match the request exactly.");
      break;
    }
    seen.add(result.criterionId);
  }
  if (seen.size !== expected.size) {
    invalid(errors, "$.results", "MISSING_CRITERION", "Every requested criterion is required.");
  }
  const failed = new Set((results as ReviewReportCriterionResult[])
    .filter((result) => result.status === "FAIL")
    .map((result) => result.criterionId));
  const declared = new Set([
    ...value.changedFilesInspected,
    ...value.supportingFilesInspected
  ]);
  const blockingByCriterion = new Set<string>();
  for (const item of findings as ReviewFinding[]) {
    if (item.criterionIds.some((criterionId) => !expected.has(criterionId)) ||
      (item.blocking && item.criterionIds.some((criterionId) => !failed.has(criterionId))) ||
      item.locations.some((itemLocation) => !declared.has(itemLocation.path))) {
      invalid(errors, "$.findings", "INVALID_FINDING_LINK", "Finding links an unknown criterion or path.");
    }
    if (item.blocking) {
      for (const criterionId of item.criterionIds) {
        blockingByCriterion.add(criterionId);
      }
    }
  }
  for (const criterionId of failed) {
    if (!blockingByCriterion.has(criterionId)) {
      invalid(errors, "$.findings", "MISSING_BLOCKING_FINDING", "Every failed criterion needs a blocking finding.");
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      summary: value.summary,
      results: results as ReviewReportCriterionResult[],
      findings: findings as ReviewFinding[],
      residualRisks: [...value.residualRisks],
      changedFilesInspected: [...value.changedFilesInspected],
      supportingFilesInspected: [...value.supportingFilesInspected]
    }
  };
}

export function reviewReportResults(report: ReviewReport): readonly ReviewCriterionResult[] {
  return report.results.map(({ criterionId, status, evidence }) => ({ criterionId, status, evidence }));
}

export function reviewReportStatus(report: ReviewReport): "PASS" | "FAIL" {
  return report.results.some((result) => result.status === "FAIL") ||
    report.findings.some((item) => item.blocking)
    ? "FAIL"
    : "PASS";
}
