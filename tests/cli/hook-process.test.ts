import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type {
  AgentOpsConfig,
  HarnessId,
  InstallManifest,
  VerificationCommand
} from "../../runtime/src/contracts.js";
import { formatInstallManifest } from "../../runtime/src/fs/manifest.js";
import type {
  GitRunResult,
  GitRunner
} from "../../runtime/src/verify/change-surface.js";
import type {
  ProcessCompletion,
  ProcessRequest,
  RunningVerificationProcess,
  VerificationProcessRunner
} from "../../runtime/src/verify/spawn.js";
import { runHookProcess, type HookProcessIo } from "../../packages/cli/src/hook-process.js";
import { runLoopProcess } from "../../packages/cli/src/codex-loop-process.js";

async function* output(value = "# tests 1\n"): AsyncIterable<Uint8Array> {
  if (value.length > 0) {
    yield Buffer.from(value);
  }
}

class FixtureProcessRunner implements VerificationProcessRunner {
  readonly calls: ProcessRequest[] = [];

  start(request: ProcessRequest): RunningVerificationProcess {
    this.calls.push(request);
    const completion: ProcessCompletion = { exitCode: 0, signal: null };
    return {
      pid: 456,
      stdout: output(),
      stderr: output(""),
      completion: Promise.resolve(completion),
      terminateTree: async () => undefined
    };
  }
}

class FixtureGitRunner implements GitRunner {
  async run(args: readonly string[]): Promise<GitRunResult> {
    return {
      exitCode: 0,
      stdout:
        args[0] === "diff" && args[1] === "--cached"
          ? Buffer.from("src/example.ts\0")
          : new Uint8Array()
    };
  }
}

function command(): VerificationCommand {
  return {
    id: "unit",
    command: "unit-tool",
    args: [],
    cwd: ".",
    required: true,
    evidence: { kind: "test-count", minimum: 1 }
  };
}

function config(
  profiles: AgentOpsConfig["profiles"],
  stopEnabled = false
): AgentOpsConfig {
  return {
    schemaVersion: 2,
    profiles,
    verification: { commands: stopEnabled ? [command()] : [] },
    features: { stopVerification: { enabled: stopEnabled } },
    pathMappings: [],
    securityExceptions: []
  };
}

function io(stdin: string): {
  io: HookProcessIo;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdin: Readable.from([stdin]),
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value)
    },
    stdout,
    stderr
  };
}

async function createInvalidConfigInstallation(
  harness: HarnessId
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-hook-process-"));
  const manifest: InstallManifest = {
    schemaVersion: 2,
    scope: "project",
    harness: [harness],
    artifacts: [],
    markers: []
  };
  await mkdir(join(root, ".agent-ops"), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, ".agent-ops", "manifest.json"),
      formatInstallManifest(manifest)
    ),
    writeFile(join(root, ".agent-ops", "config.json"), "{ invalid JSON\n")
  ]);
  return root;
}

async function createInstallationWithoutConfig(
  harness: HarnessId
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-hook-installation-"));
  const manifest: InstallManifest = {
    schemaVersion: 2,
    scope: "project",
    harness: [harness],
    artifacts: [],
    markers: []
  };
  await mkdir(join(root, ".agent-ops"), { recursive: true });
  await writeFile(
    join(root, ".agent-ops", "manifest.json"),
    formatInstallManifest(manifest)
  );
  return root;
}

async function createValidConfigInstallation(
  harness: HarnessId
): Promise<string> {
  const root = await createInstallationWithoutConfig(harness);
  await writeFile(
    join(root, ".agent-ops", "config.json"),
    `${JSON.stringify(config(["core", "guardrails"]), null, 2)}\n`
  );
  return root;
}

async function createInvalidConfigRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-hook-uninstalled-"));
  await mkdir(join(root, ".agent-ops"), { recursive: true });
  await writeFile(join(root, ".agent-ops", "config.json"), "{ invalid JSON\n");
  return root;
}

async function invokeHookProcess(options: {
  readonly root: string;
  readonly harness: HarnessId;
  readonly event: "SessionStart" | "PreToolUse" | "Stop";
  readonly input: unknown;
}): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const streams = io(JSON.stringify(options.input));
  const exitCode = await runHookProcess(
    [options.harness, options.event],
    streams.io,
    "0.2.0",
    {
      root: options.root,
      trust: async () => "UNTRUSTED"
    }
  );
  assert.equal(exitCode, 0);
  return {
    stdout: streams.stdout.join(""),
    stderr: streams.stderr.join("")
  };
}

