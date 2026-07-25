import assert from "node:assert/strict";
import test from "node:test";

import { cleanupE2eRoot, runBuiltCli } from "./helpers.js";

test("project init dry-run covers each native harness selection", () => {
  for (const profile of ["core", "advisory", "guardrails"] as const) {
    for (const harness of ["claude", "codex", "both"] as const) {
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
