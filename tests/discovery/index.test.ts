import assert from "node:assert/strict";
import test from "node:test";

import { discoverProject } from "../../runtime/src/discovery/index.js";
import type {
  DiscoveryAdapter,
  DiscoveryResult,
  VerifierProposal
} from "../../runtime/src/discovery/types.js";

function proposal(id: string): VerifierProposal {
  return {
    id,
    command: id,
    args: ["test"],
    cwd: ".",
    required: true,
    evidence: { kind: "test-count", minimum: 1 },
    sourceEvidence: [
      { kind: "file", path: `${id}.manifest`, detail: "fixture" }
    ],
    confidence: "high",
    confirmed: false
  };
}

function fakeAdapter(
  id: string,
  result: DiscoveryResult,
  calls: string[]
): DiscoveryAdapter {
  return {
    id,
    discover: async () => {
      calls.push(id);
      return result;
    }
  };
}

test("aggregates every matching adapter without dropping decisions", async () => {
  const calls: string[] = [];
  const result = await discoverProject("/project", [
    fakeAdapter(
      "node",
      {
        kind: "proposals",
        adapter: "node",
        proposals: [proposal("node:test")],
        evidence: [],
        manualConfigAllowed: true
      },
      calls
    ),
    fakeAdapter(
      "python",
      {
        kind: "proposals",
        adapter: "python",
        proposals: [proposal("python:test")],
        evidence: [],
        manualConfigAllowed: true
      },
      calls
    ),
    fakeAdapter(
      "make",
      {
        kind: "user-decision",
        adapter: "make",
        reason: "no-known-commands",
        message: "Select a Make target.",
        evidence: [],
        manualConfigAllowed: true
      },
      calls
    )
  ]);

  assert.deepEqual(calls, ["node", "python", "make"]);
  assert.equal(result.kind, "project");
  if (result.kind !== "project") {
    return;
  }
  assert.deepEqual(result.adapters, ["node", "python", "make"]);
  assert.deepEqual(
    result.proposals.map((candidate) => candidate.id),
    ["node:test", "python:test"]
  );
  assert.deepEqual(
    result.decisions.map((decision) => decision.adapter),
    ["make"]
  );
  assert.ok(
    result.proposals.every((candidate) => candidate.confirmed === false)
  );
});
