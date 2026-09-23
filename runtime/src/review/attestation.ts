import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { AgentOpsError } from "../fs/paths.js";
import { sha256 } from "../fs/hash.js";
import {
  readPrivateFile,
  writePrivateFile
} from "../security/permissions.js";
import { redactSecrets } from "../security/redact.js";
import { safeTaskText } from "../task/render.js";
import type {
  PriorReviewFinding,
  ReviewAttempt,
  ReviewPreflightAttempt,
  ReviewRunResult
} from "./runner.js";
import { redactReviewReport } from "./runner.js";
import type { ReviewReport } from "./report.js";
import type { ReviewTargetId } from "../contracts.js";

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

export const REVIEW_ATTESTATION_DIRECTORY = ".agent-ops/reviews";
export const REVIEW_REPORT_ARTIFACT_SUFFIX = ".reports.json";

const REVIEW_TARGETS = new Set<ReviewTargetId>(["agy", "claude", "codex"]);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const REPORT_ARTIFACT_MAX_BYTES = 512 * 1024;

/**
 * A durable record that one independent review passed against exactly one
 * source state. The source fingerprint is the key: any later edit produces a
 * different fingerprint, so a stale attestation can never satisfy a gate.
 */
export interface ReviewAttestation {
  readonly schemaVersion: 2;
  readonly taskId?: string;
  readonly harness: ReviewTargetId;
  readonly status: "PASS";
  readonly sourceFingerprint: string;
  readonly reviewTargets: readonly [ReviewTargetId, ReviewTargetId];
  readonly reviewSessionIds: readonly [string, string];
  readonly sessionIsolation: "fresh";
  readonly primaryReportDigest: string;
  readonly adversarialReportDigest: string;
  readonly reportArtifact: string;
  readonly hostTarget?: ReviewTargetId;
  readonly createdAt: string;
}

export interface ReviewReportArtifact {
  readonly schemaVersion: 1;
  readonly sourceFingerprint: string;
  readonly taskId?: string;
  readonly status: ReviewRunResult["status"];
  readonly harness: ReviewTargetId;
  readonly plannedTargets: readonly ReviewTargetId[];
  readonly hostTarget?: ReviewTargetId;
  readonly hostRestriction?: "network-blocked" | "bind-blocked";
  readonly independence?: ReviewRunResult["independence"];
  readonly sessionIsolation?: "fresh";
  readonly attempts: readonly ReviewAttempt[];
  readonly preflight: readonly ReviewPreflightAttempt[];
  readonly reason?: string;
  readonly report?: ReviewReport;
  readonly adversarial?: {
    readonly target: ReviewTargetId;
    readonly refuted: boolean;
    readonly report: ReviewReport;
  };
  readonly createdAt: string;
}

function isReviewTarget(value: unknown): value is ReviewTargetId {
  return typeof value === "string" && REVIEW_TARGETS.has(value as ReviewTargetId);
}

function safeText(value: string): string {
  return safeTaskText(redactSecrets(value));
}

function safeAttempt(attempt: ReviewAttempt): ReviewAttempt {
  return {
    target: attempt.target,
    status: attempt.status,
    ...(attempt.sessionId === undefined ? {} : { sessionId: safeText(attempt.sessionId) }),
    ...(attempt.reason === undefined ? {} : { reason: safeText(attempt.reason) }),
    ...(attempt.diagnostic === undefined ? {} : { diagnostic: safeText(attempt.diagnostic) }),
    // Numbers only, so the cost of a round survives in the record too.
    ...(attempt.metrics === undefined ? {} : { metrics: attempt.metrics })
  };
}

function safePreflight(attempt: ReviewPreflightAttempt): ReviewPreflightAttempt {
  return {
    target: attempt.target,
    status: attempt.status,
    ...(attempt.reason === undefined ? {} : { reason: attempt.reason }),
    ...(attempt.diagnostic === undefined ? {} : { diagnostic: safeText(attempt.diagnostic) })
  };
}

function artifactPath(root: string, fingerprint: string): string {
  return join(
    root,
    ...REVIEW_ATTESTATION_DIRECTORY.split("/"),
    `${fingerprint}${REVIEW_REPORT_ARTIFACT_SUFFIX}`
  );
}

export function reviewReportDigest(report: ReviewReport): string {
  return sha256(JSON.stringify(redactReviewReport(report)));
}

