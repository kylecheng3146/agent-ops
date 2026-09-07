import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import type { StoredTaskRecord } from "../../runtime/src/task/store.js";
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { FileEvidenceStore } from "../../runtime/src/verify/evidence.js";
import { runReviewCommand } from "../../packages/cli/src/commands/review.js";
import { parseArgs } from "../../packages/cli/src/args.js";
import { reportFor } from "../review/report-fixture.js";
import { COMPLETION_CONFIG, passingCompletionEvidence } from "../task/completion-fixture.js";
import { cleanupE2eRoot, runBuiltCli } from "./helpers.js";

test("default core CLI completion enforces evidence and review regardless of host or disabled hooks", async () => {
  const { root, result } = runBuiltCli(["init", "--scope", "project", "--harness", "codex", "--profile", "core", "--yes", "--json"]);
  const home = mkdtempSync(join(tmpdir(), "agent-ops-completion-home-"));
  try {
    assert.equal(result.status, 0);
    const path = join(root, ".agent-ops", "config.json");
    const config = { ...JSON.parse(readFileSync(path, "utf8")), verification: COMPLETION_CONFIG.verification } as AgentOpsConfig;
    writeFileSync(path, JSON.stringify(config));
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "source.txt"), "changed\n");
    const created = runBuiltCli(["task", "create", "--json", "--title", "Complete source",
      ...["behavior", "regression"].flatMap((id) => ["--criterion", JSON.stringify({ id, description: `${id} passes`, verifierIds: ["unit"] })])
    ], root).result;
    assert.equal(created.status, 0);
    const task = JSON.parse(created.stdout).data.record as StoredTaskRecord;
    assert.equal(task.policyConfigHash, calculateConfigHash(config));
    const args = ["task", "complete", "--task", task.task.id, "--json",
      "--evidence", "behavior=true", "--evidence", "regression=PASS"];
    for (const host of ["codex", "claude", "agy", "gemini"]) {
      const rejected = runBuiltCli(args, root, root, { AGENT_OPS_HOST: host, AGENT_OPS_DISABLE: "1" }).result;
      assert.equal(rejected.status, 1, rejected.stdout);
      assert.equal(JSON.parse(rejected.stdout).code, "TASK_EVIDENCE_INVALID");
    }
    const references = await passingCompletionEvidence(root, task, config, { run: async (gitArgs) => ({
      exitCode: 0, stdout: execFileSync("git", [...gitArgs], { cwd: root, encoding: "buffer" })
    }) });
    execFileSync("git", ["add", "-A"], { cwd: root });
    assert.equal(execFileSync("git", ["ls-files", "--", ".agent-ops/tasks/", ".agent-ops/reviews/"], { cwd: root, encoding: "utf8" }), "");
    const passed = runBuiltCli(["task", "complete", "--task", task.task.id, "--json",
      ...Object.entries(references).flatMap(([criterion, values]) => values.flatMap((reference) => ["--evidence", `${criterion}=${reference}`]))
    ], root).result;
    assert.equal(passed.status, 0, passed.stdout);
    assert.equal(JSON.parse(passed.stdout).code, "TASK_COMPLETED");

    // Committing requires fresh base-scoped proof, not reuse of the pre-commit PASS.
    execFileSync("git", ["add", "source.txt"], { cwd: root });
    execFileSync("git", ["commit", "-m", "change"], { cwd: root, stdio: "ignore" });
    const committed = runBuiltCli(["task", "create", "--json", "--title", "Complete committed source",
      ...task.task.criteria.flatMap((criterion) => ["--criterion", JSON.stringify(criterion)])
    ], root).result;
    assert.equal(committed.status, 0);
    const committedId = JSON.parse(committed.stdout).data.record.task.id as string;
    assert.equal(runBuiltCli(["trust", "grant", "--yes", "--json"], root, home).result.status, 0);
    const verified = runBuiltCli(["verify", "--task", committedId, "--base", "HEAD^", "--json"], root, home).result;
    assert.equal(verified.status, 0, verified.stdout);
    assert.equal(JSON.parse(verified.stdout).data.report.reviewScope.mode, "base");
    const tasks = new TaskService(new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root));
    const committedReferences = (await tasks.status({ taskId: committedId })).evidence;
    const completionArgs = ["task", "complete", "--task", committedId, "--base", "HEAD^", "--json",
      ...Object.entries(committedReferences).flatMap(([criterion, values]) => values.flatMap((reference) => ["--evidence", `${criterion}=${reference}`]))];
    const noScope = runBuiltCli([...completionArgs.slice(0, 4), ...completionArgs.slice(6)], root).result;
    assert.equal(JSON.parse(noScope.stdout).code, "TASK_COMPLETION_SCOPE_REQUIRED");
    const emptyBase = runBuiltCli(completionArgs.map((arg) => arg === "HEAD^" ? "HEAD" : arg), root).result;
    assert.equal(JSON.parse(emptyBase.stdout).code, "TASK_COMPLETION_SCOPE_REQUIRED");
    assert.match(JSON.parse(emptyBase.stdout).errors[0].message, /range has no changed paths/u);
    assert.equal(JSON.parse(runBuiltCli(completionArgs, root).result.stdout).code, "TASK_COMPLETION_REVIEW_REQUIRED");
    const reviewed = await runReviewCommand({
      args: parseArgs(["review", "--yes", "--task", committedId, "--base", "HEAD^"]),
      authorized: true, taskId: committedId, tasks, root, config,
      policyConfigHash: calculateConfigHash(config), evidenceStore: new FileEvidenceStore(root, root),
      gitRunner: { run: async (gitArgs) => ({ exitCode: 0,
        stdout: execFileSync("git", [...gitArgs], { cwd: root, encoding: "buffer" }) }) },
      execute: async (request) => ({ status: "PASS", results: [],
        report: reportFor(request.invocation.packet.criteria, "PASS", request.invocation.scope?.changedFiles) })
    });
    assert.equal(reviewed.status, "ok", JSON.stringify(reviewed));
    const completeCommitted = runBuiltCli(completionArgs, root).result;
    assert.equal(completeCommitted.status, 0, completeCommitted.stdout);
    assert.equal(JSON.parse(completeCommitted.stdout).code, "TASK_COMPLETED");
    writeFileSync(join(root, "source.txt"), "unreviewed change\n");
    const dirty = runBuiltCli(completionArgs, root).result;
    assert.equal(dirty.status, 1);
    assert.equal(JSON.parse(dirty.stdout).code, "REVIEW_DIRTY_WORKTREE");
  } finally {
    cleanupE2eRoot(root);
    cleanupE2eRoot(home);
  }
});
