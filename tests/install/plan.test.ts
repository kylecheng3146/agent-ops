import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  HarnessId,
  HarnessInstallAdapter
} from "../../runtime/src/install/harness.js";
import {
  createInstallPlan,
  type InstallPlan
} from "../../runtime/src/install/plan.js";
import { applyInstallPlan } from "../../runtime/src/install/apply.js";
import { sha256 } from "../../runtime/src/fs/hash.js";
import { formatInstallManifest } from "../../runtime/src/fs/manifest.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";

function adapters(): readonly HarnessInstallAdapter[] {
  return (["codex", "claude"] as const).map((id: HarnessId) => ({
    id,
    async plan(context) {
      const upper = id === "codex" ? "AGENTS" : "CLAUDE";
      const instructionPath =
        context.scope === "project"
          ? `${upper}.md`
          : `.${id}/${upper}.md`;
      return {
        artifacts: [
          {
            id: `${id}-rules`,
            path: `.agent-ops/${upper}.md`,
            content:
              `# ${upper} Loop Engineering\n\nProfiles: ${context.profiles.join(", ")}\n`
          }
        ],
        blocks: [
          {
            id: `${id}-routing`,
            path: instructionPath,
            version: 1,
            content:
              `Use \`.agent-ops/${upper}.md\` for Loop Engineering.`
          }
        ]
      };
    }
  }));
}

function writeOperation(plan: InstallPlan, path: string) {
  const operation = plan.operations.find(
    (candidate) => candidate.path === path
  );
  assert.equal(operation?.kind, "write");
  if (operation?.kind !== "write") {
    throw new Error(`Expected write operation for ${path}`);
  }
  return operation;
}

