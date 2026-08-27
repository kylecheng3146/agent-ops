import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { runReviewCommand } from "../../packages/cli/src/commands/review.js";
import type { ReviewExecutionRequest } from "../../runtime/src/review/runner.js";
import { reportFor } from "../review/report-fixture.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import type { GitRunner } from "../../runtime/src/verify/change-surface.js";
import { calculateSourceFingerprint } from "../../runtime/src/verify/source-fingerprint.js";
import { buildVerificationEvidence, calculateConfigHash, FileEvidenceStore } from "../../runtime/src/verify/evidence.js";
import { validateEvidence } from "../../runtime/src/schema/validate.js";
import { findReviewAttestation } from "../../runtime/src/review/attestation.js";

const REVIEW_CONFIG: AgentOpsConfig = {
  schemaVersion: 2,
  profiles: ["core"],
  verification: { commands: [
    { id: "unit", command: "node", args: ["--test"], cwd: ".", required: true, evidence: { kind: "exit-code" } },
    { id: "optional", command: "node", args: ["--check"], cwd: ".", required: false, evidence: { kind: "exit-code" } }
  ] },
  features: { stopVerification: { enabled: false } },
  pathMappings: [],
  securityExceptions: []
};

function reviewGitRunner(): GitRunner {
  return {
    run: async (args) => ({
      exitCode: 0,
      stdout: args[0] === "rev-parse"
        ? Buffer.from(`${"a".repeat(40)}\n`)
        : args[0] === "diff" && args[1] === "--cached"
          ? Buffer.from("src/reviewed.ts\0")
          : new Uint8Array()
    })
  };
}

const SESSION = "session-review";

function service(root: string): TaskService {
  let sequence = 0;
  return new TaskService(
    new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root),
    {
      generateId: () => `task-${++sequence}`,
      now: () => "2026-08-12T03:00:00.000Z"
    }
  );
}

async function withTask(
  attach: boolean
): Promise<{ readonly root: string; readonly tasks: TaskService }> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-review-"));
  const tasks = service(root);
  const record = await tasks.create({
    title: "Ship the reviewer",
    criteria: [
      {
        id: "tests",
        description: "The test suite passes.",
        verifierIds: ["unit"]
      },
      {
        id: "scope",
        description: "No unrelated files changed.",
        verifierIds: ["diff"]
      }
    ]
  });
  if (attach) {
    await tasks.attach(SESSION, record.task.id);
  }
  return { root, tasks };
}

function passing(request: ReviewExecutionRequest) {
  return {
    status: "PASS" as const,
    results: request.invocation.packet.criteria.map((criterion) => ({
      criterionId: criterion.id,
      status: "PASS" as const,
      evidence: [`inspected ${criterion.id}`]
    })),
    report: reportFor(request.invocation.packet.criteria)
  };
}

