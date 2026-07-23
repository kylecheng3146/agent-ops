import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import {
  runInitCommand,
  type InitCommandOptions
} from "../../packages/cli/src/commands/init.js";
import type {
  HarnessInstallAdapter
} from "../../runtime/src/install/harness.js";

function codexAdapter(): HarnessInstallAdapter {
  return {
    id: "codex",
    async plan(context) {
      return {
        artifacts: [
          {
            id: "codex-rules",
            path: ".agent-ops/AGENTS.md",
            content:
              `# Loop Engineering\n\nProfiles: ${context.profiles.join(", ")}\n`
          }
        ],
        blocks: [
          {
            id: "codex-routing",
            path:
              context.scope === "project"
                ? "AGENTS.md"
                : ".codex/AGENTS.md",
            version: 1,
            content: "Use `.agent-ops/AGENTS.md`."
          }
        ]
      };
    }
  };
}

function options(
  root: string,
  argv: readonly string[],
  overrides: Partial<InitCommandOptions> = {}
): InitCommandOptions {
  return {
    args: parseArgs(argv),
    root,
    adapters: [codexAdapter()],
    isTTY: false,
    confirm: async () => {
      throw new Error("confirmation must not be requested");
    },
    ...overrides
  };
}

test("dry-run returns the complete plan without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-init-"));
  try {
    const result = await runInitCommand(
      options(root, [
        "init",
        "--scope",
        "project",
        "--harness",
        "codex",
        "--profile",
        "core",
        "--dry-run",
        "--json"
      ])
    );

    assert.equal(result.status, "ok");
    assert.equal(result.code, "INIT_PLAN_READY");
    assert.equal(result.data?.applied, false);
    assert.equal(result.data?.plan.scope, "project");
    assert.ok(
      result.data?.plan.operations.some(
        ({ path }) => path === ".agent-ops/manifest.json"
      )
    );
    await assert.rejects(readFile(join(root, ".agent-ops", "config.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-interactive apply requires yes after choices are complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-init-"));
  try {
    const result = await runInitCommand(
      options(root, [
        "init",
        "--scope",
        "project",
        "--harness",
        "codex",
        "--profile",
        "core"
      ])
    );

    assert.equal(result.status, "error");
    assert.equal(result.code, "INIT_CONFIRMATION_REQUIRED");
    await assert.rejects(readFile(join(root, ".agent-ops", "config.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("yes applies only the fully specified plan and never grants trust", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-init-"));
  let confirmations = 0;
  try {
    const result = await runInitCommand(
      options(
        root,
        [
          "init",
          "--scope",
          "project",
          "--harness",
          "codex",
          "--profile",
          "core",
          "--yes"
        ],
        {
          confirm: async () => {
            confirmations += 1;
            return true;
          }
        }
      )
    );

    assert.equal(result.status, "ok");
    assert.equal(result.code, "INIT_APPLIED");
    assert.equal(result.data?.applied, true);
    assert.equal(confirmations, 0);
    assert.match(
      await readFile(join(root, "AGENTS.md"), "utf8"),
      /agent-ops:start codex-routing/
    );
    await assert.rejects(
      readFile(join(root, ".agent-ops", "trust.json"))
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TTY cancellation leaves the complete plan unapplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-init-"));
  let confirmations = 0;
  try {
    const result = await runInitCommand(
      options(
        root,
        [
          "init",
          "--scope",
          "project",
          "--harness",
          "codex",
          "--profile",
          "core"
        ],
        {
          isTTY: true,
          confirm: async () => {
            confirmations += 1;
            return false;
          }
        }
      )
    );

    assert.equal(result.status, "error");
    assert.equal(result.code, "INIT_CANCELLED");
    assert.equal(confirmations, 1);
    await assert.rejects(readFile(join(root, "AGENTS.md")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