function reportArtifact(
  result: ReviewRunResult,
  sourceFingerprint: string,
  taskId?: string
): ReviewReportArtifact {
  return {
    schemaVersion: 1,
    sourceFingerprint,
    ...(taskId === undefined ? {} : { taskId }),
    status: result.status,
    harness: result.harness,
    plannedTargets: [...(result.plannedTargets ?? [result.harness])],
    ...(result.hostTarget === undefined ? {} : { hostTarget: result.hostTarget }),
    ...(result.hostRestriction === undefined
      ? {}
      : { hostRestriction: result.hostRestriction }),
    ...(result.independence === undefined
      ? {}
      : { independence: result.independence }),
    ...(result.sessionIsolation === undefined
      ? {}
      : { sessionIsolation: result.sessionIsolation }),
    attempts: (result.attempts ?? []).map(safeAttempt),
    preflight: (result.preflight ?? []).map(safePreflight),
    ...(result.reason === undefined ? {} : { reason: safeText(result.reason) }),
    ...(result.report === undefined
      ? {}
      : { report: redactReviewReport(result.report) }),
    ...(result.adversarial === undefined
      ? {}
      : {
          adversarial: {
            target: result.adversarial.target,
            refuted: result.adversarial.refuted,
            report: redactReviewReport(result.adversarial.report)
          }
        }),
    createdAt: new Date().toISOString()
  };
}

function matchingReportArtifact(
  value: unknown,
  attestation: ReviewAttestation
): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const attempts = record.attempts;
  const plannedTargets = record.plannedTargets;
  const adversarial = record.adversarial;
  if (
    record.schemaVersion !== 1 ||
    record.sourceFingerprint !== attestation.sourceFingerprint ||
    record.status !== "PASS" ||
    record.harness !== attestation.harness ||
    record.harness !== attestation.reviewTargets[0] ||
    record.taskId !== attestation.taskId ||
    record.hostTarget !== attestation.hostTarget ||
    !Array.isArray(plannedTargets) ||
    plannedTargets.length !== 2 ||
    plannedTargets[0] !== attestation.reviewTargets[0] ||
    plannedTargets[1] !== attestation.reviewTargets[1] ||
    !Array.isArray(attempts) ||
    attempts.length !== 2 ||
    !attempts.every(
      (attempt, index) =>
        typeof attempt === "object" &&
        attempt !== null &&
        (attempt as Record<string, unknown>).target === attestation.reviewTargets[index] &&
        (attempt as Record<string, unknown>).status === "PASS" &&
        typeof (attempt as Record<string, unknown>).sessionId === "string" &&
        SESSION_ID_PATTERN.test((attempt as Record<string, unknown>).sessionId as string)
    ) ||
    !Array.isArray(record.preflight) ||
    typeof record.report !== "object" ||
    record.report === null ||
    typeof adversarial !== "object" ||
    adversarial === null
  ) {
    return false;
  }
  const adversarialRecord = adversarial as Record<string, unknown>;
  return (
    adversarialRecord.target === attestation.reviewTargets[1] &&
    adversarialRecord.refuted === false &&
    typeof adversarialRecord.report === "object" &&
    adversarialRecord.report !== null &&
    reviewReportDigest(record.report as ReviewReport) ===
      attestation.primaryReportDigest &&
    reviewReportDigest(adversarialRecord.report as ReviewReport) ===
      attestation.adversarialReportDigest &&
    (attempts as Array<Record<string, unknown>>).every(
      (attempt, index) =>
        attempt.sessionId === attestation.reviewSessionIds[index]
    )
  );
}

async function hasMatchingReportArtifact(
  root: string,
  attestation: ReviewAttestation
): Promise<boolean> {
  const source = await readPrivateFile(
    artifactPath(root, attestation.sourceFingerprint),
    root
  );
  if (source === null) {
    return false;
  }
  try {
    return matchingReportArtifact(JSON.parse(source) as unknown, attestation);
  } catch {
    return false;
  }
}

export async function saveReviewReportArtifact(
  root: string,
  result: ReviewRunResult,
  sourceFingerprint: string,
  taskId?: string
): Promise<string> {
  if (!FINGERPRINT_PATTERN.test(sourceFingerprint)) {
    throw new AgentOpsError(
      "REVIEW_REPORT_ARTIFACT_INVALID",
      "Review report artifact has an invalid source fingerprint."
    );
  }
  if (taskId !== undefined && !TASK_ID_PATTERN.test(taskId)) {
    throw new AgentOpsError(
      "REVIEW_REPORT_ARTIFACT_INVALID",
      "Review report artifact has an invalid task id."
    );
  }
  const value = reportArtifact(result, sourceFingerprint, taskId);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > REPORT_ARTIFACT_MAX_BYTES) {
    throw new AgentOpsError(
      "REVIEW_REPORT_ARTIFACT_TOO_LARGE",
      "Review report artifact exceeds the capture limit."
    );
  }
  const relativePath =
    `${REVIEW_ATTESTATION_DIRECTORY}/${sourceFingerprint}${REVIEW_REPORT_ARTIFACT_SUFFIX}`;
  await writePrivateFile(artifactPath(root, sourceFingerprint), serialized, root);
  return relativePath;
}

