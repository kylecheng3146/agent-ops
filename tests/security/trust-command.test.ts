import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import {
  runTrustCommand
} from "../../packages/cli/src/commands/trust.js";
import type {
  TrustBinding,
  TrustStatusResult,
  TrustStore
} from "../../runtime/src/security/trust.js";

const BINDING: TrustBinding = {
  canonicalPath: "/project",
  remoteIdentity: "example.com/owner/repository",
  configHash: "a".repeat(64),
  runtimeHash: "b".repeat(64)
};

function fakeStore(events: string[]): TrustStore {
  return {
    status: async (): Promise<TrustStatusResult> => ({
      status: "UNTRUSTED",
      mismatchedFields: []
    }),
    grant: async () => {
      events.push("grant");
    },
    revoke: async () => {
      events.push("revoke");
      return false;
    }
  };
}

test("non-interactive grant requires its dedicated --yes action", async () => {
  const events: string[] = [];
  const result = await runTrustCommand({
    action: "grant",
    yes: false,
    isTTY: false,
    calculateBinding: async () => BINDING,
    presentBinding: async (binding) => {
      assert.deepEqual(binding, BINDING);
      events.push("present");
    },
    confirmGrant: async () => true,
    store: fakeStore(events)
  });

  assert.equal(result.status, "error");
  assert.equal(result.code, "TRUST_CONFIRMATION_REQUIRED");
  assert.deepEqual(result.data?.binding, BINDING);
  assert.deepEqual(events, ["present"]);
});

test("grant presents the complete binding before recording it", async () => {
  const events: string[] = [];
  const result = await runTrustCommand({
    action: "grant",
    yes: true,
    isTTY: false,
    calculateBinding: async () => BINDING,
    presentBinding: async () => {
      events.push("present");
    },
    confirmGrant: async () => false,
    store: fakeStore(events)
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.data?.binding, BINDING);
  assert.deepEqual(events, ["present", "grant"]);
});

test("status and revoke use only the explicitly calculated binding", async () => {
  const statusEvents: string[] = [];
  const status = await runTrustCommand({
    action: "status",
    yes: false,
    isTTY: false,
    calculateBinding: async () => BINDING,
    presentBinding: async () => undefined,
    confirmGrant: async () => false,
    store: fakeStore(statusEvents)
  });
  assert.equal(status.code, "TRUST_STATUS");

  const revokeEvents: string[] = [];
  const revoke = await runTrustCommand({
    action: "revoke",
    yes: false,
    isTTY: false,
    calculateBinding: async () => BINDING,
    presentBinding: async () => undefined,
    confirmGrant: async () => false,
    store: fakeStore(revokeEvents)
  });
  assert.equal(revoke.code, "TRUST_REVOKED");
  assert.deepEqual(revokeEvents, ["revoke"]);
});

test("parses only explicit trust lifecycle actions", () => {
  const grant = parseArgs(["trust", "grant", "--yes", "--json"]);
  assert.equal(grant.command, "trust");
  assert.equal(grant.action, "grant");
  assert.equal(grant.yes, true);
  assert.throws(
    () => parseArgs(["trust", "--yes"]),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "CLI_ACTION_REQUIRED"
  );
  assert.throws(() => parseArgs(["init", "grant", "--yes"]));
});