test("plans a complete project install without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-install-"));
  try {
    const existingAgents = "# Existing project instructions\n";
    await writeFile(join(root, "AGENTS.md"), existingAgents);

    const plan = await createInstallPlan({
      root,
      scope: "project",
      harness: "both",
      profiles: ["guardrails", "advisory"],
      adapters: adapters()
    });

    assert.deepEqual(await readdir(root), ["AGENTS.md"]);
    assert.deepEqual(plan.profiles, [
      "core",
      "advisory",
      "guardrails"
    ]);
    assert.deepEqual(plan.capabilities, [
      "rules",
      "task",
      "verify",
      "review",
      "lifecycle-summary",
      "local-log",
      "command-policy",
      "optional-stop-verify"
    ]);

    const agents = writeOperation(plan, "AGENTS.md");
    assert.equal(agents.expectedHash, sha256(existingAgents));
    assert.match(agents.content, /^# Existing project instructions/m);
    assert.match(
      agents.content,
      /<!-- agent-ops:start codex-routing v1 -->/
    );
    assert.match(
      agents.content,
      /<!-- agent-ops:end codex-routing -->/
    );

    const config = JSON.parse(
      writeOperation(plan, ".agent-ops/config.json").content
    ) as { profiles: string[]; verification: { commands: unknown[] } };
    assert.deepEqual(config.profiles, [
      "core",
      "advisory",
      "guardrails"
    ]);
    assert.deepEqual(config.verification.commands, []);

    const manifest = JSON.parse(
      writeOperation(plan, ".agent-ops/manifest.json").content
    ) as {
      scope: string;
      harness: string;
      artifacts: Array<{ path: string }>;
      markers: Array<{ path: string }>;
    };
    assert.equal(manifest.scope, "project");
    assert.equal(manifest.harness, "both");
    assert.deepEqual(
      manifest.artifacts.map(({ path }) => path),
      [
        ".agent-ops/config.json",
        ".agent-ops/AGENTS.md",
        ".agent-ops/CLAUDE.md"
      ]
    );
    assert.deepEqual(
      manifest.markers.map(({ path }) => path),
      ["AGENTS.md", "CLAUDE.md"]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plans user-scope instruction paths through adapter context", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-install-"));
  try {
    const plan = await createInstallPlan({
      root,
      scope: "user",
      harness: "both",
      profiles: ["advisory"],
      adapters: adapters()
    });

    assert.deepEqual(
      plan.operations
        .map(({ path }) => path)
        .filter((path) => path.endsWith(".md")),
      [
        ".agent-ops/AGENTS.md",
        ".agent-ops/CLAUDE.md",
        ".codex/AGENTS.md",
        ".claude/CLAUDE.md"
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("apply is transactional and a repeated init is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-install-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "# Keep this\n");
    const first = await createInstallPlan({
      root,
      scope: "project",
      harness: "both",
      profiles: ["core"],
      adapters: adapters()
    });
    await applyInstallPlan(root, first);
    const firstAgents = await readFile(join(root, "AGENTS.md"), "utf8");
    const firstManifest = await readFile(
      join(root, ".agent-ops", "manifest.json"),
      "utf8"
    );

    const second = await createInstallPlan({
      root,
      scope: "project",
      harness: "both",
      profiles: ["core"],
      adapters: adapters()
    });
    await applyInstallPlan(root, second);

    assert.equal(
      await readFile(join(root, "AGENTS.md"), "utf8"),
      firstAgents
    );
    assert.equal(
      await readFile(join(root, ".agent-ops", "manifest.json"), "utf8"),
      firstManifest
    );
    assert.equal(
      (await readdir(root)).some((name) =>
        name.startsWith(".agent-ops-backup-")
      ),
      false
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replanning preserves user-authored verifier configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-install-"));
  try {
    const first = await createInstallPlan({
      root,
      scope: "project",
      harness: "codex",
      profiles: ["core"],
      adapters: adapters()
    });
    await applyInstallPlan(root, first);
    const configPath = join(root, ".agent-ops", "config.json");
    const configured = {
      schemaVersion: 1,
      profiles: ["core"],
      verification: {
        commands: [
          {
            id: "unit",
            command: "node",
            args: ["--test"],
            cwd: ".",
            required: true,
            evidence: { kind: "test-count", minimum: 1 }
          }
        ]
      },
      pathMappings: [{ path: "src", verifierIds: ["unit"] }],
      securityExceptions: []
    };
    await writeFile(
      configPath,
      `${JSON.stringify(configured, null, 2)}\n`
    );

    const second = await createInstallPlan({
      root,
      scope: "project",
      harness: "codex",
      profiles: ["core"],
      adapters: adapters()
    });
    await applyInstallPlan(root, second);

    assert.deepEqual(
      JSON.parse(await readFile(configPath, "utf8")),
      configured
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed managed markers fail before any write", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-install-"));
  try {
    const malformed = [
      "# Existing",
      "<!-- agent-ops:start codex-routing v1 -->",
      "missing end"
    ].join("\n");
    await writeFile(join(root, "AGENTS.md"), malformed);

    await assert.rejects(
      createInstallPlan({
        root,
        scope: "project",
        harness: "codex",
        profiles: ["core"],
        adapters: adapters()
      }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "MALFORMED_MANAGED_BLOCK"
    );
    assert.equal(
      await readFile(join(root, "AGENTS.md"), "utf8"),
      malformed
    );
    await assert.rejects(readFile(join(root, ".agent-ops", "config.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate contribution paths fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-install-"));
  try {
    const conflicting = adapters().map((adapter) => ({
      ...adapter,
      async plan(context: Parameters<typeof adapter.plan>[0]) {
        const contribution = await adapter.plan(context);
        return {
          ...contribution,
          artifacts: contribution.artifacts.map((artifact) => ({
            ...artifact,
            path: ".agent-ops/shared.md"
          }))
        };
      }
    }));

    await assert.rejects(
      createInstallPlan({
        root,
        scope: "project",
        harness: "both",
        profiles: ["core"],
        adapters: conflicting
      }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "INSTALL_PATH_CONFLICT"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed post-apply validation rolls every write back", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-install-"));
  try {
    const existingAgents = "# Original\n";
    await writeFile(join(root, "AGENTS.md"), existingAgents);
    const plan = await createInstallPlan({
      root,
      scope: "project",
      harness: "codex",
      profiles: ["core"],
      adapters: adapters()
    });
    const configRecord = plan.manifest.artifacts.find(
      ({ path }) => path === ".agent-ops/config.json"
    );
    assert.notEqual(configRecord, undefined);
    if (configRecord === undefined) {
      return;
    }
    configRecord.hash = "0".repeat(64);
    const manifestOperation = writeOperation(
      plan,
      ".agent-ops/manifest.json"
    );
    manifestOperation.content = formatInstallManifest(plan.manifest);

    await assert.rejects(
      applyInstallPlan(root, plan),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TRANSACTION_FAILED"
    );

    assert.equal(
      await readFile(join(root, "AGENTS.md"), "utf8"),
      existingAgents
    );
    await assert.rejects(readFile(join(root, ".agent-ops", "config.json")));
    assert.equal(
      (await readdir(root)).some((name) =>
        name.startsWith(".agent-ops-backup-")
      ),
      false
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
