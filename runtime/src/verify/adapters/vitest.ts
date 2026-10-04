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

function eventInput(input: unknown): readonly unknown[] | undefined {
  if (Array.isArray(input)) return input;
  if (typeof input !== "string") return undefined;
  const document = parseJsonDocument(input);
  if (Array.isArray(document)) return document;
  const lines = parseJsonLines(input);
  if (lines.values.length === 1 && Array.isArray(lines.values[0])) return lines.values[0] as readonly unknown[];
  return lines.values.length > 0 ? lines.values : undefined;
}

function flattenTasks(
  tasks: readonly unknown[],
  file: string,
  ancestors: readonly string[],
  assertions: Record<string, unknown>[]
): void {
  for (const raw of tasks) {
    const task = object(raw);
    if (task === undefined) continue;
    const name = string(task.name ?? task.title);
    const nextAncestors = name === undefined ? ancestors : [...ancestors, name];
    const children = array(task.tasks ?? task.children);
    if (children !== undefined && children.length > 0) {
      flattenTasks(children, file, nextAncestors, assertions);
      continue;
    }
    const state = object(task.result) ?? object(task.state);
    const status = state === undefined ? task.status ?? task.state : state.state ?? state.status;
    const retryValue = state === undefined ? task.retry ?? task.retries : state.retry ?? state.retries;
    assertions.push({
      name: name ?? string(task.id) ?? "<vitest-check>",
      ancestorTitles: ancestors,
      status,
      attempts: number(task.attempts ?? retryValue),
      retry: hasRetry(task) || (typeof retryValue === "number" && retryValue > 0),
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
  const suites: Record<string, unknown>[] = [];
  for (const rawFile of files) {
    const file = object(rawFile);
    if (file === undefined) continue;
    const assertions: Record<string, unknown>[] = [];
    const tasks = array(file.tasks ?? file.children);
    if (tasks !== undefined) {
      flattenTasks(tasks, string(file.filepath ?? file.file ?? file.name) ?? "<vitest-file>", [], assertions);
    }
    suites.push({
      testFilePath: string(file.filepath ?? file.file ?? file.name) ?? "<vitest-file>",
      assertionResults: assertions,
      testExecError: file.error ?? file.hookErrors
    });
  }
  return { ...report, testResults: suites };
}

function collectEvents(events: readonly unknown[], options: VitestAcceptanceOptions): AcceptanceRun {
  const results = [] as ReturnType<typeof result>[];
  const diagnostics: string[] = [];
  let completed = false;
  let completionEvidence: string[] = [];
  for (const raw of events) {
    const value = object(raw);
    if (value === undefined) {
      diagnostics.push("malformed-event");
      continue;
    }
    const type = lower(value.type ?? value.event ?? value.kind);
    if (type === "complete" || type === "completed" || type === "finished" || value.completed === true) {
      completed = true;
      completionEvidence = [terminalEvidence(value, options.executionId)];
      continue;
    }
    if (type !== "test-end" && type !== "test:pass" && type !== "test:fail" &&
        type !== "test:skip" && type !== "test:todo" && type !== "test-result") {
      if (type !== undefined) diagnostics.push(`unsupported-event:${type}`);
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
    const attemptCount = number(value.attempts) ?? (hasRetry(value) ? 2 : 1);
    if (hasRetry(value)) {
      results.push(result(options, "vitest", id, "UNKNOWN", refs, "retry", attemptCount));
    } else if (status === "passed" || status === "pass") {
      results.push(result(options, "vitest", id, "PASS", refs, "none", attemptCount));
    } else if (status === "failed" || status === "fail") {
      results.push(result(options, "vitest", id, "FAIL", refs, "assertion-failed", attemptCount));
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
  if (events !== undefined && events.some((event) => {
    const value = object(event);
    const type = value === undefined ? undefined : lower(value.type ?? value.event ?? value.kind);
    return type !== undefined && type.startsWith("test");
  })) {
    return collectEvents(events, options);
  }
  const report = structuredReport(input);
  if (report === undefined) return run(options, "vitest", [], false, [], ["malformed-output"]);
  return mapFramework(collectJestAcceptance(report, options), options);
}