async function withHookEnvironment<T>(
  root: string,
  disabled: boolean,
  action: () => Promise<T>
): Promise<T> {
  const previousHome = process.env.AGENT_OPS_HOME;
  const previousDisabled = process.env.AGENT_OPS_DISABLE;
  process.env.AGENT_OPS_HOME = root;
  if (disabled) {
    process.env.AGENT_OPS_DISABLE = "1";
  } else {
    delete process.env.AGENT_OPS_DISABLE;
  }
  try {
    return await action();
  } finally {
    if (previousHome === undefined) {
      delete process.env.AGENT_OPS_HOME;
    } else {
      process.env.AGENT_OPS_HOME = previousHome;
    }
    if (previousDisabled === undefined) {
      delete process.env.AGENT_OPS_DISABLE;
    } else {
      process.env.AGENT_OPS_DISABLE = previousDisabled;
    }
  }
}

function claudePreToolUse(
  root: string,
  command = "echo safe"
): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_name: "Bash",
    tool_input: { command }
  };
}

function codexPreToolUse(root: string): Record<string, unknown> {
  return {
    hook_event_name: "PreToolUse",
    cwd: root,
    tool_name: "Bash",
    tool_input: { command: "echo safe" }
  };
}

function opencodePreToolUse(root: string): Record<string, unknown> {
  return {
    event: "PreToolUse",
    projectRoot: root,
    input: { tool: "bash" },
    output: { args: { command: "echo safe" } }
  };
}

