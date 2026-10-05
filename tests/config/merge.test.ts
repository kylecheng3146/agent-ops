import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {loadEffectiveConfig} from "../../packages/cli/src/context.js";
import {calculateConfigHash} from "../../runtime/src/config/hash.js";
import {explainConfig} from "../../runtime/src/config/explain.js";

import type {
  AgentOpsConfig,
  SecurityException,
  VerificationCommand
} from "../../runtime/src/contracts.js";
import {
  mergeConfigLayers,
  type ConfigLayer
} from "../../runtime/src/config/merge.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";

function command(
  id: string,
  executable: string,
  required = true
): VerificationCommand {
  return {
    id,
    command: executable,
    args: ["test"],
    cwd: ".",
    required,
    evidence: { kind: "test-count", minimum: 1 }
  };
}

function exception(scope: string): SecurityException {
  return {
    ruleId: "secrets",
    scope,
    expiresAt: "2027-01-01T00:00:00Z",
    reason: "Synthetic fixture."
  };
}

function config(overrides: Partial<AgentOpsConfig> = {}): AgentOpsConfig {
  return {
    schemaVersion: 3,
    profiles: ["core"],
    verification: { commands: [] },
    features: {
      completionGate: { enabled: false },
      stopVerification: { enabled: false }
    },
    pathMappings: [],
    securityExceptions: [],
    ...overrides
  };
}

function layer(
  source: ConfigLayer["source"],
  value: AgentOpsConfig
): ConfigLayer {
  return {
    source,
    sourcePath: `${source}.json`,
    config: value
  };
}

test("effective project config preserves acceptance runners, trust identity and provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-config-acceptance-"));
  const previousHome = process.env.AGENT_OPS_HOME;
  process.env.AGENT_OPS_HOME = join(root, "user-home");
  try {
    const runner = {id: "acceptance", command: process.execPath, args: ["tests/check.mjs"], cwd: ".", adapter: "generic" as const};
    const project = config({verification: {commands: [], acceptanceRunners: [runner]}});
    await mkdir(join(root, ".agent-ops"));
    await writeFile(join(root, ".agent-ops/config.json"), JSON.stringify(project));
    const loaded = await loadEffectiveConfig(root, "project");
    assert.deepEqual(loaded.config.verification.acceptanceRunners, [runner]);
    assert.equal(calculateConfigHash(loaded.config), calculateConfigHash(project));
    assert.notEqual(calculateConfigHash(loaded.config), calculateConfigHash(config()));
    assert.deepEqual(explainConfig(loaded).acceptanceRunners, [{id: runner.id, adapter: runner.adapter,
      source: "project", sourcePath: join(root, ".agent-ops/config.json")}]);
    const userRunner = {...runner, id: "user-only", args: ["tests/user-check.mjs"]};
    const merged = mergeConfigLayers([layer("user", config({verification: {commands: [], acceptanceRunners: [userRunner, {...runner, args: ["tests/old.mjs"]}]}})), layer("project", project)]);
    assert.deepEqual(merged.config.verification.acceptanceRunners, [userRunner, runner]);
    assert.equal(merged.provenance.acceptanceRunners?.find(entry => entry.value.id === runner.id)?.source, "project");
    assert.equal(mergeConfigLayers([layer("project", config())]).config.verification.acceptanceRunners, undefined);
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_OPS_HOME; else process.env.AGENT_OPS_HOME = previousHome;
    await rm(root, {recursive: true, force: true});
  }
});

test("merges stable IDs with provenance and monotonic guardrails", () => {
  const allowedException = exception("fixtures/synthetic");
  const merged = mergeConfigLayers([
    layer(
      "default",
      config({
        verification: { commands: [command("test", "default-tool", false)] }
      })
    ),
    layer(
      "user",
      config({
        profiles: ["guardrails"],
        verification: {
          commands: [command("test", "user-tool", false)]
        },
        pathMappings: [{ path: "src", verifierIds: ["test"] }],
        securityExceptions: [allowedException]
      })
    ),
    layer(
      "project",
      config({
        verification: {
          commands: [
            command("test", "project-tool", false),
            command("lint", "lint-tool")
          ]
        },
        pathMappings: [
          { path: "src", verifierIds: ["test", "lint"] }
        ],
        securityExceptions: [allowedException]
      })
    )
  ]);

  assert.deepEqual(merged.config.profiles, ["core", "guardrails"]);
  assert.equal(
    merged.config.verification.commands.find(({ id }) => id === "test")
      ?.command,
    "project-tool"
  );
  assert.deepEqual(merged.config.pathMappings[0]?.verifierIds, [
    "test",
    "lint"
  ]);
  assert.equal(
    merged.provenance.profiles.find(({ value }) => value === "guardrails")
      ?.source,
    "user"
  );
  assert.equal(
    merged.provenance.verificationCommands.find(
      ({ value }) => value.id === "test"
    )?.source,
    "project"
  );
  assert.equal(merged.provenance.securityExceptions[0]?.source, "user");
});

