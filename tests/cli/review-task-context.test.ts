import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliArgumentError, parseArgs } from "../../packages/cli/src/args.js";
import { runReviewCommand } from "../../packages/cli/src/commands/review.js";
import type { ReviewExecutionRequest } from "../../runtime/src/review/runner.js";
import { runIndependentReview } from "../../runtime/src/review/runner.js";
import { reportFor } from "../review/report-fixture.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import type { GitRunner } from "../../runtime/src/verify/change-surface.js";
import { calculateSourceFingerprint } from "../../runtime/src/verify/source-fingerprint.js";
import { buildVerificationEvidence, calculateConfigHash, FileEvidenceStore } from "../../runtime/src/verify/evidence.js";
import { validateEvidence } from "../../runtime/src/schema/validate.js";
import { findReviewAttestation, saveReviewReportArtifact } from "../../runtime/src/review/attestation.js";
import { createFailureFingerprint } from "../../runtime/src/verify/fingerprint.js";

const REVIEW_CONFIG: AgentOpsConfig = {
  schemaVersion: 3,
  profiles: ["core"],
  verification: { commands: [
    { id: "unit", command: "node", args: ["--test"], cwd: ".", required: true, evidence: { kind: "exit-code" } },
    { id: "optional", command: "node", args: ["--check"], cwd: ".", required: false, evidence: { kind: "exit-code" } }
  ] },
  features: {
    completionGate: { enabled: false },
    stopVerification: { enabled: false }
  },
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
): Promise<{
  readonly root: string;
  readonly tasks: TaskService;
  readonly taskId: string;
}> {
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
  return { root, tasks, taskId: record.task.id };
}

function completePassing(
  request: ReviewExecutionRequest,
  changedFiles: readonly string[] = []
) {
  const plannedTargets = request.invocation.plannedTargets ?? [
    request.invocation.harness,
    request.invocation.harness
  ];
  const primary = reportFor(
    request.invocation.packet.criteria,
    "PASS",
    changedFiles
  );
  return {
    status: "PASS" as const,
    results: request.invocation.packet.criteria.map((criterion) => ({
      criterionId: criterion.id,
      status: "PASS" as const,
      evidence: [`inspected ${criterion.id}`]
    })),
    report: primary,
    plannedTargets,
    sessionIsolation: "fresh" as const,
    attempts: plannedTargets.map((target, index) => ({
      target,
      status: "PASS" as const,
      sessionId: index === 0 ? "test-primary" : "test-adversarial"
    })),
    adversarial: {
      target: plannedTargets[1]!,
      refuted: false,
      report: primary
    }
  };
}

function passing(request: ReviewExecutionRequest) {
  return completePassing(request);
}

function reviewArgs(taskId: string, ...extra: string[]): ReturnType<typeof parseArgs> {
  return {
    ...parseArgs(["review", "--task", taskId, "--yes", ...extra])
  };
}

