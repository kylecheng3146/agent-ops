import assert from "node:assert/strict";
import test from "node:test";

import { runStopVerification } from "../../runtime/src/hooks/stop-verify.js";

const NOW = "2026-07-25T12:00:00.000Z";

interface FixtureOptions {
  confirmedConfig: boolean;
  trusted: boolean;
  scopeMapped: boolean;
  recursionMarker: boolean;
  configHash: string;
  now: () => string;
  verify: () => Promise<{
    status: "FAIL" | "PASS" | "UNKNOWN";
    results: {
      commandId: string;
      exitCode: number | null;
      testCount: number | null;
    }[];
  }>;
}

function eligibleOptions(): FixtureOptions {
  return {
    confirmedConfig: true,
    trusted: true,
    scopeMapped: true,
    recursionMarker: false,
    configHash: "a".repeat(64),
    now: () => NOW,
    verify: async () => ({
      status: "PASS" as const,
      results: [
        {
          commandId: "unit",
          exitCode: 0,
          testCount: 12
        }
      ]
    })
  };
}

test("Stop verification emits bounded evidence without completing a task", async () => {
  const result = await runStopVerification(eligibleOptions());

  assert.deepEqual(result, {
    action: "continue",
    status: "PASS",
    code: "STOP_VERIFICATION_FINISHED",
    evidence: {
      commandResults: [
        {
          commandId: "unit",
          exitCode: 0,
          testCount: 12
        }
      ],
      configHash: "a".repeat(64),
      timestamp: NOW
    }
  });
  assert.equal("taskCompleted" in result, false);
});

test("verifier UNKNOWN remains UNKNOWN", async () => {
  const options = eligibleOptions();
  options.verify = async () => ({
    status: "UNKNOWN",
    results: [
      {
        commandId: "unit",
        exitCode: null,
        testCount: null
      }
    ]
  });

  const result = await runStopVerification(options);

  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.evidence?.commandResults[0]?.exitCode, null);
});

test("untrusted projects never execute Stop verification", async () => {
  let calls = 0;
  const options = eligibleOptions();
  options.trusted = false;
  options.verify = async () => {
    calls += 1;
    return { status: "PASS", results: [] };
  };

  const result = await runStopVerification(options);

  assert.deepEqual(result, {
    action: "continue",
    status: "UNKNOWN",
    code: "STOP_VERIFICATION_UNTRUSTED"
  });
  assert.equal(calls, 0);
});

test("Stop recursion marker prevents verifier execution", async () => {
  let calls = 0;
  const options = eligibleOptions();
  options.recursionMarker = true;
  options.verify = async () => {
    calls += 1;
    return { status: "PASS", results: [] };
  };

  const result = await runStopVerification(options);

  assert.deepEqual(result, {
    action: "continue",
    status: "UNKNOWN",
    code: "STOP_VERIFICATION_RECURSION"
  });
  assert.equal(calls, 0);
});

test("unconfirmed config and missing scope mappings do not run commands", async () => {
  for (const key of ["confirmedConfig", "scopeMapped"] as const) {
    let calls = 0;
    const options = eligibleOptions();
    options[key] = false;
    options.verify = async () => {
      calls += 1;
      return { status: "PASS", results: [] };
    };

    const result = await runStopVerification(options);

    assert.equal(result.status, "UNKNOWN");
    assert.equal(calls, 0);
  }
});