test("criterion descriptions and verifiers come from the bound task", async () => {
  const { root, tasks } = await withTask(true);
  try {
    let seen: ReviewExecutionRequest | undefined;
    const envelope = await runReviewCommand({
      args: parseArgs(["review", "--yes"]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      execute: async (request) => {
        seen = request;
        return passing(request);
      }
    });
    assert.equal(envelope.status, "ok");
    assert.deepEqual(
      seen?.invocation.packet.criteria.map((criterion) => criterion.description),
      ["The test suite passes.", "No unrelated files changed."]
    );
    assert.deepEqual(seen?.invocation.packet.criteria[0]?.verifierIds, ["unit"]);
    assert.match(envelope.data?.result.prompt ?? "", /The test suite passes\./);
    assert.match(envelope.data?.result.prompt ?? "", /BEGIN_TASK_DATA/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--criterion filters the bound task and rejects unknown ids", async () => {
  const { root, tasks } = await withTask(true);
  try {
    const filtered = await runReviewCommand({
      args: parseArgs([
        "review", "--task", "task-1", "--yes", "--criterion", "scope"
      ]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      execute: async (request) => passing(request)
    });
    assert.equal(filtered.status, "ok");
    assert.deepEqual(
      filtered.data?.result.results?.map((item) => item.criterionId),
      ["scope"]
    );

    await assert.rejects(
      runReviewCommand({
        args: parseArgs([
          "review", "--task", "task-1", "--yes", "--criterion", "nope"
        ]),
        authorized: true,
        tasks,
        sessionId: SESSION,
        execute: async (request) => passing(request)
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "REVIEW_CRITERIA_NOT_FOUND"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unattached session falls back to the generic change review", async () => {
  const { root, tasks } = await withTask(false);
  try {
    let calls = 0;
    const envelope = await runReviewCommand({
      args: parseArgs(["review", "--yes"]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      execute: async (request) => {
        calls += 1;
        return passing(request);
      }
    });
    assert.equal(envelope.status, "ok");
    assert.equal(envelope.data?.result.status, "PASS");
    assert.equal(calls, 1);
    assert.deepEqual(
      envelope.data?.result.results?.map(({ criterionId }) => criterionId),
      ["change-quality"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generic PASS writes a source-bound attestation without a task id", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-review-"));
  const gitRunner = reviewGitRunner();
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "reviewed.ts"), "export {};\n");
    const envelope = await runReviewCommand({
      args: parseArgs(["review", "--yes"]),
      authorized: true,
      root,
      gitRunner,
      execute: async (request) => ({
        ...passing(request),
        report: reportFor(
          request.invocation.packet.criteria,
          "PASS",
          ["src/reviewed.ts"]
        )
      })
    });
    assert.equal(envelope.status, "ok");
    const scope = envelope.data?.result.scope;
    assert.ok(scope);
    const fingerprint = await calculateSourceFingerprint(root, scope, gitRunner);
    const stored = await findReviewAttestation(root, fingerprint);
    assert.equal(stored?.taskId, undefined);
    assert.equal(stored?.status, "PASS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an explicit missing task remains a task error", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-review-"));
  try {
    await assert.rejects(
      runReviewCommand({
        args: parseArgs(["review", "--task", "missing", "--yes"]),
        authorized: true,
        tasks: service(root),
        taskId: "missing",
        execute: async (request) => passing(request)
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TASK_NOT_FOUND"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence for an active task is prefixed with the review target", async () => {
  const { root, tasks } = await withTask(true);
  try {
    await runReviewCommand({
      args: parseArgs(["review", "--yes"]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      execute: async (request) => passing(request)
    });
    const record = await tasks.status({ sessionId: SESSION });
    assert.deepEqual(Object.keys(record.evidence).sort(), ["scope", "tests"]);
    for (const references of Object.values(record.evidence)) {
      for (const reference of references) {
        assert.match(reference, /^review:codex:/);
      }
    }
    assert.equal(record.status, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a completed task is printed but never written to", async () => {
  const { root, tasks } = await withTask(true);
  try {
    const record = await tasks.status({ sessionId: SESSION });
    const completed = await tasks.complete(record.task.id, {
      tests: ["npm test"],
      scope: ["git diff"]
    });
    const envelope = await runReviewCommand({
      args: parseArgs(["review", "--yes"]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      taskId: completed.task.id,
      execute: async (request) => passing(request)
    });
    assert.equal(envelope.status, "ok");
    const after = await tasks.status({ taskId: completed.task.id });
    assert.deepEqual(after.evidence, completed.evidence);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("without --yes nothing is spawned and no evidence is written", async () => {
  const { root, tasks } = await withTask(true);
  try {
    let calls = 0;
    const envelope = await runReviewCommand({
      args: parseArgs(["review"]),
      authorized: false,
      tasks,
      sessionId: SESSION,
      execute: async (request) => {
        calls += 1;
        return passing(request);
      }
    });
    assert.equal(envelope.data?.result.reason, "authorization-required");
    assert.equal(calls, 0);
    const record = await tasks.status({ sessionId: SESSION });
    assert.deepEqual(record.evidence, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-auth not-run review does not point the operator at auth diagnostics", async () => {
  const { root, tasks } = await withTask(true);
  try {
    const envelope = await runReviewCommand({
      args: parseArgs(["review", "--yes"]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      execute: async () => ({
        status: "NOT_RUN",
        reason: "missing-cli" as const
      })
    });
    assert.equal(envelope.status, "error");
    assert.doesNotMatch(envelope.data?.text ?? "", /agent-ops doctor --check-auth/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review requires current PASS evidence before it spawns", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-review-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "reviewed.ts"), "export {}\n");
    const tasks = service(root);
    const record = await tasks.create({
      title: "Review verified source",
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG),
      criteria: [
        { id: "unit", description: "Unit tests pass.", verifierIds: ["unit"] },
        { id: "scope", description: "Review scope is exact.", verifierIds: ["unit", "optional"] }
      ]
    });
    await tasks.attach(SESSION, record.task.id);
    const gitRunner = reviewGitRunner();
    const scope = { mode: "worktree" as const, changedFiles: ["src/reviewed.ts"] };
    const evidenceStore = new FileEvidenceStore(root, root);
    const fingerprint = await calculateSourceFingerprint(root, scope, gitRunner);
    const reference = await evidenceStore.save(buildVerificationEvidence({
      taskId: record.task.id,
      criterionId: "unit",
      command: REVIEW_CONFIG.verification.commands[0]!,
      scope: "project",
      startedAt: "2026-08-12T03:00:00.000Z",
      finishedAt: "2026-08-12T03:00:01.000Z",
      exitCode: 0,
      testCount: null,
      status: "PASS",
      failureClass: "none",
      sourceFingerprint: fingerprint,
      toolVersions: {},
      config: REVIEW_CONFIG
    }));
    const scopeReference = await evidenceStore.save(buildVerificationEvidence({
      taskId: record.task.id,
      criterionId: "scope",
      command: REVIEW_CONFIG.verification.commands[0]!,
      scope: "project",
      startedAt: "2026-08-12T03:00:00.000Z",
      finishedAt: "2026-08-12T03:00:01.000Z",
      exitCode: 0,
      testCount: null,
      status: "PASS",
      failureClass: "none",
      sourceFingerprint: fingerprint,
      toolVersions: {},
      config: REVIEW_CONFIG
    }));
    const optionalReference = await evidenceStore.save(buildVerificationEvidence({
      taskId: record.task.id,
      criterionId: "scope",
      command: REVIEW_CONFIG.verification.commands[1]!,
      scope: "project",
      startedAt: "2026-08-12T03:00:00.000Z",
      finishedAt: "2026-08-12T03:00:02.000Z",
      exitCode: 1,
      testCount: null,
      status: "FAIL",
      failureClass: "nonzero-exit",
      sourceFingerprint: fingerprint,
      toolVersions: {},
      config: REVIEW_CONFIG
    }));
    await tasks.recordEvidence(record.task.id, {
      unit: [reference],
      scope: [scopeReference, optionalReference]
    });
    const loaded = validateEvidence(await evidenceStore.load(reference));
    assert.equal(loaded.ok, true);
    let calls = 0;
    const passed = await runReviewCommand({
      args: parseArgs(["review", "--yes"]), authorized: true, tasks,
      sessionId: SESSION, root, gitRunner, config: REVIEW_CONFIG,
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG), evidenceStore,
      execute: async (request) => {
        calls += 1;
        return {
          status: "PASS" as const,
          results: [],
          report: reportFor(request.invocation.packet.criteria, "PASS", ["src/reviewed.ts"])
        };
      }
    });
    assert.equal(passed.status, "ok", passed.data?.result.reason ?? "missing reason");
    assert.equal(calls, 1);
    assert.deepEqual(passed.data?.result.verification?.commands, [
      { criterionId: "unit", commandId: "unit", required: true, status: "PASS", evidenceReference: reference },
      { criterionId: "scope", commandId: "unit", required: true, status: "PASS", evidenceReference: scopeReference },
      { criterionId: "scope", commandId: "optional", required: false, status: "FAIL", evidenceReference: optionalReference }
    ]);

    const unsafeSupportingPath = await runReviewCommand({
      args: parseArgs(["review", "--yes"]), authorized: true, tasks,
      sessionId: SESSION, root, gitRunner, config: REVIEW_CONFIG,
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG), evidenceStore,
      execute: async (request) => ({
        status: "PASS" as const,
        results: [],
        report: {
          ...reportFor(request.invocation.packet.criteria, "PASS", ["src/reviewed.ts"]),
          supportingFilesInspected: ["missing-supporting.ts"]
        }
      })
    });
    assert.equal(unsafeSupportingPath.data?.result.reason, "unsafe-review-path");

    const unsafeAdversarialSupportingPath = await runReviewCommand({
      args: parseArgs(["review", "--yes"]), authorized: true, tasks,
      sessionId: SESSION, root, gitRunner, config: REVIEW_CONFIG,
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG), evidenceStore,
      execute: async (request) => {
        const report = reportFor(request.invocation.packet.criteria, "PASS", ["src/reviewed.ts"]);
        return {
          status: "PASS" as const,
          results: [],
          report,
          adversarial: {
            target: "agy" as const,
            refuted: false,
            report: { ...report, supportingFilesInspected: ["missing-supporting.ts"] }
          }
        };
      }
    });
    assert.equal(unsafeAdversarialSupportingPath.data?.result.reason, "unsafe-review-path");

    const referencesBeforeSourceChange = await tasks.status({ sessionId: SESSION });
    const sourceChanged = await runReviewCommand({
      args: parseArgs(["review", "--yes"]), authorized: true, tasks,
      sessionId: SESSION, root, gitRunner, config: REVIEW_CONFIG,
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG), evidenceStore,
      execute: async (request) => {
        calls += 1;
        await writeFile(join(root, "src", "reviewed.ts"), "export const changed = true\n");
        return {
          status: "PASS" as const,
          results: [],
          report: reportFor(request.invocation.packet.criteria, "PASS", ["src/reviewed.ts"])
        };
      }
    });
    assert.equal(sourceChanged.data?.result.reason, "source-changed-during-review");
    assert.equal(sourceChanged.data?.result.report, undefined);
    assert.deepEqual(
      (await tasks.status({ sessionId: SESSION })).evidence,
      referencesBeforeSourceChange.evidence
    );
    await writeFile(join(root, "src", "reviewed.ts"), "export {}\n");

    const contradictoryReference = await evidenceStore.save(buildVerificationEvidence({
      taskId: record.task.id,
      criterionId: "unit",
      command: REVIEW_CONFIG.verification.commands[0]!,
      scope: "project",
      startedAt: "2026-08-12T03:00:03.000Z",
      finishedAt: "2026-08-12T03:00:03.000Z",
      exitCode: 1,
      testCount: null,
      status: "PASS",
      failureClass: "nonzero-exit",
      sourceFingerprint: fingerprint,
      toolVersions: {},
      config: REVIEW_CONFIG
    }));
    await tasks.recordEvidence(record.task.id, { unit: [contradictoryReference] });
    const contradictory = await runReviewCommand({
      args: parseArgs(["review", "--yes"]), authorized: true, tasks,
      sessionId: SESSION, root, gitRunner, config: REVIEW_CONFIG,
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG), evidenceStore,
      execute: async () => {
        calls += 1;
        return { status: "NOT_RUN" as const, reason: "missing-cli" as const };
      }
    });
    assert.equal(contradictory.data?.result.reason, "verification-not-passed");
    assert.equal(calls, 2);

    const stale = await runReviewCommand({
      args: parseArgs(["review", "--yes"]), authorized: true, tasks,
      sessionId: SESSION, root, gitRunner, config: { ...REVIEW_CONFIG, profiles: ["loop"] },
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG), evidenceStore,
      execute: async () => {
        calls += 1;
        return { status: "NOT_RUN" as const, reason: "missing-cli" as const };
      }
    });
    assert.equal(stale.data?.result.reason, "stale-verification");
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
