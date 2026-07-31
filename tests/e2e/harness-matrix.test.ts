import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cleanupE2eRoot, runBuiltCli } from "./helpers.js";

test("project init dry-run covers each native harness selection", () => {
  for (const profile of ["core", "advisory", "guardrails"] as const) {
    for (const harness of [
      "claude",
      "codex",
      "opencode",
      "codex,opencode",
      "codex,claude",
      "all",
      "both"
    ] as const) {
      const { root, result } = runBuiltCli([
        "init",
        "--dry-run",
        "--scope",
        "project",
        "--harness",
        harness,
        "--profile",
        profile,
        "--json"
      ]);
      try {
        assert.equal(result.status, 0, `${profile}/${harness}`);
        assert.match(result.stdout, /INIT_PLAN_READY/, `${profile}/${harness}`);
      } finally {
        cleanupE2eRoot(root);
      }
    }
  }
});

test("applies one shared AGENTS route and an opencode plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-e2e-opencode-"));
  const opencodeConfig = '{"instructions":["README.md"]}\n';
  await writeFile(join(root, "opencode.json"), opencodeConfig, "utf8");
  const { result } = runBuiltCli([
    "init",
    "--scope",
    "project",
    "--harness",
    "codex,opencode",
    "--profile",
    "advisory",
    "--yes",
    "--json"
  ], root);
  try {
    assert.equal(result.status, 0);
    assert.match(result.stdout, /INIT_APPLIED/);
    const manifest = JSON.parse(
      await readFile(join(root, ".agent-ops", "manifest.json"), "utf8")
    ) as {
      harness: string[];
      artifacts: { id: string; path: string }[];
      markers: { id: string; path: string }[];
    };
    assert.deepEqual(manifest.harness, ["codex", "opencode"]);
    assert.deepEqual(
      manifest.artifacts.map(({ id, path }) => ({ id, path })),
      [
        { id: "config", path: ".agent-ops/config.json" },
        { id: "agents-rules", path: ".agent-ops/AGENTS.md" },
        { id: "opencode-plugin", path: ".opencode/plugins/agent-ops.js" }
      ]
    );
    assert.equal(manifest.markers.length, 1);
    assert.equal(manifest.markers[0]?.id, "agents-routing");
    assert.equal(manifest.markers[0]?.path, "AGENTS.md");
    assert.equal(
      await readFile(join(root, "opencode.json"), "utf8"),
      opencodeConfig
    );
  } finally {
    cleanupE2eRoot(root);
  }
});
