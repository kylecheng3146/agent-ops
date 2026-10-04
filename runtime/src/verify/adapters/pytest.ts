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
  terminal,
  terminalEvidence,
  type AcceptanceAdapterOptions
} from "./shared.js";

export interface PytestAcceptanceOptions extends AcceptanceAdapterOptions {}

interface PhaseRecord {
  readonly phase: string;
  readonly outcome: string | undefined;
  readonly assertion: boolean;
  readonly xfail: boolean;
  readonly retry: boolean;
  readonly attempts: number | null;
  readonly evidence: string;
  readonly infrastructure: boolean;
}

function inputEvents(input: unknown): {
  readonly events: readonly unknown[];
  readonly diagnostics: readonly string[];
  readonly finalReport: boolean;
} {
  if (Array.isArray(input)) return { events: input, diagnostics: [], finalReport: false };
  if (typeof input !== "string") {
    const value = object(input);
    if (value === undefined) return { events: [], diagnostics: ["malformed-output"], finalReport: false };
    return { events: [value], diagnostics: [], finalReport: Array.isArray(value.tests) };
  }
  const document = parseJsonDocument(input);
  if (Array.isArray(document)) return { events: document, diagnostics: [], finalReport: false };
  if (object(document) !== undefined) {
    const value = object(document)!;
    return { events: [value], diagnostics: [], finalReport: Array.isArray(value.tests) };
  }
  const lines = parseJsonLines(input);
  return {
    events: lines.values,
    diagnostics: lines.invalidLines.map((line) => `invalid-json-line:${line}`),
    finalReport: false
  };
}

function eventType(value: Record<string, unknown>): string | undefined {
  return lower(value.type ?? value.event ?? value.kind);
}

function nodeId(value: Record<string, unknown>): string | undefined {
  return string(value.nodeid ?? value.nodeId ?? value.testId ?? value.name ?? value.title);
}

function phaseValue(value: Record<string, unknown>): Record<string, unknown> | undefined {
  return object(value.report) ?? object(value.result) ?? value;
}

function phaseName(value: Record<string, unknown>): string {
  return lower(value.when ?? value.phase ?? value.stage) ?? "call";
}

function outcome(value: Record<string, unknown>): string | undefined {
  return lower(value.outcome ?? value.status ?? value.state);
}

function assertionFailure(value: Record<string, unknown>): boolean {
  if (value.assertion === true || value.isAssertion === true) return true;
  const type = lower(value.errorType ?? value.exceptionType ?? value.errorName);
  return type === "assertionerror" || type === "assertion-error";
}

function addRecord(
  grouped: Map<string, PhaseRecord[]>,
  raw: Record<string, unknown>,
  diagnostics: string[]
): void {
  const id = nodeId(raw);
  if (id === undefined) {
    diagnostics.push("missing-check-id");
    return;
  }
  let stable: string;
  try {
    stable = stableCheckId([id]);
  } catch {
    diagnostics.push("missing-check-id");
    return;
  }
  const phase = phaseValue(raw) ?? raw;
  const evidenceId = string(raw.id ?? raw.reportId ?? raw.nodeid ?? raw.nodeId) ?? stable;
  const list = grouped.get(stable) ?? [];
  list.push({
    phase: phaseName(phase),
    outcome: outcome(phase),
    assertion: assertionFailure(phase),
    xfail: phase.wasxfail === true ||
      (typeof phase.wasxfail === "string" && phase.wasxfail.length > 0) ||
      phase.xfail === true || outcome(phase) === "xfailed" || outcome(phase) === "xpassed",
    retry: hasRetry(raw) || hasRetry(phase),
    attempts: number(raw.attempts ?? phase.attempts) ?? 1,
    evidence: `pytest:${stable}:${evidenceId}`,
    infrastructure: (phase.error !== undefined && phase.error !== null) ||
      (phase.crash !== undefined && phase.crash !== null && phase.crash !== false)
  });
  grouped.set(stable, list);
}