test("project config cannot weaken a user guardrail", () => {
  assert.throws(
    () =>
      mergeConfigLayers([
        layer(
          "user",
          config({
            verification: { commands: [command("security", "scan", true)] }
          })
        ),
        layer(
          "project",
          config({
            verification: {
              commands: [command("security", "replacement", false)]
            }
          })
        )
      ]),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "PROJECT_GUARDRAIL_WEAKENING"
  );

  assert.throws(
    () =>
      mergeConfigLayers([
        layer(
          "user",
          config({
            verification: {
              commands: [command("security", "trusted-scan", true)]
            }
          })
        ),
        layer(
          "project",
          config({
            verification: {
              commands: [command("security", "no-op", true)]
            }
          })
        )
      ]),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "PROJECT_GUARDRAIL_WEAKENING"
  );

  assert.throws(
    () =>
      mergeConfigLayers([
        layer("user", config()),
        layer(
          "project",
          config({
            securityExceptions: [exception("src/private")]
          })
        )
      ]),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "PROJECT_SECURITY_WEAKENING"
  );

  const userException = exception("fixtures/synthetic");
  assert.throws(
    () =>
      mergeConfigLayers([
        layer(
          "user",
          config({ securityExceptions: [userException] })
        ),
        layer(
          "project",
          config({
            securityExceptions: [
              { ...userException, scope: "FIXTURES/SYNTHETIC" }
            ]
          })
        )
      ]),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "PROJECT_SECURITY_WEAKENING"
  );

  const timedUserCommand = {
    ...command("security", "scan", true),
    timeoutMs: 1_000
  };
  const timedProjectCommand = {
    ...command("security", "replacement", true),
    timeoutMs: 2_000
  };
  assert.throws(
    () =>
      mergeConfigLayers([
        layer(
          "user",
          config({
            verification: { commands: [timedUserCommand] }
          })
        ),
        layer(
          "project",
          config({
            verification: { commands: [timedProjectCommand] }
          })
        )
      ]),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "PROJECT_GUARDRAIL_WEAKENING"
  );
});

test("project path mappings cannot drop user verifier coverage", () => {
  assert.throws(
    () =>
      mergeConfigLayers([
        layer(
          "user",
          config({
            verification: {
              commands: [
                command("test", "test-tool"),
                command("security", "security-tool")
              ]
            },
            pathMappings: [
              { path: "src", verifierIds: ["test", "security"] }
            ]
          })
        ),
        layer(
          "project",
          config({
            verification: {
              commands: [command("test", "project-test-tool")]
            },
            pathMappings: [{ path: "src", verifierIds: ["test"] }]
          })
        )
      ]),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "PROJECT_GUARDRAIL_WEAKENING"
  );

  assert.throws(
    () =>
      mergeConfigLayers([
        layer(
          "user",
          config({
            verification: { commands: [command("test", "test-tool")] },
            pathMappings: [{ path: "src", verifierIds: ["test"] }]
          })
        ),
        layer(
          "project",
          config({
            verification: {
              commands: [command("test", "test-tool")]
            },
            pathMappings: [{ path: "SRC", verifierIds: ["test"] }]
          })
        )
      ]),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "PROJECT_GUARDRAIL_WEAKENING"
  );
});

test("rejects duplicate stable mapping IDs within one layer", () => {
  assert.throws(
    () =>
      mergeConfigLayers([
        layer(
          "project",
          config({
            verification: { commands: [command("test", "npm")] },
            pathMappings: [
              { path: "src", verifierIds: ["test"] },
              { path: "SRC", verifierIds: ["test"] }
            ]
          })
        )
      ]),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "CONFIG_DUPLICATE_ID"
  );
});

test("review roles survive the merge, with project overriding user per role", () => {
  const merged = mergeConfigLayers([
    layer(
      "user",
      config({
        reviewRoles: [
          { role: "independent-review", targets: ["claude"] },
          { role: "mechanical", targets: ["codex"] }
        ]
      })
    ),
    layer(
      "project",
      config({
        reviewRoles: [
          { role: "independent-review", targets: ["codex", "agy"] }
        ]
      })
    )
  ]);
  assert.deepEqual(merged.config.reviewRoles, [
    { role: "independent-review", targets: ["codex", "agy"] },
    { role: "mechanical", targets: ["codex"] }
  ]);
});

test("a merge of configs without review roles leaves the field absent", () => {
  const merged = mergeConfigLayers([layer("project", config())]);
  assert.equal(merged.config.reviewRoles, undefined);
});

test("project worktree overrides user worktree as a whole block", () => {
  const merged = mergeConfigLayers([
    layer(
      "user",
      config({
        worktree: {
          mode: "auto",
          setup: [{ command: "pnpm", args: ["install"] }]
        }
      })
    ),
    layer("project", config({ worktree: { mode: "off" } }))
  ]);
  assert.deepEqual(merged.config.worktree, { mode: "off" });
  assert.equal(merged.provenance.worktree?.source, "project");
});

test("a user worktree survives a project layer that does not set one", () => {
  const merged = mergeConfigLayers([
    layer("user", config({ worktree: { mode: "auto" } })),
    layer("project", config())
  ]);
  assert.deepEqual(merged.config.worktree, { mode: "auto" });
});

test("a merge of configs without worktree leaves the field absent", () => {
  const merged = mergeConfigLayers([layer("project", config())]);
  assert.equal("worktree" in merged.config, false);
});