function attestationPath(root: string, fingerprint: string): string {
  return join(
    root,
    ...REVIEW_ATTESTATION_DIRECTORY.split("/"),
    `${fingerprint}.json`
  );
}

function parseAttestation(value: unknown): ReviewAttestation | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 2 ||
    record.status !== "PASS" ||
    (record.taskId !== undefined &&
      (typeof record.taskId !== "string" ||
        !TASK_ID_PATTERN.test(record.taskId))) ||
    !isReviewTarget(record.harness) ||
    typeof record.sourceFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(record.sourceFingerprint) ||
    !Array.isArray(record.reviewTargets) ||
    record.reviewTargets.length !== 2 ||
    !record.reviewTargets.every(isReviewTarget) ||
    record.reviewTargets[0] !== record.harness ||
    !Array.isArray(record.reviewSessionIds) ||
    record.reviewSessionIds.length !== 2 ||
    !record.reviewSessionIds.every(
      (sessionId) => typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId)
    ) ||
    record.sessionIsolation !== "fresh" ||
    typeof record.primaryReportDigest !== "string" ||
    !DIGEST_PATTERN.test(record.primaryReportDigest) ||
    typeof record.adversarialReportDigest !== "string" ||
    !DIGEST_PATTERN.test(record.adversarialReportDigest) ||
    typeof record.reportArtifact !== "string" ||
    record.reportArtifact !==
      `${REVIEW_ATTESTATION_DIRECTORY}/${record.sourceFingerprint}${REVIEW_REPORT_ARTIFACT_SUFFIX}` ||
    (record.hostTarget !== undefined && !isReviewTarget(record.hostTarget)) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    return null;
  }
  return {
    schemaVersion: 2,
    ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
    harness: record.harness,
    status: "PASS",
    sourceFingerprint: record.sourceFingerprint,
    reviewTargets: [record.reviewTargets[0], record.reviewTargets[1]],
    reviewSessionIds: [record.reviewSessionIds[0], record.reviewSessionIds[1]],
    sessionIsolation: "fresh",
    primaryReportDigest: record.primaryReportDigest,
    adversarialReportDigest: record.adversarialReportDigest,
    reportArtifact: record.reportArtifact,
    ...(record.hostTarget === undefined ? {} : { hostTarget: record.hostTarget }),
    createdAt: record.createdAt
  };
}

export async function saveReviewAttestation(
  root: string,
  attestation: ReviewAttestation
): Promise<string> {
  const validated = parseAttestation(attestation);
  if (validated === null) {
    throw new AgentOpsError(
      "REVIEW_ATTESTATION_INVALID",
      "Review attestation is invalid."
    );
  }
  if (!(await hasMatchingReportArtifact(root, validated))) {
    throw new AgentOpsError(
      "REVIEW_ATTESTATION_INVALID",
      "Review attestation has no matching report artifact."
    );
  }
  const relativePath =
    `${REVIEW_ATTESTATION_DIRECTORY}/${validated.sourceFingerprint}.json`;
  await writePrivateFile(
    attestationPath(root, validated.sourceFingerprint),
    `${JSON.stringify(validated, null, 2)}\n`,
    root
  );
  return relativePath;
}

/**
 * Returns the attestation recorded for this exact source state, or null. A
 * malformed file reads as absent: a gate must fail closed on garbage, never
 * treat it as a passing review.
 */
export async function findReviewAttestation(
  root: string,
  sourceFingerprint: string
): Promise<ReviewAttestation | null> {
  if (!FINGERPRINT_PATTERN.test(sourceFingerprint)) {
    return null;
  }
  const source = await readPrivateFile(
    attestationPath(root, sourceFingerprint),
    root
  );
  if (source === null) {
    return null;
  }
  try {
    const attestation = parseAttestation(JSON.parse(source) as unknown);
    return attestation?.sourceFingerprint === sourceFingerprint &&
      await hasMatchingReportArtifact(root, attestation)
      ? attestation
      : null;
  } catch {
    return null;
  }
}