function appendReportTests(
  report: Record<string, unknown>,
  grouped: Map<string, PhaseRecord[]>,
  diagnostics: string[]
): void {
  const tests = array(report.tests) ?? [];
  for (const raw of tests) {
    const test = object(raw);
    if (test === undefined) {
      diagnostics.push("malformed-test");
      continue;
    }
    const call = object(test.call);
    const setup = object(test.setup);
    const teardown = object(test.teardown);
    if (setup !== undefined) addRecord(grouped, { ...test, ...setup, phase: "setup" }, diagnostics);
    if (call !== undefined) addRecord(grouped, { ...test, ...call, phase: "call" }, diagnostics);
    else addRecord(grouped, test, diagnostics);
    if (teardown !== undefined) addRecord(grouped, { ...test, ...teardown, phase: "teardown" }, diagnostics);
  }
}

/** Collect a structured pytest hook stream or pytest-json-report-like document. */
export function collectPytestAcceptance(
  input: unknown,
  options: PytestAcceptanceOptions
): AcceptanceRun {
  const parsed = inputEvents(input);
  const grouped = new Map<string, PhaseRecord[]>();
  const diagnostics = [...parsed.diagnostics];
  let completed = parsed.finalReport;
  let completionEvidence: string[] = parsed.finalReport ? ["pytest:report:complete"] : [];
  for (const raw of parsed.events) {
    const value = object(raw);
    if (value === undefined) {
      diagnostics.push("malformed-event");
      continue;
    }
    if (Array.isArray(value.tests)) {
      appendReportTests(value, grouped, diagnostics);
      if (value.completed !== false && value.interrupted !== true) {
        completed = true;
        completionEvidence = ["pytest:report:complete"];
      }
      continue;
    }
    const type = eventType(value);
    if (terminal(value) || type === "session-finished" || type === "session-finish") {
      completed = true;
      completionEvidence = [terminalEvidence(value, options.executionId)];
      continue;
    }
    if (type === "session-error" || type === "internal-error" || type === "collection-error") {
      diagnostics.push(`pytest:${type}`);
      continue;
    }
    if (type === undefined || type === "test-report" || type === "runtest" || type === "test") {
      addRecord(grouped, value, diagnostics);
      continue;
    }
    diagnostics.push(`unsupported-event:${type}`);
  }

  const results = [] as ReturnType<typeof result>[];
  for (const [id, records] of grouped.entries()) {
    const refs = records.map((record) => record.evidence);
    const attemptsCount = records.reduce<number | null>((max, record) => {
      if (max === null || record.attempts === null) return null;
      return Math.max(max, record.attempts);
    }, 1);
    if (records.some((record) => record.retry) || records.length > 3) {
      results.push(result(options, "pytest", id, "UNKNOWN", refs, "retry", attemptsCount === null ? null : Math.max(attemptsCount, 2)));
      continue;
    }
    const setupOrTeardownFailure = records.some((record) =>
      (record.phase === "setup" || record.phase === "teardown") &&
      record.outcome !== undefined && record.outcome !== "passed" && record.outcome !== "pass"
    );
    if (setupOrTeardownFailure || records.some((record) => record.infrastructure)) {
      results.push(result(options, "pytest", id, "UNKNOWN", refs, "fixture-error", attemptsCount));
      continue;
    }
    const call = records.find((record) => record.phase === "call") ?? records[0];
    if (call === undefined) {
      results.push(result(options, "pytest", id, "UNKNOWN", refs, "incomplete-output", null));
      continue;
    }
    if (call.xfail) {
      results.push(result(options, "pytest", id, "UNKNOWN", refs, "xfail", attemptsCount));
    } else if (call.outcome === "passed" || call.outcome === "pass") {
      results.push(result(options, "pytest", id, "PASS", refs, "none", attemptsCount));
    } else if (call.outcome === "failed" || call.outcome === "fail") {
      results.push(call.assertion
        ? result(options, "pytest", id, "FAIL", refs, "assertion-failed", attemptsCount)
        : result(options, "pytest", id, "UNKNOWN", refs, "infrastructure-error", attemptsCount));
    } else if (call.outcome === "skipped" || call.outcome === "skip") {
      results.push(result(options, "pytest", id, "UNKNOWN", refs, "skipped", attemptsCount));
    } else if (call.outcome === "xfailed" || call.outcome === "xpassed") {
      results.push(result(options, "pytest", id, "UNKNOWN", refs, "xfail", attemptsCount));
    } else {
      results.push(result(options, "pytest", id, "UNKNOWN", refs, "incomplete-output", attemptsCount));
    }
  }
  return run(options, "pytest", results, completed, completionEvidence, diagnostics);
}