test("criterion descriptions and verifiers come from the bound task", async () => {
  const { root, tasks, taskId } = await withTask(true);
  try {
    let seen: ReviewExecutionRequest | undefined;
    const envelope = await runReviewCommand({
      args: reviewArgs(taskId),
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

test("complete review rejects criterion filters", () => {
  assert.throws(
    () => parseArgs(["review", "--task", "task-1", "--yes", "--criterion", "scope"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CLI_OPTION_NOT_ALLOWED"
  );
});

test("review always requires an explicit task", () => {
  assert.throws(
    () => parseArgs(["review", "--yes"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CLI_OPTION_NOT_ALLOWED"
  );
});

test("a review cannot write a source attestation without a task", () => {
  assert.throws(() => parseArgs(["review", "--yes"]), CliArgumentError);
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
  const { root, tasks, taskId } = await withTask(true);
  try {
    await runReviewCommand({
      args: reviewArgs(taskId),
      targets: ["codex"],
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
  const { root, tasks, taskId } = await withTask(true);
  try {
    const record = await tasks.status({ sessionId: SESSION });
    // Seed a legacy completed record: this test checks read-only review behavior.
    const completed = { ...record, status: "complete" as const, completedAt: record.createdAt,
      evidence: { tests: ["npm test"], scope: ["git diff"] } };
    await new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root).mutate((state) => {
      state.tasks = state.tasks.map((current) => current.task.id === completed.task.id ? completed : current);
    });
    const envelope = await runReviewCommand({
      args: reviewArgs(taskId),
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
  const { root, tasks, taskId } = await withTask(true);
  try {
    let calls = 0;
    assert.throws(
      () => parseArgs(["review", "--task", taskId]),
      (error: unknown) =>
        error instanceof CliArgumentError &&
        error.message === "Review requires --yes to authorize both reviewer sessions."
    );
    assert.equal(calls, 0);
    const record = await tasks.status({ sessionId: SESSION });
    assert.deepEqual(record.evidence, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-auth not-run review does not point the operator at auth diagnostics", async () => {
  const { root, tasks, taskId } = await withTask(true);
  try {
    const envelope = await runReviewCommand({
      args: reviewArgs(taskId),
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
      args: parseArgs(["review", "--task", record.task.id, "--yes", "--rerun"]), authorized: true, tasks,
      sessionId: SESSION, root, gitRunner, config: REVIEW_CONFIG,
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG), evidenceStore,
      targets: ["codex"],
      execute: async (request) => {
        calls += 1;
        return completePassing(request, ["src/reviewed.ts"]);
      }
    });
    assert.equal(passed.status, "ok", passed.data?.result.reason ?? "missing reason");
    assert.equal(calls, 1);
    assert.equal((await findReviewAttestation(root, fingerprint))?.taskId, record.task.id);
    assert.deepEqual(passed.data?.result.verification?.commands, [
      { criterionId: "unit", commandId: "unit", required: true, status: "PASS", evidenceReference: reference },
      { criterionId: "scope", commandId: "unit", required: true, status: "PASS", evidenceReference: scopeReference },
      { criterionId: "scope", commandId: "optional", required: false, status: "FAIL", evidenceReference: optionalReference }
    ]);

    assert.throws(
      () => parseArgs(["review", "--task", record.task.id, "--yes", "--criterion", "unit"]),
      CliArgumentError
    );
    const failed = await runReviewCommand({
      args: parseArgs(["review", "--task", record.task.id, "--yes", "--rerun"]), authorized: true, tasks,
      sessionId: SESSION, root, gitRunner, config: REVIEW_CONFIG,
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG), evidenceStore,
      execute: async () => ({ status: "NOT_RUN", reason: "timeout" })
    });
    assert.equal(failed.status, "error");
    assert.equal(await findReviewAttestation(root, fingerprint), null);

    const unsafeSupportingPath = await runReviewCommand({
      args: parseArgs(["review", "--task", record.task.id, "--yes", "--rerun"]), authorized: true, tasks,
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
      args: parseArgs(["review", "--task", record.task.id, "--yes", "--rerun"]), authorized: true, tasks,
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
      args: parseArgs(["review", "--task", record.task.id, "--yes", "--rerun"]), authorized: true, tasks,
      sessionId: SESSION, root, gitRunner, config: REVIEW_CONFIG,
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG), evidenceStore,
      execute: async (request) => {
        calls += 1;
        await writeFile(join(root, "src", "reviewed.ts"), "export const changed = true\n");
        return completePassing(request, ["src/reviewed.ts"]);
      }
    });
    assert.equal(sourceChanged.data?.result.reason, "source-changed-during-review");
    assert.equal(sourceChanged.data?.result.report?.summary, "Review complete.");
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
      args: parseArgs(["review", "--task", record.task.id, "--yes", "--rerun"]), authorized: true, tasks,
      sessionId: SESSION, root, gitRunner, config: REVIEW_CONFIG,
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG), evidenceStore,
      execute: async () => {
        calls += 1;
        return { status: "NOT_RUN" as const, reason: "missing-cli" as const };
      }
    });
    assert.equal(contradictory.data?.result.reason, "verification-not-passed");
    assert.equal(calls, 2);
    // A failing verifier is not fixed by reviewing again, so the text must send
    // the caller back to the verifier — named with the task it belongs to.
    assert.match(
      contradictory.data?.text ?? "",
      /Re-running review cannot turn a failing verifier into a PASS/
    );
    assert.match(
      contradictory.data?.text ?? "",
      new RegExp(`Fix what failed, then run: agent-ops verify --task ${record.task.id}\\.`)
    );
    assert.doesNotMatch(contradictory.data?.text ?? "", /run this review again/);

    const stale = await runReviewCommand({
      args: parseArgs(["review", "--task", record.task.id, "--yes", "--rerun"]), authorized: true, tasks,
      sessionId: SESSION, root, gitRunner, config: { ...REVIEW_CONFIG, profiles: ["loop"] },
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG), evidenceStore,
      execute: async () => {
        calls += 1;
        return { status: "NOT_RUN" as const, reason: "missing-cli" as const };
      }
    });
    assert.equal(stale.data?.result.reason, "stale-verification");
    assert.equal(calls, 2);
    assert.equal(stale.data?.result.taskId, record.task.id);
    assert.match(
      stale.data?.text ?? "",
      /The source changed after this evidence was recorded/
    );
    assert.match(
      stale.data?.text ?? "",
      new RegExp(`Run: agent-ops verify --task ${record.task.id}, then run this review again\.`)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an incomplete reviewer PASS cannot create an attestation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-review-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "reviewed.ts"), "export {}\n");
    const result = await runReviewCommand({
      args: parseArgs(["review", "--task", "task-1", "--yes"]),
      authorized: true,
      root,
      gitRunner: reviewGitRunner(),
      targets: ["codex"],
      execute: async (request) => ({
        status: "PASS" as const,
        results: [],
        report: reportFor(
          request.invocation.packet.criteria,
          "PASS",
          ["src/reviewed.ts"]
        )
      })
    });

    assert.equal(result.status, "error");
    assert.equal(result.code, "REVIEW_NOT_RUN");
    assert.equal(result.data?.result.reason, "adversarial-review-missing");
    assert.ok(result.data?.result.sourceFingerprint);
    assert.equal(
      await findReviewAttestation(root, result.data!.result.sourceFingerprint!),
      null
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recorded verification failure is reported as a failure, not as stale evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-review-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "reviewed.ts"), "export {}\n");
    const tasks = service(root);
    const record = await tasks.create({
      title: "Review failed source",
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG),
      criteria: [
        { id: "unit", description: "Unit tests pass.", verifierIds: ["unit"] },
        { id: "scope", description: "Review scope is exact.", verifierIds: ["unit"] }
      ]
    });
    await tasks.attach(SESSION, record.task.id);
    await tasks.recordFailure(record.task.id, createFailureFingerprint({
      commandId: "unit",
      failureClass: "nonzero-exit",
      exitCategory: "nonzero",
      diagnostics: "1 test failed"
    }));

    let calls = 0;
    const result = await runReviewCommand({
      args: parseArgs(["review", "--task", record.task.id, "--yes", "--rerun"]),
      authorized: true,
      tasks,
      sessionId: SESSION,
      root,
      gitRunner: reviewGitRunner(),
      config: REVIEW_CONFIG,
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG),
      evidenceStore: new FileEvidenceStore(root, root),
      execute: async () => {
        calls += 1;
        return { status: "NOT_RUN" as const, reason: "missing-cli" as const };
      }
    });

    // "stale" sends the caller to re-run the verifier that just failed, which
    // fails again: the tests failed, and that is what the reason must say.
    assert.equal(result.data?.result.reason, "verification-not-passed");
    assert.equal(calls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unchanged source reuses its recorded PASS instead of paying again", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-review-reuse-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "reviewed.ts"), "export {}\n");
    const tasks = service(root);
    const record = await tasks.create({
      title: "Reuse recorded review",
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG),
      criteria: [
        { id: "unit", description: "Unit tests pass.", verifierIds: ["unit"] },
        { id: "scope", description: "Review scope is exact.", verifierIds: ["unit"] }
      ]
    });
    await tasks.attach(SESSION, record.task.id);
    const gitRunner = reviewGitRunner();
    const evidenceStore = new FileEvidenceStore(root, root);
    const fingerprint = await calculateSourceFingerprint(
      root,
      { mode: "worktree", changedFiles: ["src/reviewed.ts"] },
      gitRunner
    );
    const evidenceFor = async (criterionId: string): Promise<string> =>
      evidenceStore.save(buildVerificationEvidence({
        taskId: record.task.id,
        criterionId,
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
    // Every criterion in one call: partial evidence is rejected by design.
    await tasks.recordEvidence(record.task.id, {
      unit: [await evidenceFor("unit")],
      scope: [await evidenceFor("scope")]
    });
    let calls = 0;
    const shared = {
      authorized: true as const,
      tasks,
      sessionId: SESSION,
      root,
      gitRunner,
      config: REVIEW_CONFIG,
      policyConfigHash: calculateConfigHash(REVIEW_CONFIG),
      evidenceStore,
      targets: ["codex"] as const,
      execute: async (request: ReviewExecutionRequest) => {
        calls += 1;
        return completePassing(request, ["src/reviewed.ts"]);
      }
    };

    const first = await runReviewCommand({
      ...shared,
      args: parseArgs(["review", "--task", record.task.id, "--yes"])
    });
    assert.equal(first.status, "ok", first.data?.result.reason ?? "no reason");
    assert.equal(calls, 1);

    const second = await runReviewCommand({
      ...shared,
      args: parseArgs(["review", "--task", record.task.id, "--yes"])
    });
    assert.equal(second.status, "ok");
    assert.equal(calls, 1, "an unchanged source must not invoke a target again");
    assert.equal(second.data?.result.reused, true);
    assert.match(second.data?.text ?? "", /reused recorded evidence/);

    const forced = await runReviewCommand({
      ...shared,
      args: parseArgs(["review", "--task", record.task.id, "--yes", "--rerun"])
    });
    assert.equal(forced.status, "ok");
    assert.equal(calls, 2, "--rerun must run the chain again");
    assert.equal(forced.data?.result.reused, undefined);

    // A verification failure recorded after the review must stop the cached
    // PASS too: the source is unchanged, but it is no longer verified.
    const failed = await tasks.recordFailure(record.task.id, {
      value: "f".repeat(64),
      commandId: "unit",
      failureClass: "nonzero-exit",
      exitCategory: "nonzero",
      diagnostics: "the unit command failed after the review"
    });
    assert.equal(failed.state.commandId, "unit");
    const afterFailure = await runReviewCommand({
      ...shared,
      args: parseArgs(["review", "--task", record.task.id, "--yes"])
    });
    assert.equal(afterFailure.data?.result.reused, undefined);
    assert.notEqual(afterFailure.data?.result.status, "PASS");
    await tasks.clearFailure(record.task.id);

    // A policy change must stop the command before reuse is considered: the
    // recorded evidence proves the source, never the policy it ran under.
    const policyChanged = await runReviewCommand({
      ...shared,
      args: parseArgs(["review", "--task", record.task.id, "--yes"]),
      policyConfigHash: "0".repeat(64)
    });
    assert.equal(policyChanged.status, "error");
    assert.equal(policyChanged.data?.result.reason, "reviewer-policy-changed");
    assert.equal(policyChanged.data?.result.reused, undefined);
    assert.equal(calls, 2, "a policy mismatch must not spawn either");

    // A changed source is a different fingerprint, so the recorded PASS no
    // longer applies. Verification evidence goes stale with it, which is what
    // stops this run before any target — but never with a reused PASS.
    await writeFile(join(root, "src", "reviewed.ts"), "export const changed = 1\n");
    const changed = await runReviewCommand({
      ...shared,
      args: parseArgs(["review", "--task", record.task.id, "--yes"])
    });
    assert.equal(changed.data?.result.reused, undefined);
    assert.notEqual(changed.data?.result.status, "PASS");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("what a round cost survives the runner's own sanitizer", async () => {
  const attempt = {
    target: "agy" as const,
    status: "PASS" as const,
    sessionId: "session-1",
    metrics: {
      promptBytes: 4_096,
      durationMs: 12_345,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
    }
  };

  const result = await runIndependentReview({
    invocation: {
      harness: "agy",
      model: "m",
      effort: "e",
      packet: {
        request: "Review.",
        criteria: [{ id: "tests", description: "Tests pass." }],
        artifactRefs: [],
        evidenceRequirements: []
      }
    },
    authorized: true,
    execute: async () => ({
      status: "PASS" as const,
      results: [{ criterionId: "tests", status: "PASS" as const, summary: "ok", evidence: ["npm test"] }],
      attempts: [attempt]
    })
  });

  assert.deepEqual(result.attempts?.[0]?.metrics, attempt.metrics);
});

test("the task's latest failed review is carried into the next one", async () => {
  const { root, tasks, taskId } = await withTask(true);
  try {
    const seen: ReviewExecutionRequest[] = [];
    const review = () => runReviewCommand({
      args: reviewArgs(taskId),
      authorized: true,
      tasks,
      sessionId: SESSION,
      root,
      execute: async (request) => {
        seen.push(request);
        return passing(request);
      }
    });
    const clean = await review();
    assert.equal(seen[0]?.invocation.priorFindings, undefined);
    assert.doesNotMatch(clean.data?.result.prompt ?? "", /PRIOR_FINDINGS/);

    await saveReviewReportArtifact(root, {
      status: "FAIL",
      harness: "codex",
      model: "fixture",
      effort: "fixture",
      prompt: "fixture",
      report: reportFor([{ id: "tests" }, { id: "scope" }], "FAIL")
    }, "d".repeat(64), taskId);
    const carried = await review();
    assert.deepEqual(
      seen[1]?.invocation.priorFindings?.map((item) => item.title),
      ["Criterion failed."]
    );
    assert.match(carried.data?.result.prompt ?? "", /BEGIN_PRIOR_FINDINGS/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
