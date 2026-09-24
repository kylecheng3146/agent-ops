import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  findReviewAttestation,
  invalidateReviewAttestation,
  saveReviewAttestation,
  saveReviewReportArtifact,
  REVIEW_ATTESTATION_DIRECTORY
} from "../../runtime/src/review/attestation.js";
import {
  fixtureAttestation,
  fixtureReviewResult
} from "./attestation-fixture.js";

const FINGERPRINT = "b".repeat(64);

function attestation(overrides: Record<string, unknown> = {}) {
  return {
    ...fixtureAttestation(FINGERPRINT, "task-1234"),
    ...overrides
  } as Parameters<typeof saveReviewAttestation>[1];
}

async function saveValidAttestation(
  directory: string,
  value: Parameters<typeof saveReviewAttestation>[1]
): Promise<void> {
  await saveReviewReportArtifact(
    directory,
    fixtureReviewResult(value.sourceFingerprint),
    value.sourceFingerprint,
    value.taskId
  );
  await saveReviewAttestation(directory, value);
}

async function root(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "agent-ops-attestation-"));
}

test("stores a passing review keyed by its source fingerprint", async () => {
  const directory = await root();
  const value = attestation();
  await saveValidAttestation(directory, value);
  const reference = `${REVIEW_ATTESTATION_DIRECTORY}/${FINGERPRINT}.json`;
  assert.equal(reference, `${REVIEW_ATTESTATION_DIRECTORY}/${FINGERPRINT}.json`);
  assert.deepEqual(
    await findReviewAttestation(directory, FINGERPRINT),
    value
  );
});

test("stores a generic review without inventing a task id", async () => {
  const directory = await root();
  const { taskId: _taskId, ...generic } = fixtureAttestation(FINGERPRINT);
  await saveValidAttestation(directory, generic);
  assert.deepEqual(
    await findReviewAttestation(directory, FINGERPRINT),
    generic
  );
});

test("reports no attestation for a different source state", async () => {
  const directory = await root();
  await saveValidAttestation(directory, attestation());
  assert.equal(await findReviewAttestation(directory, "c".repeat(64)), null);
  assert.equal(await findReviewAttestation(directory, "not-a-hash"), null);
  await writeFile(join(directory, REVIEW_ATTESTATION_DIRECTORY, `${"c".repeat(64)}.json`),
    JSON.stringify(attestation()), { mode: 0o600 });
  assert.equal(await findReviewAttestation(directory, "c".repeat(64)), null);
  await invalidateReviewAttestation(directory, FINGERPRINT, "task-1234");
  assert.equal(await findReviewAttestation(directory, FINGERPRINT), null);
});

test("each task keeps its own review of the same source", async () => {
  const directory = await root();
  await saveValidAttestation(directory, fixtureAttestation(FINGERPRINT, "task-parent"));
  await saveValidAttestation(directory, fixtureAttestation(FINGERPRINT, "task-child"));
  assert.equal((await findReviewAttestation(directory, FINGERPRINT, "task-parent"))?.taskId, "task-parent");
  assert.equal((await findReviewAttestation(directory, FINGERPRINT, "task-child"))?.taskId, "task-child");
  assert.equal(await findReviewAttestation(directory, FINGERPRINT, "task-other"), null);

  // A new attempt for one task leaves the other's PASS standing.
  await invalidateReviewAttestation(directory, FINGERPRINT, "task-child");
  assert.equal(await findReviewAttestation(directory, FINGERPRINT, "task-child"), null);
  assert.equal((await findReviewAttestation(directory, FINGERPRINT, "task-parent"))?.taskId, "task-parent");
});

test("a bare record written before per-task records still reads", async () => {
  const directory = await root();
  const legacy = attestation({
    reportArtifact: `${REVIEW_ATTESTATION_DIRECTORY}/${FINGERPRINT}.reports.json`
  });
  await saveReviewReportArtifact(directory, fixtureReviewResult(FINGERPRINT), FINGERPRINT, "task-1234");
  // Move the per-task artifact to the bare name an older review used.
  await writeFile(
    join(directory, REVIEW_ATTESTATION_DIRECTORY, `${FINGERPRINT}.reports.json`),
    await readFile(join(directory, REVIEW_ATTESTATION_DIRECTORY, `${FINGERPRINT}.task-1234.reports.json`), "utf8"),
    { mode: 0o600 }
  );
  await rm(join(directory, REVIEW_ATTESTATION_DIRECTORY, `${FINGERPRINT}.task-1234.reports.json`));
  await writeFile(join(directory, REVIEW_ATTESTATION_DIRECTORY, `${FINGERPRINT}.json`),
    JSON.stringify(legacy), { mode: 0o600 });
  assert.equal((await findReviewAttestation(directory, FINGERPRINT, "task-1234"))?.taskId, "task-1234");
  assert.equal((await findReviewAttestation(directory, FINGERPRINT))?.taskId, "task-1234");

  // Another task's new attempt leaves this task's bare record alone.
  await invalidateReviewAttestation(directory, FINGERPRINT, "task-other");
  assert.equal((await findReviewAttestation(directory, FINGERPRINT, "task-1234"))?.taskId, "task-1234");
  await invalidateReviewAttestation(directory, FINGERPRINT, "task-1234");
  assert.equal(await findReviewAttestation(directory, FINGERPRINT, "task-1234"), null);
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