test("Claude loop process returns native denials while Codex keeps exit-code denial", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-loop-process-"));
  try {
    await mkdir(join(root, ".claude"), { recursive: true });
    await mkdir(join(root, ".codex"), { recursive: true });
    await Promise.all([
      writeFile(join(root, ".claude", "loop-goal.md"), "# Goal\n"),
      writeFile(join(root, ".claude", "loop-state.md"), "# State\n"),
      writeFile(join(root, ".claude", "loop-telemetry.jsonl"), ""),
      writeFile(join(root, ".codex", "loop-goal.md"), "# Goal\n"),
      writeFile(join(root, ".codex", "loop-state.md"), "# State\n"),
      writeFile(join(root, ".codex", "loop-telemetry.jsonl"), "")
    ]);
    const token = `ghp_${"B".repeat(36)}`;
    const claude = io(
      JSON.stringify({ cwd: root, prompt: `token=${token}` })
    );
    const codex = io(
      JSON.stringify({
        cwd: root,
        tool_name: "Bash",
        tool_input: { command: "git reset --hard" }
      })
    );

    assert.equal(
      await runLoopProcess(
        ["claude", "UserPromptSubmit", "--managed-by=agent-ops"],
        claude.io,
        { root }
      ),
      0
    );
    assert.deepEqual(JSON.parse(claude.stdout.join("")), {
      decision: "block",
      reason: "agent-ops blocked a suspected secret."
    });
    assert.equal(
      await runLoopProcess(
        ["codex", "PreToolUse", "--managed-by=agent-ops"],
        codex.io,
        { root }
      ),
      2
    );
    assert.match(codex.stderr.join(""), /dangerous command/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "installed invalid config reaches only the declared runtime-failure boundary",
  { concurrency: false },
  async () => {
    const claudeRoot = await createInvalidConfigInstallation("claude");
    const codexRoot = await createInvalidConfigInstallation("codex");
    const opencodeRoot = await createInvalidConfigInstallation("opencode");
    const absentRoot = await mkdtemp(join(tmpdir(), "agent-ops-hook-absent-"));
    try {
      await withHookEnvironment(claudeRoot, false, async () => {
        const preToolUse = await invokeHookProcess({
          root: claudeRoot,
          harness: "claude",
          event: "PreToolUse",
          input: claudePreToolUse(claudeRoot)
        });
        assert.notEqual(preToolUse.stdout, "");
        const decision = JSON.parse(preToolUse.stdout) as {
          readonly hookSpecificOutput?: {
            readonly permissionDecision?: string;
            readonly permissionDecisionReason?: string;
          };
        };
        assert.equal(
          decision.hookSpecificOutput?.permissionDecision,
          "deny"
        );
        assert.match(
          decision.hookSpecificOutput?.permissionDecisionReason ?? "",
          /\.agent-ops[\\/]config\.json/
        );
        assert.match(
          decision.hookSpecificOutput?.permissionDecisionReason ?? "",
          /AGENT_OPS_DISABLE=1/
        );

        const sessionStart = await invokeHookProcess({
          root: claudeRoot,
          harness: "claude",
          event: "SessionStart",
          input: { hook_event_name: "SessionStart", cwd: claudeRoot }
        });
        const stop = await invokeHookProcess({
          root: claudeRoot,
          harness: "claude",
          event: "Stop",
          input: { hook_event_name: "Stop", cwd: claudeRoot }
        });
        assert.equal(sessionStart.stdout, "");
        assert.equal(stop.stdout, "");
      });

      await withHookEnvironment(codexRoot, false, async () => {
        const preToolUse = await invokeHookProcess({
          root: codexRoot,
          harness: "codex",
          event: "PreToolUse",
          input: codexPreToolUse(codexRoot)
        });
        assert.notEqual(preToolUse.stdout, "");
        assert.doesNotMatch(preToolUse.stdout, /deny/);
        assert.match(preToolUse.stdout, /COMMAND_POLICY_UNAVAILABLE/);

        const sessionStart = await invokeHookProcess({
          root: codexRoot,
          harness: "codex",
          event: "SessionStart",
          input: { hook_event_name: "SessionStart", cwd: codexRoot }
        });
        const stop = await invokeHookProcess({
          root: codexRoot,
          harness: "codex",
          event: "Stop",
          input: { hook_event_name: "Stop", cwd: codexRoot }
        });
        assert.doesNotMatch(sessionStart.stdout, /deny/);
        assert.doesNotMatch(stop.stdout, /deny/);
      });

      await withHookEnvironment(opencodeRoot, false, async () => {
        const commandBatch = await invokeHookProcess({
          root: opencodeRoot,
          harness: "opencode",
          event: "PreToolUse",
          input: {
            ...opencodePreToolUse(opencodeRoot),
            output: { args: { command: "echo safe && echo still-safe" } }
          }
        });
        assert.deepEqual(JSON.parse(commandBatch.stdout), { decision: "allow" });

        const sessionStart = await invokeHookProcess({
          root: opencodeRoot,
          harness: "opencode",
          event: "SessionStart",
          input: { event: "SessionStart", projectRoot: opencodeRoot }
        });
        const stop = await invokeHookProcess({
          root: opencodeRoot,
          harness: "opencode",
          event: "Stop",
          input: { event: "Stop", projectRoot: opencodeRoot }
        });
        assert.equal(JSON.parse(sessionStart.stdout).decision, "allow");
        assert.equal(JSON.parse(stop.stdout).decision, "allow");
      });

      await withHookEnvironment(absentRoot, false, async () => {
        const preToolUse = await invokeHookProcess({
          root: absentRoot,
          harness: "claude",
          event: "PreToolUse",
          input: claudePreToolUse(absentRoot)
        });
        assert.equal(preToolUse.stdout, "");
      });

      await withHookEnvironment(opencodeRoot, true, async () => {
        const preToolUse = await invokeHookProcess({
          root: opencodeRoot,
          harness: "opencode",
          event: "PreToolUse",
          input: opencodePreToolUse(opencodeRoot)
        });
        assert.deepEqual(JSON.parse(preToolUse.stdout), { decision: "allow" });

        const claudePreTool = await invokeHookProcess({
          root: claudeRoot,
          harness: "claude",
          event: "PreToolUse",
          input: claudePreToolUse(claudeRoot)
        });
        const codexPreTool = await invokeHookProcess({
          root: codexRoot,
          harness: "codex",
          event: "PreToolUse",
          input: codexPreToolUse(codexRoot)
        });
        const sessionStart = await invokeHookProcess({
          root: claudeRoot,
          harness: "claude",
          event: "SessionStart",
          input: { hook_event_name: "SessionStart", cwd: claudeRoot }
        });
        const stop = await invokeHookProcess({
          root: claudeRoot,
          harness: "claude",
          event: "Stop",
          input: { hook_event_name: "Stop", cwd: claudeRoot }
        });
        assert.doesNotMatch(claudePreTool.stdout, /deny/);
        assert.doesNotMatch(codexPreTool.stdout, /deny/);
        assert.doesNotMatch(sessionStart.stdout, /deny/);
        assert.doesNotMatch(stop.stdout, /deny/);
      });
    } finally {
      await Promise.all([
        rm(claudeRoot, { recursive: true, force: true }),
        rm(codexRoot, { recursive: true, force: true }),
        rm(opencodeRoot, { recursive: true, force: true }),
        rm(absentRoot, { recursive: true, force: true })
      ]);
    }
  }
);

test(
  "invalid config stays fail-open without matching installation proof",
  { concurrency: false },
  async () => {
    const uninstalledRoot = await createInvalidConfigRoot();
    const mismatchedRoot = await createInvalidConfigInstallation("codex");
    try {
      await withHookEnvironment(uninstalledRoot, false, async () => {
        const claude = await invokeHookProcess({
          root: uninstalledRoot,
          harness: "claude",
          event: "PreToolUse",
          input: claudePreToolUse(uninstalledRoot)
        });
        const opencode = await invokeHookProcess({
          root: uninstalledRoot,
          harness: "opencode",
          event: "PreToolUse",
          input: opencodePreToolUse(uninstalledRoot)
        });
        assert.equal(claude.stdout, "");
        assert.deepEqual(JSON.parse(opencode.stdout), { decision: "allow" });
      });

      await withHookEnvironment(mismatchedRoot, false, async () => {
        const claude = await invokeHookProcess({
          root: mismatchedRoot,
          harness: "claude",
          event: "PreToolUse",
          input: claudePreToolUse(mismatchedRoot)
        });
        assert.equal(claude.stdout, "");
      });
    } finally {
      await Promise.all([
        rm(uninstalledRoot, { recursive: true, force: true }),
        rm(mismatchedRoot, { recursive: true, force: true })
      ]);
    }
  }
);

test(
  "a valid user config remains effective when a project has no config",
  { concurrency: false },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-ops-hook-home-"));
    const root = await mkdtemp(join(tmpdir(), "agent-ops-hook-project-"));
    try {
      await mkdir(join(home, ".agent-ops"), { recursive: true });
      await writeFile(
        join(home, ".agent-ops", "config.json"),
        `${JSON.stringify(config(["core", "guardrails"]), null, 2)}\n`
      );

      await withHookEnvironment(home, false, async () => {
        const output = await invokeHookProcess({
          root,
          harness: "claude",
          event: "PreToolUse",
          input: claudePreToolUse(root, "git reset --hard origin/main")
        });
        assert.equal(
          (JSON.parse(output.stdout) as {
            readonly hookSpecificOutput?: {
              readonly permissionDecision?: string;
            };
          }).hookSpecificOutput?.permissionDecision,
          "deny"
        );
      });
    } finally {
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(root, { recursive: true, force: true })
      ]);
    }
  }
);

