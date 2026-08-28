import assert from "node:assert/strict";
import test from "node:test";

import {
  agyRuntimeStatus,
  agyVersionSupported,
  hookRegistrationDrift,
  hookRegistrationSatisfied,
  repositoryTrustStatus,
  smokeAvailabilityStatus
} from "../../runtime/src/install/probes.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { buildOpencodePlugin } from "../../runtime/src/adapters/opencode/config.js";
import {
  HARNESS_IDS,
  harnessDescriptor
} from "../../runtime/src/install/harness.js";

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

test("agy version probe shares the doctor minimum", () => {
  assert.equal(agyVersionSupported("agy 1.1.11"), false);
  assert.equal(agyVersionSupported("agy 1.1.12"), true);
  assert.equal(agyVersionSupported("agy 1.2.0"), true);
});

test("agy runtime probe enforces version and loaded hook state", () => {
  const loaded = JSON.stringify({ command: { data: { hooks: [{
    name: "agent-ops",
    enabled: true,
    actions: [
      { event: "PreInvocation", command: "node hook.js agy SessionStart --managed-by=agent-ops" },
      { event: "PreToolUse", command: "node hook.js agy PreToolUse --managed-by=agent-ops" }
    ]
  }] } } });
  const loopEvents = ["SessionStart", "PreToolUse"] as const;
  assert.equal((agyRuntimeStatus("agy 1.1.11", loaded, loopEvents) as { status: string }).status, "FAIL");
  assert.equal((agyRuntimeStatus("agy 1.1.12", loaded, loopEvents) as { status: string }).status, "PASS");
  assert.equal((agyRuntimeStatus("agy 1.1.22", JSON.stringify({ command: { data: { hooks: [] } } }), loopEvents) as { status: string }).status, "FAIL");
  assert.equal((agyRuntimeStatus("agy 1.1.22", JSON.stringify({ command: { data: { hooks: [] } } }), []) as { status: string }).status, "PASS");
  const partial = JSON.stringify({ command: { data: { hooks: [{
    name: "agent-ops",
    enabled: true,
    actions: [{ event: "PreToolUse", command: "node hook.js agy PreToolUse --managed-by=agent-ops" }]
  }] } } });
  assert.equal((agyRuntimeStatus("agy 1.1.22", partial, loopEvents) as { status: string }).status, "FAIL");
  const lookalike = JSON.stringify({ command: { data: { hooks: [{
    name: "foreign",
    enabled: true,
    actions: [{ command: "echo agent-ops" }]
  }] } } });
  assert.equal((agyRuntimeStatus("agy 1.1.22", lookalike, ["PreToolUse"]) as { status: string }).status, "FAIL");
});

function hookConfig(
  profiles: AgentOpsConfig["profiles"],
  stopVerification = false
): AgentOpsConfig {
  return {
    schemaVersion: 3,
    profiles,
    verification: {
      commands: stopVerification
        ? [
            {
              id: "test",
              command: "node",
              args: [],
              cwd: ".",
              required: true,
              evidence: { kind: "exit-code" }
            }
          ]
        : []
    },
    features: {
      completionGate: { enabled: false },
      stopVerification: { enabled: stopVerification }
    },
    pathMappings: [],
    securityExceptions: []
  };
}

test("core-only installations have no hooks to register", () => {
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["codex", "claude"],
      config: hookConfig(["core"]),
      sources: { claude: null, codex: null }
    }),
    true
  );
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["agy"],
      config: hookConfig(["core"]),
      sources: { agy: null }
    }),
    true
  );
});

test("an empty profile list has no hooks to register", () => {
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["codex", "claude", "opencode"],
      config: hookConfig([]),
      sources: {}
    }),
    true
  );
});

test("advisory installations require owned handlers in every harness", () => {
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["codex", "claude"],
      config: hookConfig(["core", "advisory"]),
      sources: { claude: CLAUDE_SETTINGS, codex: CODEX_HOOKS }
    }),
    true
  );
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["codex", "claude"],
      config: hookConfig(["core", "advisory"]),
      sources: { claude: CLAUDE_SETTINGS, codex: null }
    }),
    false
  );
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["claude"],
      config: hookConfig(["core", "advisory"]),
      sources: { claude: CLAUDE_SETTINGS, codex: null }
    }),
    true
  );
});

test("a legacy PATH-resolved codex handler needs an update", () => {
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["codex"],
      config: hookConfig(["core", "advisory"]),
      sources: { claude: null, codex: LEGACY_CODEX_HOOKS }
    }),
    false
  );
});

test("foreign handlers do not satisfy hook registration", () => {
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["claude"],
      config: hookConfig(["core", "advisory"]),
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
      config: hookConfig(["core", "advisory", "guardrails"]),
      sources: { opencode: source }
    }),
    true
  );
  assert.equal(
    hookRegistrationSatisfied({
      harness: ["opencode"],
      config: hookConfig(["core", "guardrails"]),
      sources: { opencode: source.replace("tool.execute.before", "foreign") }
    }),
    false
  );
});

test("hook registration drift names the harnesses missing owned handlers", () => {
  assert.deepEqual(
    hookRegistrationDrift({
      harness: ["codex", "claude"],
      config: hookConfig(["core", "advisory"]),
      sources: { claude: CLAUDE_SETTINGS, codex: null }
    }),
    ["codex"]
  );
  assert.deepEqual(
    hookRegistrationDrift({
      harness: ["codex", "claude"],
      config: hookConfig(["core", "advisory"]),
      sources: { claude: CLAUDE_SETTINGS, codex: CODEX_HOOKS }
    }),
    []
  );
});

test("registration probes are owned by the control adapter", () => {
  for (const id of HARNESS_IDS) {
    const descriptor = harnessDescriptor(id);
    assert.equal(typeof descriptor.control.hookRegistered, "function", id);
    assert.ok(
      descriptor.control.registrations.every(
        ({ surfaceId, capability, nativeEvent }) =>
          surfaceId.length > 0 &&
          capability.length > 0 &&
          nativeEvent.length > 0
      ),
      id
    );
  }
});

test("repository trust separates ungranted from stale bindings", () => {
  assert.equal(repositoryTrustStatus("TRUSTED"), "PASS");
  assert.equal(repositoryTrustStatus("STALE"), "FAIL");
  assert.equal(repositoryTrustStatus("UNTRUSTED"), "UNKNOWN");
});

test("smoke availability follows configured verification commands", () => {
  const config: AgentOpsConfig = {
    schemaVersion: 3,
    profiles: ["core"],
    verification: { commands: [] },
    features: {
      completionGate: { enabled: false },
      stopVerification: { enabled: false }
    },
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
