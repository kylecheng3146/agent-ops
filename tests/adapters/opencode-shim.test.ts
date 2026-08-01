import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { buildOpencodePlugin } from "../../runtime/src/adapters/opencode/config.js";

type ShellResult = {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
};

type FakeShell = {
  readonly calls: Array<{
    readonly values: readonly unknown[];
    readonly cwd: string | undefined;
  }>;
  readonly $: (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => FakeCommand;
};

type FakeCommand = {
  cwd(value: string): FakeCommand;
  quiet(): Promise<ShellResult>;
};

function fakeShell(
  stdout: string | null,
  error?: Error
): FakeShell {
  const calls: Array<{
    readonly values: readonly unknown[];
    readonly cwd: string | undefined;
  }> = [];
  const $ = (
    _strings: TemplateStringsArray,
    ...values: unknown[]
  ): FakeCommand => {
    let cwd: string | undefined;
    const command: FakeCommand = {
      cwd(value) {
        cwd = value;
        return command;
      },
      quiet: async () => {
        calls.push({ values, cwd });
        if (error !== undefined) {
          throw error;
        }
        return {
          stdout: Buffer.from(stdout ?? "", "utf8"),
          stderr: Buffer.alloc(0)
        };
      }
    };
    return command;
  };
  return { $, calls };
}

async function loadPlugin(
  capabilities: readonly ("lifecycle-summary" | "command-policy" | "optional-stop-verify")[]
): Promise<{
  readonly module: {
    readonly AgentOps: (context: unknown) => Promise<Record<string, unknown>>;
  };
  readonly cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-opencode-shim-"));
  const source = buildOpencodePlugin(capabilities, "/opt/agent-ops/hook-entry.js");
  assert.ok(source !== null);
  const path = join(root, "agent-ops.mjs");
  await writeFile(path, source, "utf8");
  return {
    module: (await import(`${pathToFileURL(path).href}?test=${Date.now()}`)) as {
      readonly AgentOps: (context: unknown) => Promise<Record<string, unknown>>;
    },
    cleanup: async () => await rm(root, { recursive: true, force: true })
  };
}

test("generated shim throws the runtime deny reason", async () => {
  const loaded = await loadPlugin(["command-policy"]);
  try {
    const shell = fakeShell(
      JSON.stringify({ decision: "deny", reason: "destructive-force-push" })
    );
    const hooks = await loaded.module.AgentOps({
      $: shell.$,
      directory: "/repo"
    });
    const before = hooks["tool.execute.before"] as (
      input: unknown,
      output: unknown
    ) => Promise<void>;
    await assert.rejects(
      before(
        { tool: "bash" },
        { args: { command: "git push --force origin main" } }
      ),
      /destructive-force-push/
    );
    assert.equal(shell.calls.length, 1);
    assert.equal(shell.calls[0]?.cwd, "/repo");
  } finally {
    await loaded.cleanup();
  }
});

test("generated shim allows a runtime allow decision", async () => {
  const loaded = await loadPlugin(["command-policy"]);
  try {
    const shell = fakeShell(JSON.stringify({ decision: "allow" }));
    const hooks = await loaded.module.AgentOps({
      $: shell.$,
      directory: "/repo"
    });
    const before = hooks["tool.execute.before"] as (
      input: unknown,
      output: unknown
    ) => Promise<void>;
    await before(
      { tool: "bash" },
      { args: { command: "echo ok" } }
    );
    assert.equal(shell.calls.length, 1);
    assert.equal(shell.calls[0]?.cwd, "/repo");
  } finally {
    await loaded.cleanup();
  }
});

test("missing runtime fails open for advisory and closed for guardrails", async () => {
  const advisory = await loadPlugin(["lifecycle-summary"]);
  const guardrail = await loadPlugin(["command-policy"]);
  try {
    const advisoryShell = fakeShell(null, new Error("node missing"));
    await advisory.module.AgentOps({
      $: advisoryShell.$,
      directory: "/repo"
    });

    const guardrailShell = fakeShell(null, new Error("node missing"));
    const hooks = await guardrail.module.AgentOps({
      $: guardrailShell.$,
      directory: "/repo"
    });
    const before = hooks["tool.execute.before"] as (
      input: unknown,
      output: unknown
    ) => Promise<void>;
    await assert.rejects(
      before({ tool: "bash" }, { args: { command: "rm -rf /" } }),
      /command policy is unavailable/
    );
  } finally {
    await advisory.cleanup();
    await guardrail.cleanup();
  }
});
