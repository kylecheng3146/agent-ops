import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { hasFreshVerification, runReviewCommand } from "../../packages/cli/src/commands/review.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import type { GitRunner } from "../../runtime/src/verify/change-surface.js";
import { buildVerificationEvidence, calculateConfigHash, FileEvidenceStore } from "../../runtime/src/verify/evidence.js";
import { calculateSourceFingerprint } from "../../runtime/src/verify/source-fingerprint.js";
import { taskContractHash } from "../../runtime/src/task/contract.js";

const CONFIG: AgentOpsConfig = {
  schemaVersion: 3,
  profiles: ["core"],
  verification: { commands: [
    { id: "unit", command: "node", args: ["--test"], cwd: ".", required: true, evidence: { kind: "exit-code" } }
  ] },
  features: {
    completionGate: { enabled: false },
    stopVerification: { enabled: false }
  },
  pathMappings: [],
  securityExceptions: []
};

const gitRunner: GitRunner = {
  run: async (args) => ({
    exitCode: 0,
    stdout: args[0] === "rev-parse"
      ? Buffer.from(`${"a".repeat(40)}\n`)
      : args[0] === "diff" && args[1] === "--cached"
        ? Buffer.from("src/reviewed.ts\0")
        : new Uint8Array()
  })
};

test("fresh-check-shared: true only with current PASS evidence, and review preflight agrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-fresh-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "reviewed.ts"), "export {}\n");
    let sequence = 0;
    const tasks = new TaskService(
      new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root),
      { generateId: () => `task-${++sequence}`, now: () => "2026-09-30T03:00:00.000Z" }
    );
    const evidenceStore = new FileEvidenceStore(root, root);
    const current = await calculateSourceFingerprint(
      root,
      { mode: "worktree", changedFiles: ["src/reviewed.ts"] },
      gitRunner
    );
    const options = (taskId: string, execute: () => Promise<never>) => ({
      args: parseArgs(["review", "--task", taskId, "--yes", "--rerun"]),
      authorized: true,
      tasks,
      taskId,
      root,
      gitRunner,
      config: CONFIG,
      policyConfigHash: calculateConfigHash(CONFIG),
      evidenceStore,
      execute
    });
    const seed = async (fingerprint: string | null, status: "PASS" | "FAIL") => {
      const record = await tasks.create({
        title: "Check verification",
        policyConfigHash: calculateConfigHash(CONFIG),
        criteria: [
          { id: "unit", description: "Unit tests pass.", verifierIds: ["unit"] },
          { id: "scope", description: "Review scope is exact.", verifierIds: ["unit"] }
        ]
      });
      if (fingerprint !== null) {
        const saved: Record<string, string[]> = {};
        for (const criterionId of ["unit", "scope"]) {
          saved[criterionId] = [await evidenceStore.save(buildVerificationEvidence({
            taskId: record.task.id,
            criterionId,
            command: CONFIG.verification.commands[0]!,
            scope: "project",
            startedAt: "2026-09-30T03:00:00.000Z",
            finishedAt: "2026-09-30T03:00:01.000Z",
            exitCode: status === "PASS" ? 0 : 1,
            testCount: null,
            status,
            failureClass: status === "PASS" ? "none" : "nonzero-exit",
            sourceFingerprint: fingerprint,
            toolVersions: {},
            config: CONFIG
          }))];
        }
        await tasks.recordEvidence(record.task.id, saved);
      }
      return record.task.id;
    };
    const scenarios: ReadonlyArray<readonly [string, string | null, "PASS" | "FAIL", boolean, string | undefined]> = [
      ["current PASS", current, "PASS", true, undefined],
      ["no evidence", null, "PASS", false, "missing-verification-evidence"],
      ["stale fingerprint", "b".repeat(64), "PASS", false, "stale-verification"],
      ["current but failing", current, "FAIL", false, "verification-not-passed"]
    ];
    for (const [name, fingerprint, status, expected, reason] of scenarios) {
      const taskId = await seed(fingerprint, status);
      const fresh = await hasFreshVerification(options(taskId, async () => {
        throw new Error("hasFreshVerification must not start a review");
      }), taskId);
      assert.equal(fresh, expected, name);
      let spawned = 0;
      const result = await runReviewCommand(options(taskId, async () => {
        spawned += 1;
        return { status: "NOT_RUN", reason: "missing-cli" } as never;
      }));
      // The batch's answer and the review's own preflight never disagree.
      assert.equal(spawned > 0, expected, `${name}: review spawns exactly when verification is fresh`);
      if (reason !== undefined) {
        assert.equal(result.data?.result.reason, reason, name);
      }
    }
    assert.equal(await hasFreshVerification({ ...options("x", async () => { throw new Error("no"); }), root: undefined }, "x"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a review-only criterion naming no verifier reaches review", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-review-only-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "reviewed.ts"), "export {}\n");
    let sequence = 0;
    const tasks = new TaskService(
      new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root),
      { generateId: () => `task-${++sequence}`, now: () => "2026-09-30T03:00:00.000Z",
        completion: { root, gitRunner, loadConfig: async () => CONFIG } }
    );
    const evidenceStore = new FileEvidenceStore(root, root);
    const current = await calculateSourceFingerprint(root, { mode: "worktree", changedFiles: ["src/reviewed.ts"] }, gitRunner);
    // A legacy criterion cannot name no verifier at all; review-task-context covers
    // one naming only an optional verifier, which must still stop at preflight.
    const reviewOnly = { id: "judgment", description: "Meets the goal.", verifierIds: [] as string[], acceptance: { mode: "review-only" as const, bindings: [], baselineCommit: "a".repeat(40), reviewOnlyReason: "Needs judgment" } };
    const outcomes: Array<[string, boolean, string | undefined]> = [];
    for (const [name, criterion] of [["review-only", reviewOnly]] as const) {
      const record = await tasks.create({
        title: name, policyConfigHash: calculateConfigHash(CONFIG),
        criteria: [{ id: "unit", description: "Unit tests pass.", verifierIds: ["unit"] }, criterion]
      });
      const contract = taskContractHash(record.task);
      const saved: Record<string, string[]> = {};
      // Verify records mandatory repository commands for every criterion of a typed contract.
      for (const criterionId of ["unit", "judgment"]) {
        saved[criterionId] = [await evidenceStore.save(buildVerificationEvidence({
          taskId: record.task.id, criterionId, command: CONFIG.verification.commands[0]!, scope: "project",
          startedAt: "2026-09-30T03:00:00.000Z", finishedAt: "2026-09-30T03:00:01.000Z", exitCode: 0, testCount: null,
          status: "PASS", failureClass: "none", sourceFingerprint: current,
          taskContractHash: contract, toolVersions: {}, config: CONFIG
        }))];
      }
      await tasks.recordEvidence(record.task.id, saved);
      let spawned = 0;
      const result = await runReviewCommand({
        args: parseArgs(["review", "--task", record.task.id, "--yes", "--rerun"]), authorized: true, tasks, taskId: record.task.id,
        root, gitRunner, config: CONFIG, policyConfigHash: calculateConfigHash(CONFIG), evidenceStore,
        execute: async () => { spawned += 1; return { status: "NOT_RUN", reason: "missing-cli" } as never; }
      });
      outcomes.push([name, spawned > 0, spawned > 0 ? undefined : result.data?.result.reason]);
    }
    assert.deepEqual(outcomes, [["review-only", true, undefined]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
