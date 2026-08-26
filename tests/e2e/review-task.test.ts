import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import test from "node:test";

import { cleanupE2eRoot, runBuiltCli } from "./helpers.js";

test("review routes an explicit task through real Git preflight", () => {
  const { root, result: initialized } = runBuiltCli([
    "init", "--scope", "project", "--harness", "codex",
    "--profile", "core", "--yes", "--json"
  ]);
  try {
    assert.equal(initialized.status, 0);
    const created = runBuiltCli([
      "task", "create", "--json", "--title", "Review wiring",
      "--criterion", JSON.stringify({
        id: "first",
        description: "First criterion.",
        verifierIds: ["unit"]
      }),
      "--criterion", JSON.stringify({
        id: "second",
        description: "Second criterion.",
        verifierIds: ["unit"]
      })
    ], root).result;
    assert.equal(created.status, 0);
    const taskId = JSON.parse(created.stdout).data.record.task.id as string;

    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
    writeFileSync(`${root}/reviewed.txt`, "review me\n");

    const reviewed = runBuiltCli([
      "review", "--task", taskId, "--yes", "--json"
    ], root).result;
    const payload = JSON.parse(reviewed.stdout) as {
      data?: { result?: { reason?: string } };
    };

    assert.notEqual(reviewed.status, 0);
    assert.equal(payload.data?.result?.reason, "missing-verification-evidence");

    const unknown = runBuiltCli([
      "review", "--task", "task-missing", "--yes", "--json"
    ], root).result;
    assert.equal(JSON.parse(unknown.stdout).code, "TASK_NOT_FOUND");
  } finally {
    cleanupE2eRoot(root);
  }
});
