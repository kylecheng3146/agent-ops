import {
  parseJsonDocument,
  parseJsonLines,
  stableCheckId,
  type AcceptanceRun
} from "../acceptance-protocol.js";
import {
  array,
  hasRetry,
  lower,
  number,
  object,
  result,
  run,
  string,
  type AcceptanceAdapterOptions
} from "./shared.js";

export interface JestAcceptanceOptions extends AcceptanceAdapterOptions {}

function reportFromInput(input: unknown): {
  readonly report: Record<string, unknown> | undefined;
  readonly diagnostics: readonly string[];
} {
  if (typeof input === "string") {
    const document = parseJsonDocument(input);
    if (object(document) !== undefined) return { report: object(document), diagnostics: [] };
    const lines = parseJsonLines(input);
    if (lines.values.length === 1 && object(lines.values[0]) !== undefined) {
      return { report: object(lines.values[0]), diagnostics: lines.invalidLines.map((line) => `invalid-json-line:${line}`) };
    }
    return { report: undefined, diagnostics: ["malformed-output", ...lines.invalidLines.map((line) => `invalid-json-line:${line}`)] };
  }
  return object(input) === undefined
    ? { report: undefined, diagnostics: ["malformed-report"] }
    : { report: object(input), diagnostics: [] };
}

function suiteResults(suite: Record<string, unknown>): readonly unknown[] {
  return array(suite.assertionResults) ?? array(suite.assertions) ?? array(suite.tests) ?? [];
}

function suiteFile(suite: Record<string, unknown>): string {
  return string(suite.testFilePath ?? suite.filePath ?? suite.file ?? suite.name) ?? "<jest-suite>";
}

function assertionId(suite: Record<string, unknown>, assertion: Record<string, unknown>): string | undefined {
  const ancestors = array(assertion.ancestorTitles)
    ?.filter((item): item is string => typeof item === "string") ?? [];
  // Jest's fullName already contains ancestorTitles; prefer the leaf title so
  // real JSON reports and reporter events share one identity format.
  const name = string(assertion.title ?? assertion.name) ??
    (ancestors.length === 0 ? string(assertion.fullName) : undefined);
  if (name === undefined) return undefined;
  const location = object(assertion.location);
  const line = number(location?.line);
  const column = number(location?.column);
  try {
    return stableCheckId([
      suiteFile(suite),
      ...ancestors,
      name,
      ...(line === undefined || column === undefined ? [] : [`@${line}:${column}`])
    ]);
  } catch {
    return undefined;
  }
}

function infrastructure(suite: Record<string, unknown>, report: Record<string, unknown>): boolean {
  const present = (value: unknown): boolean => value !== undefined && value !== null &&
    (!Array.isArray(value) || value.length > 0);
  if (present(suite.testExecError) || present(suite.runtimeError) ||
      present(report.runExecError) || report.wasInterrupted === true) return true;
  const runtimeSuites = number(report.numRuntimeErrorTestSuites);
  return runtimeSuites !== undefined && runtimeSuites > 0;
}

function evidence(suite: Record<string, unknown>, id: string): string[] {
  const file = suiteFile(suite);
  return [`jest:assertion:${file}:${id}`];
}

/** Collect a final Jest JSON report or an equivalent structured reporter document. */
export function collectJestAcceptance(
  input: unknown,
  options: JestAcceptanceOptions
): AcceptanceRun {
  const parsed = reportFromInput(input);
  const report = parsed.report;
  if (report === undefined) {
    return run(options, "jest", [], false, [], parsed.diagnostics);
  }
  const suites = array(report.testResults) ?? array(report.testFiles) ?? array(report.files);
  if (suites === undefined) {
    return run(options, "jest", [], false, [], [
      ...parsed.diagnostics,
      "missing-test-results"
    ]);
  }
  const results = [] as ReturnType<typeof result>[];
  const diagnostics = [...parsed.diagnostics];
  for (const rawSuite of suites) {
    const suite = object(rawSuite);
    if (suite === undefined) {
      diagnostics.push("malformed-suite");
      continue;
    }
    const suiteHasInfrastructure = infrastructure(suite, report);
    const assertions = suiteResults(suite);
    if (assertions.length === 0 && suiteHasInfrastructure) {
      diagnostics.push(`suite-infrastructure:${suiteFile(suite)}`);
    }
    for (const rawAssertion of assertions) {
      const assertion = object(rawAssertion);
      if (assertion === undefined) {
        diagnostics.push(`malformed-assertion:${suiteFile(suite)}`);
        continue;
      }
      const id = assertionId(suite, assertion);
      if (id === undefined) {
        diagnostics.push(`missing-check-id:${suiteFile(suite)}`);
        continue;
      }
      const status = lower(assertion.status ?? assertion.state);
      const attemptCount = number(assertion.attempts) ?? (hasRetry(assertion) ? 2 : 1);
      const evidenceRefs = evidence(suite, id);
      if (hasRetry(assertion)) {
        results.push(result(options, "jest", id, "UNKNOWN", evidenceRefs, "retry", attemptCount));
      } else if (suiteHasInfrastructure) {
        results.push(result(options, "jest", id, "UNKNOWN", evidenceRefs, "infrastructure-error", attemptCount));
      } else if (status === "passed" || status === "pass") {
        results.push(result(options, "jest", id, "PASS", evidenceRefs, "none", attemptCount));
      } else if (status === "failed" || status === "fail") {
        results.push(result(options, "jest", id, "FAIL", evidenceRefs, "assertion-failed", attemptCount));
      } else if (status === "pending" || status === "todo" || status === "skipped" || status === "disabled") {
        results.push(result(options, "jest", id, "UNKNOWN", evidenceRefs, status === "todo" ? "todo" : "skipped", attemptCount));
      } else {
        results.push(result(options, "jest", id, "UNKNOWN", evidenceRefs, "malformed-output", attemptCount));
      }
    }
  }
  const completed = report.completed !== false && report.interrupted !== true;
  return run(options, "jest", results, completed, completed ? ["jest:report:complete"] : [], diagnostics);
}
