import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  findReviewAttestation,
  saveReviewAttestation,
  REVIEW_ATTESTATION_DIRECTORY
} from "../../runtime/src/review/attestation.js";

const FINGERPRINT = "b".repeat(64);

function attestation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    taskId: "task-1234",
    harness: "codex",
    status: "PASS",
    sourceFingerprint: FINGERPRINT,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides
  } as Parameters<typeof saveReviewAttestation>[1];
}

async function root(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agent-ops-attestation-"));
}

test("stores a passing review keyed by its source fingerprint", async () => {
  const directory = await root();
  const reference = await saveReviewAttestation(directory, attestation());
  assert.equal(reference, `${REVIEW_ATTESTATION_DIRECTORY}/${FINGERPRINT}.json`);
  assert.deepEqual(
    await findReviewAttestation(directory, FINGERPRINT),
    attestation()
  );
});

test("stores a generic review without inventing a task id", async () => {
  const directory = await root();
  const { taskId: _taskId, ...generic } = attestation();
  await saveReviewAttestation(directory, generic);
  assert.deepEqual(
    await findReviewAttestation(directory, FINGERPRINT),
    generic
  );
});

test("reports no attestation for a different source state", async () => {
  const directory = await root();
  await saveReviewAttestation(directory, attestation());
  assert.equal(await findReviewAttestation(directory, "c".repeat(64)), null);
  assert.equal(await findReviewAttestation(directory, "not-a-hash"), null);
});

test("rejects an invalid attestation and reads a corrupt one as absent", async () => {
  const directory = await root();
  await assert.rejects(
    saveReviewAttestation(directory, attestation({ status: "FAIL" })),
    (error: unknown) =>
      (error as { readonly code?: string }).code === "REVIEW_ATTESTATION_INVALID"
  );
  await mkdir(join(directory, ...REVIEW_ATTESTATION_DIRECTORY.split("/")), {
    recursive: true,
    mode: 0o700
  });
  const path = join(
    directory,
    ...REVIEW_ATTESTATION_DIRECTORY.split("/"),
    `${FINGERPRINT}.json`
  );
  await writeFile(path, "{ not json", { mode: 0o600 });
  assert.equal(await findReviewAttestation(directory, FINGERPRINT), null);
  await writeFile(path, JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  assert.equal(await findReviewAttestation(directory, FINGERPRINT), null);
  assert.match(await readFile(path, "utf8"), /schemaVersion/u);
});