test(
  "a malformed user config cannot deny when project config is absent",
  { concurrency: false },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-ops-hook-home-"));
    const root = await createInstallationWithoutConfig("claude");
    try {
      await mkdir(join(home, ".agent-ops"), { recursive: true });
      await writeFile(
        join(home, ".agent-ops", "config.json"),
        "{ invalid JSON\n"
      );

      await withHookEnvironment(home, false, async () => {
        const output = await invokeHookProcess({
          root,
          harness: "claude",
          event: "PreToolUse",
          input: claudePreToolUse(root)
        });
        assert.equal(output.stdout, "");
      });
    } finally {
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(root, { recursive: true, force: true })
      ]);
    }
  }
);

test(
  "a malformed user config still reaches the failure boundary for valid project config",
  { concurrency: false },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "agent-ops-hook-home-"));
    const root = await createValidConfigInstallation("claude");
    try {
      await mkdir(join(home, ".agent-ops"), { recursive: true });
      await writeFile(
        join(home, ".agent-ops", "config.json"),
        "{ invalid JSON\n"
      );

      await withHookEnvironment(home, false, async () => {
        const output = await invokeHookProcess({
          root,
          harness: "claude",
          event: "PreToolUse",
          input: claudePreToolUse(root)
        });
        assert.equal(
          (JSON.parse(output.stdout) as {
            readonly hookSpecificOutput?: {
              readonly permissionDecision?: string;
            };
          }).hookSpecificOutput?.permissionDecision,
          "deny"
        );
      });
    } finally {
      await Promise.all([
        rm(home, { recursive: true, force: true }),
        rm(root, { recursive: true, force: true })
      ]);
    }
  }
);

