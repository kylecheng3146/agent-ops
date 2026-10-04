import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { aggregateAcceptanceRun } from "../../runtime/src/verify/acceptance-protocol.js";
import { collectJestAcceptance } from "../../runtime/src/verify/adapters/jest.js";
import { collectNodeAcceptance } from "../../runtime/src/verify/adapters/node.js";
import { collectPytestAcceptance } from "../../runtime/src/verify/adapters/pytest.js";
import { collectRustAcceptance } from "../../runtime/src/verify/adapters/rust.js";
import { collectVitestAcceptance } from "../../runtime/src/verify/adapters/vitest.js";

const OPTIONS = {
  executionId: "fixture-execution",
  frameworkVersion: "22.16.0",
  phase: "candidate" as const
};

async function fixture(path: string): Promise<string> {
  return readFile(resolve("tests/fixtures/acceptance", path), "utf8");
}

test("Node adapter maps pass, assertion red, and fixture failure distinctly", async () => {
  const pass = collectNodeAcceptance(await fixture("node/pass.jsonl"), {
    ...OPTIONS,
    frameworkVersion: "22.16.0"
  });
  assert.equal(
    aggregateAcceptanceRun(pass, ["tests/session-start.test.js::SessionStart::writes once"]).status,
    "PASS"
  );
  const failed = collectNodeAcceptance(await fixture("node/fail.jsonl"), OPTIONS);
  assert.equal(
    aggregateAcceptanceRun(failed, ["tests/session-start.test.js::SessionStart::writes once"]).status,
    "FAIL"
  );
  const fixtureFailure = collectNodeAcceptance(await fixture("node/fixture-error.jsonl"), OPTIONS);
  assert.equal(
    aggregateAcceptanceRun(fixtureFailure, ["tests/session-start.test.js::SessionStart::writes once"]).status,
    "UNKNOWN"
  );
});

test("Node adapter consumes an actual node:test run stream", async () => {
  const output = execFileSync(
    process.execPath,
    [resolve("tests/fixtures/acceptance/node/stream-runner.mjs")],
    {
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")
      )
    }
  );
  const events = output.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as unknown);
  const collected = collectNodeAcceptance(events, {
    ...OPTIONS,
    frameworkVersion: process.version
  });
  assert.equal(collected.completed, true);
  assert.equal(
    aggregateAcceptanceRun(collected, [
      `${resolve("tests/fixtures/acceptance/node/stream-probe.test.mjs")}::stream pass::@4:1`,
      `${resolve("tests/fixtures/acceptance/node/stream-probe.test.mjs")}::stream assertion::@5:1`
    ]).status,
    "FAIL"
  );
});

test("Node locations disambiguate nested same-name checks", async () => {
  const collected = collectNodeAcceptance(await fixture("node/nested-same-name.jsonl"), {
    ...OPTIONS,
    frameworkVersion: "22.16.0"
  });
  assert.equal(
    aggregateAcceptanceRun(collected, [
      "tests/nested.test.js::same::@3:10",
      "tests/nested.test.js::same::@4:10"
    ]).status,
    "PASS"
  );
});

