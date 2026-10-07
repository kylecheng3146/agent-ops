import {
  makeAcceptanceCheck,
  makeAcceptanceRun,
  parseJsonDocument,
  parseJsonLines,
  stableCheckId,
  type AcceptanceRun
} from "../acceptance-protocol.js";
import { collectJestAcceptance } from "./jest.js";
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

export interface VitestAcceptanceOptions extends AcceptanceAdapterOptions {}

function mapFramework(runValue: AcceptanceRun, options: VitestAcceptanceOptions): AcceptanceRun {
  const results = runValue.results.map((item) => makeAcceptanceCheck({
    executionId: options.executionId,
    framework: "vitest",
    frameworkVersion: options.frameworkVersion,
    checkId: item.checkId,
    phase: options.phase,
    status: item.status,
    failureClass: item.failureClass,
    attempts: item.attempts,
    evidence: item.evidence.map((reference) => reference.replace(/^jest:/u, "vitest:"))
  }));
  return makeAcceptanceRun({
    executionId: options.executionId,
    framework: "vitest",
    frameworkVersion: options.frameworkVersion,
    phase: options.phase,
    results,
    completed: runValue.completed,
    completionEvidence: runValue.completionEvidence.map((reference) => reference.replace(/^jest:/u, "vitest:")),
    diagnostics: runValue.diagnostics
  });
}

function eventInput(input: unknown): {events: readonly unknown[]; diagnostics: readonly string[]} | undefined {
  if (Array.isArray(input)) return {events: input, diagnostics: []};
  if (typeof input !== "string") return undefined;
  const document = parseJsonDocument(input);
  if (Array.isArray(document)) return {events: document, diagnostics: []};
  const lines = parseJsonLines(input);
  const events = lines.values.length === 1 && Array.isArray(lines.values[0]) ? lines.values[0] : lines.values;
  return events.length > 0 ? {events, diagnostics: lines.invalidLines.map(line => `invalid-json-line:${line}`)} : undefined;
}

function flattenTasks(
  tasks: readonly unknown[],
  file: string,
  ancestors: readonly string[],
  assertions: unknown[],
  lifecycleErrors: unknown[]
): void {
  for (const raw of tasks) {
    const task = object(raw);
    if (task === undefined) { assertions.push(null); continue; }
    const name = string(task.name ?? task.title);
    const nextAncestors = name === undefined ? ancestors : [...ancestors, name];
    const children = array(task.tasks ?? task.children);
    const state = object(task.result) ?? object(task.state);
    if (children !== undefined && children.length > 0) {
      const errors = array(state?.errors);
      const hooks = object(state?.hooks ?? task.hooks);
      if (errors !== undefined && errors.length > 0) lifecycleErrors.push(...errors);
      if (task.hookErrors != null || state?.hookErrors != null ||
          (hooks !== undefined && Object.values(hooks).some(value => value !== "pass" && value !== "passed"))) {
        lifecycleErrors.push("suite-hook-error");
      }
      flattenTasks(children, file, nextAncestors, assertions, lifecycleErrors);
      continue;
    }
    if (task.type === "suite") continue;
    const status = state === undefined ? task.status ?? task.state : state.state ?? state.status;
    const retryValue = state === undefined ? task.retry ?? task.retries : state.retry ?? state.retries;
    const retryCount = number(state?.retryCount);
    const repeatCount = number(state?.repeatCount);
    // Native errors and hooks omit fixture cleanup/onTestFinished provenance.
    // Even AssertionError with passing hooks is ambiguous without classified
    // collector metadata, just as in Jest-compatible JSON.
    const assertion = task.assertion === true || state?.assertion === true || state?.failureClass === "assertion-failed";
    assertions.push({
      name,
      ancestorTitles: ancestors,
      status: task.fails === true ? "xfail" : status,
      attempts: number(task.attempts) ?? (retryCount !== undefined && repeatCount !== undefined ? retryCount + repeatCount + 1 : null),
      retry: hasRetry(task) || (state !== undefined && hasRetry(state)) || (typeof retryValue === "number" && retryValue > 0),
      assertion,
      hooks: state?.hooks ?? task.hooks,
      hookErrors: state?.hookErrors ?? task.hookErrors,
      location: task.location
    });
  }
}

function structuredReport(input: unknown): Record<string, unknown> | undefined {
  const value = typeof input === "string" ? parseJsonDocument(input) : input;
  const report = object(value);
  if (report === undefined) return undefined;
  if (array(report.testResults) !== undefined) {
    return report;
  }
  const testFiles = array(report.testFiles);
  if (testFiles !== undefined && testFiles.some((file) => {
    const value = object(file);
    return value !== undefined && array(value.assertionResults) !== undefined;
  })) {
    return { ...report, testResults: testFiles };
  }
  const files = array(report.files ?? report.testFiles);
  if (files === undefined) return undefined;
  const suites: unknown[] = [];
  for (const rawFile of files) {
    const file = object(rawFile);
    if (file === undefined) { suites.push(null); continue; }
    const assertions: unknown[] = [];
    const lifecycleErrors: unknown[] = [];
    const tasks = array(file.tasks ?? file.children);
    if (tasks !== undefined) {
      flattenTasks(tasks, string(file.filepath ?? file.file ?? file.name) ?? "<vitest-file>", [], assertions, lifecycleErrors);
    }
    suites.push({
      testFilePath: string(file.filepath ?? file.file ?? file.name) ?? "<vitest-file>",
      assertionResults: assertions,
      testExecError: file.error ?? file.hookErrors ?? object(file.result)?.errors,
      runtimeError: lifecycleErrors
    });
  }
  return { ...report, testResults: suites };
}

