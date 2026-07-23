import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import {
  explainConfigCommand
} from "../../packages/cli/src/commands/config.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import {
  mergeConfigLayers
} from "../../runtime/src/config/merge.js";

test("config explain exposes provenance without command or reason values", () => {
  const config: AgentOpsConfig = {
    schemaVersion: 1,
    profiles: ["core"],
    verification: {
      commands: [
        {
          id: "test",
          command: "secret-command",
          args: ["--token", "TOKEN_VALUE"],
          cwd: ".",
          required: true,
          evidence: { kind: "exit-code" }
        }
      ]
    },
    pathMappings: [{ path: "src", verifierIds: ["test"] }],
    securityExceptions: [
      {
        ruleId: "secrets",
        scope: "fixtures",
        expiresAt: "2027-01-01T00:00:00Z",
        reason: "TOKEN_VALUE"
      }
    ]
  };
  const merged = mergeConfigLayers([
    {
      source: "user",
      sourcePath: "user.json",
      config
    }
  ]);

  const envelope = explainConfigCommand(merged);
  const serialized = JSON.stringify(envelope);

  assert.equal(envelope.status, "ok");
  assert.match(serialized, /"source":"user"/);
  assert.match(serialized, /"id":"test"/);
  assert.doesNotMatch(serialized, /secret-command|TOKEN_VALUE|--token/);
});

test("parses the config explain action deterministically", () => {
  const args = parseArgs(["config", "explain", "--json"]);
  assert.equal(args.command, "config");
  assert.equal(args.action, "explain");
  assert.equal(args.json, true);
});