test("real hook process reaches advisory implementation", async () => {
  const streams = io(JSON.stringify({
    hook_event_name: "SessionStart",
    cwd: "/workspace"
  }));
  let advisoryCalls = 0;

  const exitCode = await runHookProcess(
    ["claude", "SessionStart"],
    streams.io,
    "0.2.0",
    {
      root: "/workspace",
      loadConfig: async () => config(["advisory"]),
      trust: async () => "TRUSTED",
      advisory: async () => {
        advisoryCalls += 1;
      },
      gitRunner: new FixtureGitRunner(),
      processRunner: new FixtureProcessRunner()
    }
  );

  assert.equal(exitCode, 0);
  assert.equal(advisoryCalls, 1);
  assert.deepEqual(streams.stdout, []);
  assert.deepEqual(streams.stderr, []);
});

test("real Claude Stop hook executes report-only verification", async () => {
  const streams = io(JSON.stringify({
    hook_event_name: "Stop",
    cwd: "/workspace"
  }));
  const processRunner = new FixtureProcessRunner();

  await runHookProcess(
    ["claude", "Stop"],
    streams.io,
    "0.2.0",
    {
      root: "/workspace",
      loadConfig: async () => config(["core"], true),
      trust: async () => "TRUSTED",
      advisory: async () => undefined,
      gitRunner: new FixtureGitRunner(),
      processRunner
    }
  );

  assert.equal(processRunner.calls.length, 1);
  assert.deepEqual(processRunner.calls[0]?.env, {
    AGENT_OPS_STOP_VERIFY_ACTIVE: "1"
  });
  assert.match(streams.stdout.join(""), /STOP_VERIFICATION_FINISHED/);
});

test("native Claude recursion metadata prevents Stop execution", async () => {
  const streams = io(JSON.stringify({
    hook_event_name: "Stop",
    cwd: "/workspace",
    stop_hook_active: true
  }));
  const processRunner = new FixtureProcessRunner();

  await runHookProcess(
    ["claude", "Stop"],
    streams.io,
    "0.2.0",
    {
      root: "/workspace",
      loadConfig: async () => config(["core"], true),
      trust: async () => "TRUSTED",
      gitRunner: new FixtureGitRunner(),
      processRunner
    }
  );

  assert.equal(processRunner.calls.length, 0);
  assert.match(streams.stdout.join(""), /STOP_VERIFICATION_RECURSION/);
});

test("unsupported Codex Stop remains report-only and does not execute", async () => {
  const streams = io(JSON.stringify({
    hook_event_name: "Stop",
    cwd: "/workspace"
  }));
  const processRunner = new FixtureProcessRunner();

  await runHookProcess(
    ["codex", "Stop"],
    streams.io,
    "0.2.0",
    {
      root: "/workspace",
      loadConfig: async () => config(["core"], true),
      trust: async () => "TRUSTED",
      gitRunner: new FixtureGitRunner(),
      processRunner
    }
  );

  assert.equal(processRunner.calls.length, 0);
  assert.match(streams.stdout.join(""), /STOP_VERIFICATION_UNAVAILABLE/);
});

test("degraded OpenCode idle mapping still reports Stop evidence", async () => {
  const streams = io(JSON.stringify({
    event: "Stop",
    projectRoot: "/workspace"
  }));
  const processRunner = new FixtureProcessRunner();

  await runHookProcess(
    ["opencode", "Stop"],
    streams.io,
    "0.2.0",
    {
      root: "/workspace",
      loadConfig: async () => config(["core"], true),
      trust: async () => "TRUSTED",
      gitRunner: new FixtureGitRunner(),
      processRunner
    }
  );

  assert.equal(processRunner.calls.length, 1);
  assert.match(streams.stdout.join(""), /STOP_VERIFICATION_FINISHED/);
});
