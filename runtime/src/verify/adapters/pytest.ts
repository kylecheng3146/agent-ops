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
} {
  if (Array.isArray(input)) return { events: input, diagnostics: [] };
  if (typeof input !== "string") {
    const value = object(input);
    if (value === undefined) return { events: [], diagnostics: ["malformed-output"] };
    return { events: [value], diagnostics: [] };
  }
  const document = parseJsonDocument(input);
  if (Array.isArray(document)) return { events: document, diagnostics: [] };
  if (object(document) !== undefined) {
    const value = object(document)!;
    return { events: [value], diagnostics: [] };
  }
  const lines = parseJsonLines(input);
  return {
    events: lines.values,
    diagnostics: lines.invalidLines.map((line) => `invalid-json-line:${line}`)
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
  return lower(value.when ?? value.phase ?? value.stage) ?? "unknown";
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
  const attemptCount = number(raw.attempts ?? phase.attempts);
  const list = grouped.get(stable) ?? [];
  list.push({
    phase: phaseName(phase),
    outcome: outcome(phase),
    assertion: assertionFailure(phase),
    xfail: phase.wasxfail === true ||
      (typeof phase.wasxfail === "string" && phase.wasxfail.length > 0) ||
      phase.xfail === true || outcome(phase) === "xfailed" || outcome(phase) === "xpassed",
    retry: hasRetry(raw) || hasRetry(phase),
    attempts: attemptCount !== undefined && attemptCount > 0 ? attemptCount : null,
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
  let completed = false;
  let completionEvidence: string[] = [];
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
    if (["session-finished", "session-finish", "complete", "completed", "finished", "run-complete"].includes(type ?? "") &&
        value.completed !== false && value.interrupted !== true) {
      completed = true;
      completionEvidence = [terminalEvidence(value, options.executionId)];
      continue;
    }
    if (type === "session-error" || type === "internal-error" || type === "collection-error") {
      diagnostics.push(`pytest:${type}`);
      continue;
    }
    if (type === "test-report" || type === "runtest" || type === "test") {
      addRecord(grouped, value, diagnostics);
      continue;
    }
    diagnostics.push(`unsupported-event:${type ?? "unknown"}`);
  }

  const results = [] as ReturnType<typeof result>[];
  for (const [id, records] of grouped.entries()) {
    const refs = records.map((record) => record.evidence);
    const attemptsCount = records.reduce<number | null>((max, record) => {
      if (max === null || record.attempts === null) return null;
      return Math.max(max, record.attempts);
    }, 1);
    if (records.some((record) => record.retry || (record.attempts !== null && record.attempts > 1))) {
      results.push(result(options, "pytest", id, "UNKNOWN", refs, "retry", attemptsCount === null ? null : Math.max(attemptsCount, 2)));
      continue;
    }
    const setupOrTeardownFailure = records.some((record) =>
      (record.phase === "setup" || record.phase === "teardown") &&
      record.outcome !== "passed" && record.outcome !== "pass"
    );
    if (setupOrTeardownFailure || records.some((record) => record.infrastructure)) {
      results.push(result(options, "pytest", id, "UNKNOWN", refs, "fixture-error", attemptsCount));
      continue;
    }
    const phases = records.map(record => record.phase);
    if (new Set(phases).size !== phases.length) {
      results.push(result(options, "pytest", id, "UNKNOWN", refs, "duplicate-check", attemptsCount));
      continue;
    }
    const call = records.find((record) => record.phase === "call");
    if (phases.join(",") !== "setup,call,teardown" || call === undefined) {
      results.push(result(options, "pytest", id, "UNKNOWN", refs, "incomplete-output", attemptsCount));
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
