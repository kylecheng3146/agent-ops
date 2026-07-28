import assert from "node:assert/strict";
import test from "node:test";

import {
  hookRegistrationSatisfied,
  smokeAvailabilitySatisfied
} from "../../runtime/src/install/probes.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";

const CLAUDE_SETTINGS = {
  hooks: {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: "node",
            args: [
              "/opt/agent-ops/hook-entry.js",
              "claude",
              "SessionStart",
              "--managed-by=agent-ops"
            ]
          }
        ]
      }
    ]
  }
};

const CODEX_HOOKS = {
  hooks: {
    SessionStart: [
      {
        hooks: [
          {
            type: "command",
            command: "agent-ops hook codex SessionStart"
          }
        ]
      }
    ]
  }
};

test("core-only installations have no hooks to register", () => {
  assert.equal(
    hookRegistrationSatisfied({
      harness: "both",
      profiles: ["core"],
      claudeSettings: null,
      codexHooks: null
    }),
    true
  );
});

test("advisory installations require owned handlers in every harness", () => {
  assert.equal(
    hookRegistrationSatisfied({
      harness: "both",
      profiles: ["core", "advisory"],
      claudeSettings: CLAUDE_SETTINGS,
      codexHooks: CODEX_HOOKS
    }),
    true
  );
  assert.equal(
    hookRegistrationSatisfied({
      harness: "both",
      profiles: ["core", "advisory"],
      claudeSettings: CLAUDE_SETTINGS,
      codexHooks: null
    }),
    false
  );
  assert.equal(
    hookRegistrationSatisfied({
      harness: "claude",
      profiles: ["core", "advisory"],
      claudeSettings: CLAUDE_SETTINGS,
      codexHooks: null
    }),
    true
  );
});

test("foreign handlers do not satisfy hook registration", () => {
  assert.equal(
    hookRegistrationSatisfied({
      harness: "claude",
      profiles: ["core", "advisory"],
      claudeSettings: {
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "node", args: ["other.js"] }] }
          ]
        }
      },
      codexHooks: null
    }),
    false
  );
});

test("smoke availability follows configured verification commands", () => {
  const config: AgentOpsConfig = {
    schemaVersion: 1,
    profiles: ["core"],
    verification: { commands: [] },
    pathMappings: [],
    securityExceptions: []
  };
  assert.equal(smokeAvailabilitySatisfied(config), false);
  assert.equal(
    smokeAvailabilitySatisfied({
      ...config,
      verification: {
        commands: [
          {
            id: "test",
            command: "npm",
            args: ["test"],
            cwd: ".",
            required: true,
            evidence: { kind: "exit-code" }
          }
        ]
      }
    }),
    true
  );
});