function collectEvents(events: readonly unknown[], options: VitestAcceptanceOptions, initialDiagnostics: readonly string[]): AcceptanceRun {
  const results = [] as ReturnType<typeof result>[];
  const diagnostics: string[] = [...initialDiagnostics];
  let completed = false;
  let completionEvidence: string[] = [];
  for (const raw of events) {
    const value = object(raw);
    if (value === undefined) {
      diagnostics.push("malformed-event");
      continue;
    }
    const type = lower(value.type ?? value.event ?? value.kind);
    if ((type === "complete" || type === "completed" || type === "finished") &&
        value.completed !== false && value.interrupted !== true) {
      completed = true;
      completionEvidence = [terminalEvidence(value, options.executionId)];
      continue;
    }
    if (type !== "test-end" && type !== "test:pass" && type !== "test:fail" &&
        type !== "test:skip" && type !== "test:todo" && type !== "test-result") {
      diagnostics.push(`unsupported-event:${type ?? "unknown"}`);
      continue;
    }
    const ancestors = array(value.ancestorTitles)?.filter((item): item is string => typeof item === "string") ?? [];
    const name = string(value.title ?? value.name) ??
      (ancestors.length === 0 ? string(value.fullName) : undefined);
    if (name === undefined) {
      diagnostics.push("missing-check-id");
      continue;
    }
    const file = string(value.file ?? value.filepath) ?? "<vitest>";
    const location = object(value.location);
    const line = number(location?.line);
    const column = number(location?.column);
    let id: string;
    try {
      id = stableCheckId([
        file,
        ...ancestors,
        name,
        ...(line === undefined || column === undefined ? [] : [`@${line}:${column}`])
      ]);
    } catch {
      diagnostics.push("missing-check-id");
      continue;
    }
    const status = lower(value.status ?? value.state ?? (type === "test:pass" ? "passed" : type === "test:fail" ? "failed" : type === "test:skip" ? "skipped" : type === "test:todo" ? "todo" : undefined));
    const refs = [`vitest:assertion:${id}`];
    const observedAttempts = number(value.attempts);
    const attemptCount = observedAttempts !== undefined && observedAttempts > 0 ? observedAttempts : null;
    const hooks = object(value.hooks);
    const hookFailure = value.hookErrors != null || (hooks !== undefined && Object.values(hooks).some(state => state !== "pass" && state !== "passed"));
    if (hasRetry(value)) {
      results.push(result(options, "vitest", id, "UNKNOWN", refs, "retry", attemptCount));
    } else if (hookFailure) {
      results.push(result(options, "vitest", id, "UNKNOWN", refs, "hook-error", attemptCount));
    } else if (status === "passed" || status === "pass") {
      results.push(result(options, "vitest", id, "PASS", refs, "none", attemptCount));
    } else if (status === "failed" || status === "fail") {
      results.push(value.assertion === true || value.failureClass === "assertion-failed"
        ? result(options, "vitest", id, "FAIL", refs, "assertion-failed", attemptCount)
        : result(options, "vitest", id, "UNKNOWN", refs, "infrastructure-error", attemptCount));
    } else if (status === "skipped" || status === "pending") {
      results.push(result(options, "vitest", id, "UNKNOWN", refs, "skipped", attemptCount));
    } else if (status === "todo") {
      results.push(result(options, "vitest", id, "UNKNOWN", refs, "todo", attemptCount));
    } else {
      results.push(result(options, "vitest", id, "UNKNOWN", refs, "malformed-output", attemptCount));
    }
  }
  return run(options, "vitest", results, completed, completionEvidence, diagnostics);
}

/** Collect Vitest reporter events or its Jest-compatible JSON output. */
export function collectVitestAcceptance(
  input: unknown,
  options: VitestAcceptanceOptions
): AcceptanceRun {
  const events = eventInput(input);
  if (events !== undefined && events.events.some((event) => {
    const value = object(event);
    const type = value === undefined ? undefined : lower(value.type ?? value.event ?? value.kind);
    return type !== undefined && type.startsWith("test");
  })) {
    return collectEvents(events.events, options, events.diagnostics);
  }
  const report = structuredReport(input);
  if (report === undefined) return run(options, "vitest", [], false, [], ["malformed-output"]);
  return mapFramework(collectJestAcceptance(report, options), options);
}
