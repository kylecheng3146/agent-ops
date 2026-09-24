import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import type { AgentOpsConfig, WorktreeSetupCommand } from "../../runtime/src/contracts.js";
import { CompletionGateService } from "../../runtime/src/hooks/completion-gate.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import type { GitRunResult, GitRunner } from "../../runtime/src/verify/change-surface.js";
import { FileEvidenceStore } from "../../runtime/src/verify/evidence.js";
import type { TrustState, WorktreeDependencies } from "../../runtime/src/worktree/service.js";

export const execFile = promisify(execFileCallback);

export const CONFIG: AgentOpsConfig = {
  schemaVersion: 3,
  profiles: ["core", "loop"],
  verification: {
    commands: [{
      id: "node-test",
      command: "node",
      args: ["--test"],
      cwd: ".",
      required: true,
      evidence: { kind: "exit-code" }
    }]
  },
  features: {
    completionGate: { enabled: true },
    stopVerification: { enabled: false }
  },
  pathMappings: [],
  securityExceptions: []
};

export function gitRunner(root: string): GitRunner {
  return {
    async run(args: readonly string[]): Promise<GitRunResult> {
      try {
        const result = await execFile("git", [...args], { cwd: root, encoding: "buffer" });
        return { exitCode: 0, stdout: result.stdout as Buffer };
      } catch (error) {
        const failure = error as { code?: number; stdout?: Uint8Array };
        return { exitCode: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? new Uint8Array() };
      }
    }
  };
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFile("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

export async function write(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

/**
 * A main checkout with a committed file, an ignored agent-ops install
 * (config, manifest, rules) and an optional `.worktreeinclude`.
 */
export async function repository(config: AgentOpsConfig = CONFIG): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ops-worktree-")));
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await write(root, ".gitignore", ".agent-ops/\n.env\n");
  await write(root, "source.txt", "base\n");
  await write(root, "CLAUDE.md", "committed rules\n");
  await git(root, "add", ".gitignore", "source.txt", "CLAUDE.md");
  await git(root, "commit", "-m", "base");
  await write(root, ".agent-ops/config.json", `${JSON.stringify(config, null, 2)}\n`);
  await write(root, ".agent-ops/CLAUDE.md", "managed rules\n");
  await write(root, ".agent-ops/manifest.json", `${JSON.stringify({
    schemaVersion: 2,
    scope: "project",
    harness: ["claude"],
    artifacts: [
      { id: "config", path: ".agent-ops/config.json", hash: "a".repeat(64), owner: "agent-ops" },
      { id: "claude-rules", path: ".agent-ops/CLAUDE.md", hash: "b".repeat(64), owner: "agent-ops" }
    ],
    markers: [{
      id: "claude-routing", path: "CLAUDE.md", hash: "c".repeat(64), owner: "agent-ops",
      startMarker: "<!-- start -->", endMarker: "<!-- end -->"
    }]
  }, null, 2)}\n`);
  return root;
}

export async function loadConfig(root: string): Promise<AgentOpsConfig> {
  try {
    return JSON.parse(await readFile(join(root, ".agent-ops", "config.json"), "utf8")) as AgentOpsConfig;
  } catch {
    return { ...CONFIG, features: { ...CONFIG.features, completionGate: { enabled: false } } };
  }
}

export function gateFor(root: string, config: AgentOpsConfig): CompletionGateService {
  return new CompletionGateService({
    root,
    config,
    gitRunner: gitRunner(root),
    taskService: new TaskService(
      new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root),
      { completion: { root, gitRunner: gitRunner(root), loadConfig: async () => config } }
    ),
    evidenceStore: new FileEvidenceStore(root, root),
    forRoot: async (other) => gateFor(other, await loadConfig(other))
  });
}

export interface FakeDeps extends WorktreeDependencies {
  readonly granted: string[];
  readonly revoked: string[];
  readonly setupRuns: { cwd: string; step: WorktreeSetupCommand }[];
}

export function deps(options: {
  readonly trust?: TrustState;
  readonly setupExit?: number;
} = {}): FakeDeps {
  const granted: string[] = [];
  const revoked: string[] = [];
  const setupRuns: { cwd: string; step: WorktreeSetupCommand }[] = [];
  return {
    granted,
    revoked,
    setupRuns,
    git: async (cwd, args) => {
      try {
        const result = await execFile("git", [...args], { cwd, encoding: "utf8" });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? ""
        };
      }
    },
    loadConfig,
    trust: {
      status: async (root) => granted.includes(root) ? "TRUSTED" : options.trust ?? "TRUSTED",
      grant: async (root) => { granted.push(root); },
      revoke: async (root) => { revoked.push(root); }
    },
    gate: async (root, config) => gateFor(root, config),
    runSetup: async (cwd, step) => {
      setupRuns.push({ cwd, step });
      return { exitCode: options.setupExit ?? 0, output: "setup output\n" };
    },
    now: () => "2026-09-24T00:00:00.000Z"
  };
}

export function stopEvent(sessionId: string) {
  return {
    event: "stop" as const,
    projectRoot: ".",
    sessionId,
    terminationReason: "model_stop",
    fullyIdle: true
  };
}
