import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { runReviewCommand } from "../../packages/cli/src/commands/review.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { findReviewAttestation } from "../../runtime/src/review/attestation.js";
import type { ReviewExecutionRequest } from "../../runtime/src/review/runner.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import type { GitRunner } from "../../runtime/src/verify/change-surface.js";
import { buildVerificationEvidence, calculateConfigHash, FileEvidenceStore } from "../../runtime/src/verify/evidence.js";
import { calculateSourceFingerprint } from "../../runtime/src/verify/source-fingerprint.js";
import { reportFor } from "../review/report-fixture.js";

const config: AgentOpsConfig = {
  schemaVersion: 3, profiles: ["core"],
  verification: { commands: [{ id: "unit", command: "node", args: ["--test"], cwd: ".", required: true, evidence: { kind: "exit-code" } }] },
  features: { completionGate: { enabled: false }, stopVerification: { enabled: false } },
  pathMappings: [], securityExceptions: []
};

const gitRunner: GitRunner = { run: async (args) => ({
  exitCode: 0,
  stdout: args[0] === "rev-parse" ? Buffer.from(`${"a".repeat(40)}\n`) :
    args[0] === "diff" && args[1] === "--cached" ? Buffer.from("src/reviewed.ts\0") : new Uint8Array()
}) };

test("one tree review covers duplicate child criterion IDs and leaves task-bound attestations", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-tree-review-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "reviewed.ts"), "export const ready = true;\n");
    let sequence = 0;
    const tasks = new TaskService(new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root), {
      generateId: () => `task-${++sequence}`
    });
    const criteria = [
      { id: "behavior", description: "The behavior is correct", verifierIds: ["unit"] },
      { id: "regression", description: "Existing behavior survives", verifierIds: ["unit"] }
    ];
    const parent = await tasks.create({ title: "Whole objective", intent: "Combine both child changes safely.", criteria,
      policyConfigHash: calculateConfigHash(config) });
    const a = await tasks.create({ title: "Child A", intent: "Add the A path and keep the public API stable.", criteria,
      policyConfigHash: calculateConfigHash(config), parentTaskId: parent.task.id });
    const b = await tasks.create({ title: "Child B", intent: "Add the B path and preserve A behavior.", criteria,
      policyConfigHash: calculateConfigHash(config), parentTaskId: parent.task.id });
    const fingerprint = await calculateSourceFingerprint(root, { mode: "worktree", changedFiles: ["src/reviewed.ts"] }, gitRunner);
    const store = new FileEvidenceStore(root, root);
    for (const record of [parent, a, b]) {
      const evidence: Record<string, string[]> = {};
      for (const criterion of criteria) {
        evidence[criterion.id] = [await store.save(buildVerificationEvidence({
          taskId: record.task.id, criterionId: criterion.id, command: config.verification.commands[0]!, scope: "project",
          startedAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z",
          exitCode: 0, testCount: null, status: "PASS", failureClass: "none", sourceFingerprint: fingerprint,
          toolVersions: {}, config
        }))];
      }
      await tasks.recordEvidence(record.task.id, evidence);
    }
    let calls = 0;
    const execute = async (request: ReviewExecutionRequest) => {
        calls += 1;
        const ids = request.invocation.packet.criteria.map(({ id }) => id);
        assert.equal(ids.length, calls === 1 ? 2 : 6);
        if (calls === 2) {
          assert.equal(new Set(ids).size, 6);
          assert.match(request.invocation.packet.request, /keep the public API stable/u);
          assert.match(request.invocation.packet.request, /preserve A behavior/u);
        }
        const targets = request.invocation.plannedTargets ?? ["codex", "codex"];
        const report = reportFor(request.invocation.packet.criteria, "PASS", ["src/reviewed.ts"]);
        return {
          status: "PASS" as const,
          results: ids.map((criterionId) => ({ criterionId, status: "PASS" as const, evidence: ["inspected source"] })),
          report, plannedTargets: targets, sessionIsolation: "fresh" as const,
          attempts: targets.map((target, index) => ({ target, status: "PASS" as const, sessionId: `tree-${index}` })),
          adversarial: { target: targets[1]!, refuted: false, report }
        };
      };
    const common = { authorized: true, tasks, taskId: parent.task.id, root, gitRunner, config,
      policyConfigHash: calculateConfigHash(config), evidenceStore: store, targets: ["codex"] as const, execute };
    assert.equal((await runReviewCommand({ ...common,
      args: parseArgs(["review", "--task", parent.task.id, "--yes"])
    })).status, "ok");
    const reviewed = await runReviewCommand({
      ...common,
      args: parseArgs(["review", "--task", parent.task.id, "--tree", "--yes"])
    });
    assert.equal(reviewed.status, "ok");
    assert.equal(calls, 2);
    for (const record of [parent, a, b]) {
      const attestation = await findReviewAttestation(root, fingerprint, record.task.id);
      assert.deepEqual(attestation?.tree?.taskIds, [parent.task.id, a.task.id, b.task.id]);
      assert.equal((await tasks.status({ taskId: record.task.id })).evidence.behavior?.some((ref) => ref.startsWith("review:")), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
