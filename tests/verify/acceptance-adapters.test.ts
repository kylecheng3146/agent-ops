import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

const nodeReporter = fileURLToPath(new URL("../../runtime/src/verify/adapters/node-reporter.js", import.meta.url));
function nativeNode(name: string, exitCode: number) {
  const execution = spawnSync(process.execPath, ["--test", `--test-reporter=${nodeReporter}`,
    resolve(`tests/fixtures/acceptance/node/${name}.test.mjs`)], {
    encoding: "utf8", timeout: 10000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"))
  });
  assert.equal(execution.error, undefined);
  assert.equal(execution.status, exitCode, execution.stderr);
  return collectNodeAcceptance(execution.stdout, { ...OPTIONS, frameworkVersion: process.version });
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
    [resolve("tests/fixtures/acceptance/node/stream-runner.mjs"), nodeReporter],
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

test("Node product reporter preserves native assertion failures through the CLI", () => {
  const collected = nativeNode("stream-probe", 1);
  assert.equal(aggregateAcceptanceRun(collected, [
    `${resolve("tests/fixtures/acceptance/node/stream-probe.test.mjs")}::stream pass::@4:1`,
    `${resolve("tests/fixtures/acceptance/node/stream-probe.test.mjs")}::stream assertion::@5:1`
  ]).status, "FAIL");
});

test("Node native concurrent suites preserve lineage and never emit suite checks", () => {
  const collected = nativeNode("nested-probe", 0);
  const file = resolve("tests/fixtures/acceptance/node/nested-probe.test.mjs");
  assert.equal(aggregateAcceptanceRun(collected, [
    `${file}::outer::left::same::@7:5`, `${file}::outer::left::same::@8:5`,
    `${file}::outer::right::same::@12:5`, `${file}::outer::left::shared::@18:3`,
    `${file}::outer::right::shared::@18:3`
  ]).status, "PASS");
  assert.equal(collected.results.length, 5);
});

test("Node hook assertions and native timeout never establish behavioral red", () => {
  const collected = nativeNode("lifecycle-probe", 1);
  assert.equal(collected.results.length, 5);
  assert.ok(collected.results.every(result => result.status === "UNKNOWN"));
  assert.deepEqual(collected.results.map(result => result.failureClass).sort(), ["hook-error", "hook-error", "skipped", "timeout", "todo"]);
});

test("Node malformed, incomplete, duplicate and fixture assertion output fail closed", async () => {
  for (const name of ["malformed", "incomplete"]) {
    const source = await fixture(`node/${name}.jsonl`);
    assert.equal(aggregateAcceptanceRun(collectNodeAcceptance(source, OPTIONS), ["test.js::check"]).status, "UNKNOWN");
  }
  const pass = {type: "test:pass", data: {file: "test.js", name: "check"}};
  const end = {type: "test:plan", data: {nesting: 0, count: 1}};
  for (const invalid of [{}, {type: "test:summary", data: {success: false}}]) {
    assert.equal(aggregateAcceptanceRun(collectNodeAcceptance([pass, invalid, end], OPTIONS), ["test.js::check"]).status, "UNKNOWN");
  }
  const duplicate = aggregateAcceptanceRun(collectNodeAcceptance([pass, pass, end], OPTIONS), ["test.js::check"]);
  assert.equal(duplicate.status, "UNKNOWN");
  assert.equal(duplicate.failureClass, "duplicate-check");
  assert.ok(duplicate.results.every(result => result.status === "UNKNOWN"));
  const executionCompleteOnly = collectNodeAcceptance([{type: "test:complete", data: {
    file: "test.js", name: "check", nesting: 0, details: {type: "test", passed: true}
  }}, end], OPTIONS);
  assert.equal(aggregateAcceptanceRun(executionCompleteOnly, ["test.js::check"]).status, "UNKNOWN");
  for (const kind of ["hook", "fixture", "suite", "root", "collection"]) {
    for (const type of ["test:pass", "test:fail"]) {
      const lifecycle = collectNodeAcceptance([{type, data: {
        file: "test.js", name: "check", kind, error: {name: "AssertionError", code: "ERR_ASSERTION"}
      }}, end], OPTIONS);
      assert.equal(aggregateAcceptanceRun(lifecycle, ["test.js::check"]).status, "UNKNOWN", kind);
    }
  }
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
