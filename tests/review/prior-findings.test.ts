import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  findPriorFailingFindings,
  MAX_PRIOR_FINDINGS,
  MAX_PRIOR_FINDINGS_BYTES,
  REVIEW_ATTESTATION_DIRECTORY
} from "../../runtime/src/review/attestation.js";
import type { ReviewFinding, ReviewReport } from "../../runtime/src/review/report.js";

const TASK = "task-prior";

function finding(title: string, blocking = true, details = "Still broken."): ReviewFinding {
  return {
    severity: "important",
    blocking,
    title,
    details,
    locations: [{ path: "src/a.ts", line: 3 }],
    evidence: ["src/a.ts#L3"],
    recommendation: "Fix it.",
    criterionIds: ["tests"]
  };
}

function report(findings: readonly ReviewFinding[]): ReviewReport {
  return {
    summary: "Reviewed.",
    results: [{ criterionId: "tests", status: findings.length > 0 ? "FAIL" : "PASS", summary: "Reviewed.", evidence: ["x"] }],
    findings,
    residualRisks: [],
    changedFilesInspected: ["src/a.ts"],
    supportingFilesInspected: []
  };
}

let sequence = 0;

/** Writes a report artifact by hand so createdAt and content are exact. */
async function artifact(
  root: string,
  value: {
    readonly status: "PASS" | "FAIL" | "NOT_RUN";
    readonly createdAt: string;
    readonly taskId?: string;
    readonly primary?: ReviewReport;
    readonly adversarial?: { readonly refuted: boolean; readonly report: ReviewReport };
  }
): Promise<void> {
  const fingerprint = (++sequence).toString(16).padStart(64, "0");
  const directory = join(root, ...REVIEW_ATTESTATION_DIRECTORY.split("/"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, `${fingerprint}.reports.json`),
    JSON.stringify({
      schemaVersion: 1,
      sourceFingerprint: fingerprint,
      taskId: value.taskId ?? TASK,
      status: value.status,
      harness: "agy",
      plannedTargets: ["agy", "agy"],
      attempts: [],
      preflight: [],
      ...(value.primary === undefined ? {} : { report: value.primary }),
      ...(value.adversarial === undefined
        ? {}
        : { adversarial: { target: "agy", ...value.adversarial } }),
      createdAt: value.createdAt
    }),
    { mode: 0o600 }
  );
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-prior-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("no review directory yields no prior findings", async () => {
  await withRoot(async (root) => {
    assert.deepEqual(await findPriorFailingFindings(root, TASK), []);
  });
});

test("a refuted PASS hands over the adversarial round's blocking findings only", async () => {
  await withRoot(async (root) => {
    await artifact(root, {
      status: "FAIL",
      createdAt: "2026-09-01T00:00:00.000Z",
      primary: report([]),
      adversarial: {
        refuted: true,
        report: report([finding("Deadline bypassed"), finding("Style nit", false)])
      }
    });
    assert.deepEqual(await findPriorFailingFindings(root, TASK), [{
      severity: "important",
      title: "Deadline bypassed",
      details: "Still broken.",
      locations: [{ path: "src/a.ts", line: 3 }],
      criterionIds: ["tests"]
    }]);
  });
});

test("a primary FAIL hands over the primary report's findings, redacted", async () => {
  await withRoot(async (root) => {
    await artifact(root, {
      status: "FAIL",
      createdAt: "2026-09-01T00:00:00.000Z",
      primary: report([finding("Leak", true, `token=${"ghp_" + "a".repeat(30)}`)])
    });
    const [prior] = await findPriorFailingFindings(root, TASK);
    assert.equal(prior?.title, "Leak");
    assert.doesNotMatch(prior?.details ?? "", /ghp_a{30}/u);
  });
});

test("a newer PASS settles earlier findings; NOT_RUN decides nothing", async () => {
  await withRoot(async (root) => {
    await artifact(root, {
      status: "FAIL",
      createdAt: "2026-09-01T00:00:00.000Z",
      primary: report([finding("Old defect")])
    });
    await artifact(root, { status: "NOT_RUN", createdAt: "2026-09-02T00:00:00.000Z" });
    assert.deepEqual(
      (await findPriorFailingFindings(root, TASK)).map((item) => item.title),
      ["Old defect"]
    );
    await artifact(root, {
      status: "PASS",
      createdAt: "2026-09-03T00:00:00.000Z",
      primary: report([]),
      adversarial: { refuted: false, report: report([]) }
    });
    assert.deepEqual(await findPriorFailingFindings(root, TASK), []);
  });
});

test("another task's failure and unreadable records are ignored", async () => {
  await withRoot(async (root) => {
    await artifact(root, {
      status: "FAIL",
      taskId: "task-other",
      createdAt: "2026-09-05T00:00:00.000Z",
      primary: report([finding("Not ours")])
    });
    const directory = join(root, ...REVIEW_ATTESTATION_DIRECTORY.split("/"));
    await writeFile(join(directory, `${"f".repeat(64)}.reports.json`), "{ not json", { mode: 0o600 });
    assert.deepEqual(await findPriorFailingFindings(root, TASK), []);
    await artifact(root, {
      status: "FAIL",
      createdAt: "2026-09-01T00:00:00.000Z",
      primary: report([finding("Ours")])
    });
    assert.deepEqual(
      (await findPriorFailingFindings(root, TASK)).map((item) => item.title),
      ["Ours"]
    );
  });
});

test("prior findings are capped in count and in bytes", async () => {
  await withRoot(async (root) => {
    await artifact(root, {
      status: "FAIL",
      createdAt: "2026-09-01T00:00:00.000Z",
      primary: report(Array.from({ length: MAX_PRIOR_FINDINGS + 5 }, (_, index) => finding(`Defect ${index}`)))
    });
    assert.equal((await findPriorFailingFindings(root, TASK)).length, MAX_PRIOR_FINDINGS);
  });
  await withRoot(async (root) => {
    await artifact(root, {
      status: "FAIL",
      createdAt: "2026-09-01T00:00:00.000Z",
      primary: report(Array.from({ length: 10 }, (_, index) => finding(`Big ${index}`, true, "x".repeat(4000))))
    });
    const prior = await findPriorFailingFindings(root, TASK);
    assert.ok(prior.length > 0 && prior.length < 10, `kept ${prior.length}`);
    assert.ok(Buffer.byteLength(JSON.stringify(prior), "utf8") <= MAX_PRIOR_FINDINGS_BYTES);
  });
});
