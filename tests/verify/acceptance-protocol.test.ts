import assert from "node:assert/strict";
import test from "node:test";

import type { AgentOpsConfig, VerificationCommand } from "../../runtime/src/contracts.js";
import { validateConfig } from "../../runtime/src/schema/validate.js";
import { executeConfiguredCommand } from "../../runtime/src/verify/command-executor.js";
import { NodeVerificationProcessRunner, type ProcessRequest } from "../../runtime/src/verify/spawn.js";

import {
  ACCEPTANCE_FAILURE,
  aggregateAcceptanceRun,
  makeAcceptanceCheck,
  makeAcceptanceRun,
  type AcceptanceCheckResult
} from "../../runtime/src/verify/acceptance-protocol.js";

const OPTIONS = {
  executionId: "execution-one",
  framework: "fixture",
  frameworkVersion: "1",
  phase: "candidate" as const
};

function check(
  checkId: string,
  status: "PASS" | "FAIL" | "UNKNOWN",
  failureClass: string = status === "PASS" ? "none" : "assertion-failed",
  attempts: number | null = 1,
  evidence: readonly string[] = [`evidence:${checkId}`]
): AcceptanceCheckResult {
  return makeAcceptanceCheck({
    ...OPTIONS,
    checkId,
    status,
    failureClass,
    attempts,
    evidence
  });
}

function run(results: readonly AcceptanceCheckResult[], completed = true, diagnostics: readonly string[] = []) {
  return makeAcceptanceRun({
    ...OPTIONS,
    results,
    completed,
    completionEvidence: completed ? ["complete:1"] : [],
    diagnostics
  });
}

test("acceptance protocol passes only an exact complete set of checks", () => {
  const aggregate = aggregateAcceptanceRun(
    run([check("a", "PASS"), check("b", "PASS")]),
    ["a", "b"]
  );
  assert.equal(aggregate.status, "PASS");
  assert.equal(aggregate.failureClass, "none");
  assert.deepEqual(aggregate.missingCheckIds, []);
});

test("only an explicit assertion failure is behavioral red", () => {
  const aggregate = aggregateAcceptanceRun(
    run([check("a", "FAIL")]),
    ["a"]
  );
  assert.equal(aggregate.status, "FAIL");
  assert.equal(aggregate.failureClass, ACCEPTANCE_FAILURE.assertion);
  assert.equal(
    aggregateAcceptanceRun(
      run([check("a", "FAIL", ACCEPTANCE_FAILURE.fixture)]),
      ["a"]
    ).status,
    "UNKNOWN"
  );
});

test("missing, duplicate, retry, skipped, and incomplete evidence fail closed", () => {
  assert.equal(
    aggregateAcceptanceRun(run([check("a", "PASS")]), ["a", "b"]).status,
    "UNKNOWN"
  );
  assert.equal(
    aggregateAcceptanceRun(run([check("a", "PASS"), check("a", "PASS")]), ["a"]).failureClass,
    ACCEPTANCE_FAILURE.duplicate
  );
  assert.equal(
    aggregateAcceptanceRun(run([check("a", "PASS", "none", 2)]), ["a"]).failureClass,
    ACCEPTANCE_FAILURE.retry
  );
  assert.equal(
    aggregateAcceptanceRun(run([check("a", "UNKNOWN", ACCEPTANCE_FAILURE.skipped)]), ["a"]).status,
    "UNKNOWN"
  );
  assert.equal(
    aggregateAcceptanceRun(run([check("a", "PASS")], false), ["a"]).failureClass,
    ACCEPTANCE_FAILURE.incomplete
  );
});

test("empty evidence and adapter diagnostics cannot become PASS", () => {
  const emptyEvidence = { ...check("a", "PASS"), evidence: [] } as AcceptanceCheckResult;
  assert.equal(
    aggregateAcceptanceRun(run([emptyEvidence]), ["a"]).failureClass,
    ACCEPTANCE_FAILURE.emptyEvidence
  );
  assert.equal(
    aggregateAcceptanceRun(run([check("a", "PASS")], true, ["fixture-error"]), ["a"]).status,
    "UNKNOWN"
  );
});

test("collector outcomes preserve legacy config and real command execution contracts", async () => {
  const cases = [
    { id: "exit-pass", script: "process.exit(0)", evidence: { kind: "exit-code" }, trusted: true, status: "PASS", failureClass: "none", exitCode: 0, testCount: null },
    { id: "exit-fail", script: "process.exit(2)", evidence: { kind: "exit-code" }, trusted: true, status: "FAIL", failureClass: "nonzero-exit", exitCode: 2, testCount: null },
    { id: "count-pass", script: "console.log('# tests 2\\n# pass 2')", evidence: { kind: "test-count", minimum: 1 }, trusted: true, status: "PASS", failureClass: "none", exitCode: 0, testCount: 2 },
    { id: "count-zero", script: "console.log('# tests 0\\n# pass 0')", evidence: { kind: "test-count", minimum: 1 }, trusted: true, status: "FAIL", failureClass: "zero-tests", exitCode: 0, testCount: 0 },
    { id: "untrusted", script: "process.exit(0)", evidence: { kind: "exit-code" }, trusted: false, status: "UNKNOWN", failureClass: "repository-untrusted", exitCode: null, testCount: null }
  ] as const;
  const commands: VerificationCommand[] = cases.map(item => ({
    id: item.id, command: process.execPath, args: ["-e", item.script], cwd: ".", required: true, evidence: item.evidence
  }));
  const config: AgentOpsConfig = {
    schemaVersion: 3, profiles: ["core"], verification: { commands },
    features: { completionGate: { enabled: false }, stopVerification: { enabled: false } },
    pathMappings: [], securityExceptions: []
  };
  const original = structuredClone(config);
  assert.equal(validateConfig(config).ok, true, "legacy configuration needs no acceptance fields");
  for (const collector of [check("a", "PASS"), check("a", "FAIL"), check("a", "UNKNOWN", ACCEPTANCE_FAILURE.fixture)]) {
    assert.equal(aggregateAcceptanceRun(run([collector]), ["a"]).status, collector.status);
    for (const [index, item] of cases.entries()) {
      const calls: ProcessRequest[] = [];
      const native = new NodeVerificationProcessRunner();
      const result = await executeConfiguredCommand(commands[index]!, {
        cwd: process.cwd(), trusted: item.trusted,
        runner: { start(request) { calls.push(request); return native.start(request); } }
      });
      assert.deepEqual({ status: result.status, failureClass: result.failureClass, exitCode: result.exitCode, testCount: result.testCount },
        { status: item.status, failureClass: item.failureClass, exitCode: item.exitCode, testCount: item.testCount });
      assert.deepEqual(calls, item.trusted ? [{ command: process.execPath, args: ["-e", item.script], cwd: process.cwd(), shell: false }] : []);
    }
    assert.deepEqual(config, original, "collectors and command execution cannot mutate legacy config or argv");
  }
});
