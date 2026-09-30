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
