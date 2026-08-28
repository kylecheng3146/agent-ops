import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runAgyHeadless } from "../../packages/cli/src/agy-headless.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { CompletionGateService } from "../../runtime/src/hooks/completion-gate.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { FileEvidenceStore } from "../../runtime/src/verify/evidence.js";
import type { GitRunResult, GitRunner } from "../../runtime/src/verify/change-surface.js";

const execFile = promisify(execFileCallback);
const CONFIG: AgentOpsConfig = {
  schemaVersion: 3,
  profiles: ["core", "loop"],
  verification: { commands: [] },
  features: {
    completionGate: { enabled: true },
    stopVerification: { enabled: false }
  },
  pathMappings: [],
  securityExceptions: []
};

function runner(root: string): GitRunner {
  return {
    async run(args): Promise<GitRunResult> {
      try {
        const result = await execFile("git", [...args], { cwd: root, encoding: "buffer" });
        return { exitCode: 0, stdout: result.stdout as Buffer };
      } catch (error) {
        const failure = error as { status?: number; stdout?: Uint8Array };
        return { exitCode: failure.status ?? 1, stdout: failure.stdout ?? new Uint8Array() };
      }
    }
  };
}

test("headless agy rechecks changed source on process exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-agy-headless-"));
  try {
    await execFile("git", ["init"], { cwd: root });
    await execFile("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFile("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".agent-ops/tasks/\n.agent-ops/reviews/\n");
    await writeFile(join(root, "source.txt"), "base\n");
    await execFile("git", ["add", ".gitignore", "source.txt"], { cwd: root });
    await execFile("git", ["commit", "-m", "base"], { cwd: root });
    const gate = new CompletionGateService({
      root,
      config: CONFIG,
      gitRunner: runner(root),
      taskService: new TaskService(
        new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root)
      ),
      evidenceStore: new FileEvidenceStore(root, root)
    });
    let injectedSession = "";
    const exitCode = await runAgyHeadless({
      root,
      sessionId: "headless-one",
      args: ["-p", "change source"],
      gate,
      env: {},
      run: async (_args, env) => {
        injectedSession = env.AGENT_OPS_SESSION_ID ?? "";
        await writeFile(join(root, "source.txt"), "changed\n");
        return 0;
      }
    });
    assert.equal(injectedSession, "headless-one");
    assert.equal(exitCode, 2);

    assert.equal(await runAgyHeadless({
      root,
      sessionId: "headless-error",
      args: [],
      gate,
      run: async () => 7
    }), 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