/**
 * The stored report behind an attestation, for a caller that wants to reuse
 * the recorded verdict rather than run the chain again. Returns null unless it
 * parses, matches this exact source and records a PASS: a reuse path must fail
 * closed exactly like the gates that read the attestation.
 */
export async function readReviewReportArtifact(
  root: string,
  sourceFingerprint: string
): Promise<ReviewReportArtifact | null> {
  if (!FINGERPRINT_PATTERN.test(sourceFingerprint)) {
    return null;
  }
  const source = await readPrivateFile(
    artifactPath(root, sourceFingerprint),
    root
  );
  if (source === null) {
    return null;
  }
  try {
    const value = JSON.parse(source) as ReviewReportArtifact;
    return value.sourceFingerprint === sourceFingerprint &&
      value.status === "PASS" &&
      value.report !== undefined &&
      value.adversarial !== undefined
      ? value
      : null;
  } catch {
    return null;
  }
}

/** A new authorized attempt supersedes any earlier PASS for this source. */
export async function invalidateReviewAttestation(
  root: string,
  sourceFingerprint: string
): Promise<void> {
  if (!FINGERPRINT_PATTERN.test(sourceFingerprint)) {
    throw new AgentOpsError("REVIEW_ATTESTATION_INVALID", "Invalid source fingerprint.");
  }
  const path = attestationPath(root, sourceFingerprint);
  if (await readPrivateFile(path, root) !== null) {
    await writePrivateFile(path, "null\n", root);
  }
}

/** Prior findings stay a short checklist, never a second report to digest. */
export const MAX_PRIOR_FINDINGS = 20;
export const MAX_PRIOR_FINDINGS_BYTES = 16 * 1024;

function blockingFindings(
  artifact: ReviewReportArtifact
): readonly PriorReviewFinding[] {
  // A refuted PASS failed on the adversarial report; otherwise the primary
  // report is the one that failed.
  const report = artifact.adversarial?.refuted === true
    ? artifact.adversarial.report
    : artifact.report;
  const findings: PriorReviewFinding[] = [];
  let bytes = 2;
  for (const finding of redactReviewReport(report!).findings) {
    if (!finding.blocking) {
      continue;
    }
    const prior: PriorReviewFinding = {
      severity: finding.severity,
      title: finding.title,
      details: finding.details,
      locations: finding.locations,
      criterionIds: finding.criterionIds
    };
    bytes += Buffer.byteLength(JSON.stringify(prior), "utf8") + 1;
    if (findings.length === MAX_PRIOR_FINDINGS || bytes > MAX_PRIOR_FINDINGS_BYTES) {
      break;
    }
    findings.push(prior);
  }
  return findings;
}

/**
 * Blocking findings of this task's most recent decided review, when that
 * review failed. NOT_RUN artifacts decide nothing and are skipped; a newer
 * PASS settles the earlier findings, so none are returned. Any unreadable
 * record is ignored: these are a hint for the next reviewer, and without them
 * the review simply runs as it always has.
 */
export async function findPriorFailingFindings(
  root: string,
  taskId: string
): Promise<readonly PriorReviewFinding[]> {
  const directory = join(root, ...REVIEW_ATTESTATION_DIRECTORY.split("/"));
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  // ponytail: linear scan of every report; index by task if the directory grows large.
  let latest: ReviewReportArtifact | undefined;
  for (const name of names) {
    const fingerprint = name.slice(0, -REVIEW_REPORT_ARTIFACT_SUFFIX.length);
    if (!name.endsWith(REVIEW_REPORT_ARTIFACT_SUFFIX) || !FINGERPRINT_PATTERN.test(fingerprint)) {
      continue;
    }
    try {
      const source = await readPrivateFile(artifactPath(root, fingerprint), root);
      if (source === null) {
        continue;
      }
      const value = JSON.parse(source) as ReviewReportArtifact;
      const decided = value.status === "PASS" ||
        (value.status === "FAIL" && value.report !== undefined);
      if (
        value?.schemaVersion !== 1 ||
        value.sourceFingerprint !== fingerprint ||
        value.taskId !== taskId ||
        !decided ||
        !Number.isFinite(Date.parse(value.createdAt))
      ) {
        continue;
      }
      if (latest === undefined || Date.parse(value.createdAt) > Date.parse(latest.createdAt)) {
        latest = value;
      }
    } catch {
      continue;
    }
  }
  if (latest?.status !== "FAIL") {
    return [];
  }
  try {
    return blockingFindings(latest);
  } catch {
    return [];
  }
}
