import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
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

test("review --harness narrows the configured chain in dry-run output", () => {
  const { root, result: initialized } = runBuiltCli([
    "init", "--scope", "project", "--harness", "codex",
    "--profile", "core", "--review-target", "codex",
    "--review-target", "claude", "--yes", "--json"
  ]);
  try {
    assert.equal(initialized.status, 0);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
    writeFileSync(`${root}/reviewed.txt`, "review me\n");

    const explicit = runBuiltCli([
      "review", "--harness", "claude", "--dry-run", "--json"
    ], root, root, { AGENT_OPS_HOST: "codex" }).result;
    const explicitResult = JSON.parse(explicit.stdout).data.result;
    assert.equal(explicitResult.harness, "claude");
    assert.deepEqual(explicitResult.plannedTargets, ["claude"]);

    const fallback = runBuiltCli([
      "review", "--dry-run", "--json"
    ], root, root, { AGENT_OPS_HOST: "codex" }).result;
    assert.deepEqual(
      JSON.parse(fallback.stdout).data.result.plannedTargets,
      ["claude", "codex"]
    );

    const rejected = runBuiltCli([
      "review", "--harness", "agy", "--dry-run", "--json"
    ], root).result;
    assert.equal(JSON.parse(rejected.stdout).code, "REVIEW_TARGET_NOT_CONFIGURED");
  } finally {
    cleanupE2eRoot(root);
  }
});

test("SIGINT and SIGTERM stop the reviewer tree without JSON or attestation", {
  skip: process.platform === "win32"
}, async () => {
  const { root, result: initialized } = runBuiltCli([
    "init", "--scope", "project", "--harness", "codex",
    "--profile", "core", "--review-target", "codex", "--yes", "--json"
  ]);
  try {
    assert.equal(initialized.status, 0);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "reviewed.txt"), "review me\n");

    const fakeBin = join(root, "fake-bin");
    const reviewerPidPath = join(root, "reviewer.pid");
    const fakeCodex = join(fakeBin, "codex");
    mkdirSync(fakeBin);
    writeFileSync(fakeCodex, [
      `#!${process.execPath}`,
      "const { writeFileSync } = require('node:fs');",
      "if (process.argv.includes('--help')) {",
      "  process.stdout.write('--cd --ephemeral --ignore-user-config --ignore-rules');",
      "  process.exit(0);",
      "}",
      `writeFileSync(${JSON.stringify(reviewerPidPath)}, String(process.pid));`,
      "process.on('SIGTERM', () => process.exit(0));",
      "setInterval(() => {}, 1000);"
    ].join("\n"));
    chmodSync(fakeCodex, 0o755);

    const interrupt = async (
      signal: "SIGINT" | "SIGTERM",
      expectedExitCode: number
    ): Promise<void> => {
      rmSync(reviewerPidPath, { force: true });
      const child = spawn(process.execPath, [
        join(process.cwd(), ".tmp/test-dist/packages/cli/src/bin.js"),
        "review", "--harness", "codex", "--yes", "--json"
      ], {
        cwd: root,
        env: {
          ...process.env,
          AGENT_OPS_HOME: root,
          AGENT_OPS_HOST: "claude",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (value) => { stdout += String(value); });
      const started = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`review did not start: ${stderr}`)),
          5_000
        );
        child.stderr.on("data", (value) => {
          stderr += String(value);
          if (stderr.includes("codex: review started")) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      await started;
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5_000;
        const check = (): void => {
          if (existsSync(reviewerPidPath)) {
            resolve();
          } else if (Date.now() >= deadline) {
            reject(new Error("fake reviewer did not write its pid"));
          } else {
            setTimeout(check, 10);
          }
        };
        check();
      });
      child.kill(signal);
      const exitCode = await new Promise<number | null>((resolve) => {
        child.once("close", resolve);
      });

      assert.equal(exitCode, expectedExitCode);
      assert.equal(stdout, "");
      assert.match(stderr, new RegExp(`codex: review interrupted by ${signal}`));
      const reviewerPid = Number(readFileSync(reviewerPidPath, "utf8"));
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 2_000;
        const check = (): void => {
          try {
            process.kill(reviewerPid, 0);
            if (Date.now() >= deadline) {
              reject(new Error(`reviewer process ${reviewerPid} survived ${signal}`));
            } else {
              setTimeout(check, 10);
            }
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "ESRCH"
            ) {
              resolve();
            } else {
              reject(error);
            }
          }
        };
        check();
      });
    };

    await interrupt("SIGINT", 130);
    await interrupt("SIGTERM", 143);
    assert.equal(existsSync(join(root, ".agent-ops", "reviews")), false);
  } finally {
    cleanupE2eRoot(root);
  }
});
