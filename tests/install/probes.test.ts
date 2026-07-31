import assert from "node:assert/strict";
import test from "node:test";

import {
  hookRegistrationSatisfied,
  repositoryTrustStatus,
  smokeAvailabilityStatus
} from "../../runtime/src/install/probes.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { buildOpencodePlugin } from "../../runtime/src/adapters/opencode/config.js";

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
            command:
              'node "/opt/agent-ops/hook-entry.js" codex SessionStart --managed-by=agent-ops'
          }
        ]
      }
    ]
  }
};

const LEGACY_CODEX_HOOKS = {
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
      harness: ["codex", "claude"],
      profiles: ["core"],
      sources: { claude: null, codex: null }
    }),
    true
  );
});

test("an empty profile list has no hooks to register", () => {
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["codex", "claude", "opencode"],
      profiles: [],
      sources: {}
    }),
    true
  );
});

test("advisory installations require owned handlers in every harness", () => {
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["codex", "claude"],
      profiles: ["core", "advisory"],
      sources: { claude: CLAUDE_SETTINGS, codex: CODEX_HOOKS }
    }),
    true
  );
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["codex", "claude"],
      profiles: ["core", "advisory"],
      sources: { claude: CLAUDE_SETTINGS, codex: null }
    }),
    false
  );
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["claude"],
      profiles: ["core", "advisory"],
      sources: { claude: CLAUDE_SETTINGS, codex: null }
    }),
    true
  );
});

test("a legacy PATH-resolved codex handler needs an update", () => {
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["codex"],
      profiles: ["core", "advisory"],
      sources: { claude: null, codex: LEGACY_CODEX_HOOKS }
    }),
    false
  );
});

test("foreign handlers do not satisfy hook registration", () => {
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["claude"],
      profiles: ["core", "advisory"],
      sources: { claude: {
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "node", args: ["other.js"] }] }
          ]
        }
      }, codex: null }
    }),
    false
  );
});

test("opencode registration is checked against the capability-implied plugin hooks", () => {
  const source = buildOpencodePlugin(
    ["lifecycle-summary", "command-policy", "optional-stop-verify"],
    "/opt/agent-ops/hook-entry.js"
  );
  assert.ok(source !== null);
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["opencode"],
      profiles: ["core", "advisory", "guardrails"],
      sources: { opencode: source }
    }),
    true
  );
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["opencode"],
      profiles: ["core", "guardrails"],
      sources: { opencode: source.replace("tool.execute.before", "foreign") }
    }),
    false
  );
});

test("repository trust separates ungranted from stale bindings", () => {
  assert.equal(repositoryTrustStatus("TRUSTED"), "PASS");
  assert.equal(repositoryTrustStatus("STALE"), "FAIL");
  assert.equal(repositoryTrustStatus("UNTRUSTED"), "UNKNOWN");
});

test("smoke availability follows configured verification commands", () => {
  const config: AgentOpsConfig = {
    schemaVersion: 1,
    profiles: ["core"],
    verification: { commands: [] },
    pathMappings: [],
    securityExceptions: []
  };
  assert.equal(smokeAvailabilityStatus(config), "UNKNOWN");
  assert.equal(
    smokeAvailabilityStatus({
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
    "PASS"
  );
});