test("Jest and Vitest adapters preserve stable assertion identities", async () => {
  const jestReport = JSON.parse(await fixture("jest/report.json")) as unknown;
  const jest = collectJestAcceptance(jestReport, { ...OPTIONS, frameworkVersion: "29" });
  const passId = "tests/example.test.ts::session::writes once";
  const failId = "tests/example.test.ts::session::rejects duplicate";
  const jestPass = collectJestAcceptance({
    testResults: [{
      testFilePath: "tests/example.test.ts",
      assertionResults: [{ ancestorTitles: ["session"], title: "writes once", status: "passed", attempts: 1 }]
    }]
  }, { ...OPTIONS, frameworkVersion: "29" });
  assert.equal(aggregateAcceptanceRun(jestPass, [passId]).status, "PASS");
  assert.equal(aggregateAcceptanceRun(jest, [passId, failId]).status, "FAIL");
  const retriedJest = collectJestAcceptance({
    testResults: [{
      testFilePath: "tests/example.test.ts",
      assertionResults: [{ title: "retried", status: "passed", invocations: 2, retryReasons: ["first attempt"] }]
    }]
  }, { ...OPTIONS, frameworkVersion: "29" });
  assert.equal(aggregateAcceptanceRun(retriedJest, ["tests/example.test.ts::retried"]).status, "UNKNOWN");

  const vitestReport = JSON.parse(await fixture("vitest/report.json")) as unknown;
  const vitest = collectVitestAcceptance(vitestReport, { ...OPTIONS, frameworkVersion: "1" });
  const vitestPass = collectVitestAcceptance({
    testResults: [{
      testFilePath: "tests/example.test.ts",
      assertionResults: [{ ancestorTitles: ["session"], title: "writes once", status: "passed", attempts: 1 }]
    }]
  }, { ...OPTIONS, frameworkVersion: "1" });
  assert.equal(aggregateAcceptanceRun(vitestPass, [passId]).status, "PASS");
  assert.equal(aggregateAcceptanceRun(vitest, [passId, "tests/example.test.ts::session::is skipped"]).status, "UNKNOWN");
  const vitestTasks = collectVitestAcceptance(JSON.parse(await fixture("vitest/tasks.json")) as unknown, {
    ...OPTIONS,
    frameworkVersion: "1"
  });
  assert.equal(
    aggregateAcceptanceRun(vitestTasks, [
      "tests/parameterized.test.ts::session::writes once [1]",
      "tests/parameterized.test.ts::session::writes once [2]"
    ]).status,
    "PASS"
  );
  const vitestEvents = collectVitestAcceptance([
    { type: "test-end", file: "tests/event.test.ts", name: "event pass", status: "pass", attempts: 1 },
    { type: "finished", completed: true }
  ], { ...OPTIONS, frameworkVersion: "1" });
  assert.equal(aggregateAcceptanceRun(vitestEvents, ["tests/event.test.ts::event pass"]).status, "PASS");
});

test("pytest hook collector distinguishes call assertions from lifecycle failures", async () => {
  const collected = collectPytestAcceptance(await fixture("pytest/events.jsonl"), {
    ...OPTIONS,
    frameworkVersion: "8"
  });
  assert.equal(
    aggregateAcceptanceRun(collected, ["tests/test_session.py::test_writes_once"]).status,
    "PASS"
  );
  const fixtureFailure = collectPytestAcceptance([
    { type: "test-report", nodeid: "tests/test.py::test_one", phase: "setup", outcome: "failed" },
    { type: "session-finished", completed: true }
  ], { ...OPTIONS, frameworkVersion: "8" });
  assert.equal(aggregateAcceptanceRun(fixtureFailure, ["tests/test.py::test_one"]).status, "UNKNOWN");
  const xfailed = collectPytestAcceptance([
    { type: "test-report", nodeid: "tests/test.py::test_xfail", phase: "call", outcome: "passed", wasxfail: "known issue" },
    { type: "session-finished", completed: true }
  ], { ...OPTIONS, frameworkVersion: "8" });
  assert.equal(aggregateAcceptanceRun(xfailed, ["tests/test.py::test_xfail"]).status, "UNKNOWN");
});

test("Rust stdlib harness fixtures emit real protocol pass and assertion red", async () => {
  const pass = collectRustAcceptance(await fixture("rust/pass.jsonl"), OPTIONS);
  const fail = collectRustAcceptance(await fixture("rust/fail.jsonl"), OPTIONS);
  assert.equal(aggregateAcceptanceRun(pass, ["acceptance::assertion"]).status, "PASS");
  assert.equal(aggregateAcceptanceRun(fail, ["acceptance::assertion"]).status, "FAIL");
  const unsupported = collectRustAcceptance(
    "running 1 test\ntest acceptance::assertion ... ok\n",
    OPTIONS
  );
  assert.equal(aggregateAcceptanceRun(unsupported, ["acceptance::assertion"]).status, "UNKNOWN");

  const source = await fixture("rust/acceptance_harness.rs");
  assert.match(source, /std::env/u);
  assert.match(source, /assertion_should_pass/u);
  if (spawnSync("rustc", ["--version"], { encoding: "utf8" }).status !== 0) return;

  const root = await mkdtemp(join(tmpdir(), "agent-ops-rust-adapter-"));
  try {
    const sourcePath = resolve("tests/fixtures/acceptance/rust/acceptance_harness.rs");
    const binary = join(root, "acceptance-harness");
    execFileSync("rustc", [sourcePath, "-O", "-o", binary], { encoding: "utf8" });
    const output = execFileSync(binary, [], { encoding: "utf8" });
    assert.equal(
      aggregateAcceptanceRun(collectRustAcceptance(output, OPTIONS), ["acceptance::assertion"]).status,
      "PASS"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
