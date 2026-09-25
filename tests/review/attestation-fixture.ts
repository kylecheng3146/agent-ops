import {
  reviewReportDigest,
  saveReviewAttestation,
  saveReviewReportArtifact,
  type ReviewAttestation
} from "../../runtime/src/review/attestation.js";
import type { ReviewReport } from "../../runtime/src/review/report.js";
import type { ReviewRunResult } from "../../runtime/src/review/runner.js";
import type { ReviewTargetId } from "../../runtime/src/contracts.js";

const report = (summary: string): ReviewReport => ({
  summary,
  results: [{
    criterionId: "change-quality",
    status: "PASS",
    summary,
    evidence: ["fixture evidence"]
  }],
  findings: [],
  residualRisks: ["fixture risk"],
  changedFilesInspected: ["changed.ts"],
  supportingFilesInspected: ["README.md"]
});

export function fixtureReviewResult(
  sourceFingerprint: string,
  targets: readonly [ReviewTargetId, ReviewTargetId] = ["codex", "agy"]
): ReviewRunResult {
  const primary = report("primary fixture review passed");
  const adversarial = report("adversarial fixture review passed");
  return {
    status: "PASS",
    harness: targets[0],
    model: "fixture",
    effort: "fixture",
    prompt: "fixture",
    plannedTargets: targets,
    sourceFingerprint,
    sessionIsolation: "fresh",
    attempts: [
      { target: targets[0], status: "PASS", sessionId: "fixture-primary" },
      { target: targets[1], status: "PASS", sessionId: "fixture-adversarial" }
    ],
    preflight: [],
    report: primary,
    adversarial: {
      target: targets[1],
      refuted: false,
      report: adversarial
    }
  };
}

export function fixtureAttestation(
  sourceFingerprint: string,
  taskId?: string,
  targets: readonly [ReviewTargetId, ReviewTargetId] = ["codex", "agy"]
): ReviewAttestation {
  const result = fixtureReviewResult(sourceFingerprint, targets);
  return {
    schemaVersion: 2,
    ...(taskId === undefined ? {} : { taskId }),
    harness: result.harness,
    status: "PASS",
    sourceFingerprint,
    reviewTargets: targets,
    reviewSessionIds: [result.attempts![0]!.sessionId!, result.attempts![1]!.sessionId!],
    sessionIsolation: "fresh",
    primaryReportDigest: reviewReportDigest(result.report!),
    adversarialReportDigest: reviewReportDigest(result.adversarial!.report),
    reportArtifact: `.agent-ops/reviews/${sourceFingerprint}${taskId === undefined ? "" : `.${taskId}`}.reports.json`,
    createdAt: "2026-08-01T00:00:00.000Z"
  };
}

export async function saveFixtureReviewAttestation(
  root: string,
  sourceFingerprint: string,
  taskId?: string,
  targets: readonly [ReviewTargetId, ReviewTargetId] = ["codex", "agy"]
): Promise<ReviewAttestation> {
  const result = fixtureReviewResult(sourceFingerprint, targets);
  await saveReviewReportArtifact(root, result, sourceFingerprint, taskId);
  const value = fixtureAttestation(sourceFingerprint, taskId, targets);
  await saveReviewAttestation(root, value);
  return value;
}
