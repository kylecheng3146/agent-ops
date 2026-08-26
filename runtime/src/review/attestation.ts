import { join } from "node:path";

import { AgentOpsError } from "../fs/paths.js";
import {
  readPrivateFile,
  writePrivateFile
} from "../security/permissions.js";

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const TASK_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

export const REVIEW_ATTESTATION_DIRECTORY = ".agent-ops/reviews";

/**
 * A durable record that one independent review passed against exactly one
 * source state. The source fingerprint is the key: any later edit produces a
 * different fingerprint, so a stale attestation can never satisfy a gate.
 */
export interface ReviewAttestation {
  readonly schemaVersion: 1;
  readonly taskId?: string;
  readonly harness: string;
  readonly status: "PASS";
  readonly sourceFingerprint: string;
  readonly createdAt: string;
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
    record.schemaVersion !== 1 ||
    record.status !== "PASS" ||
    (record.taskId !== undefined &&
      (typeof record.taskId !== "string" ||
        !TASK_ID_PATTERN.test(record.taskId))) ||
    typeof record.harness !== "string" ||
    !TASK_ID_PATTERN.test(record.harness) ||
    typeof record.sourceFingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(record.sourceFingerprint) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    ...(record.taskId === undefined ? {} : { taskId: record.taskId }),
    harness: record.harness,
    status: "PASS",
    sourceFingerprint: record.sourceFingerprint,
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
    return parseAttestation(JSON.parse(source) as unknown);
  } catch {
    return null;
  }
}
