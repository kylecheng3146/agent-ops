import { resolve } from "node:path";

import {
  parseJsonDocument,
  parseJsonLines,
  stableCheckId,
  type AcceptanceRun
} from "../acceptance-protocol.js";
import {
  attempts,
  hasRetry,
  lower,
  object,
  result,
  run,
  string,
  terminal,
  terminalEvidence,
  type AcceptanceAdapterOptions
} from "./shared.js";

export interface NodeAcceptanceOptions extends AcceptanceAdapterOptions {}

function eventsFromInput(input: readonly unknown[] | string): {
  readonly events: readonly unknown[];
  readonly diagnostics: readonly string[];
} {
  if (typeof input !== "string") return { events: input, diagnostics: [] };
  const document = parseJsonDocument(input);
  if (Array.isArray(document)) return { events: document, diagnostics: [] };
  const lines = parseJsonLines(input);
  if (lines.values.length > 0 || lines.invalidLines.length > 0) {
    return {
      events: lines.values,
      diagnostics: lines.invalidLines.map((line) => `invalid-json-line:${line}`)
    };
  }
  return document === undefined
    ? { events: [], diagnostics: ["malformed-output"] }
    : { events: Array.isArray(document) ? document : [document], diagnostics: [] };
}

function eventData(value: Record<string, unknown>): Record<string, unknown> {
  return object(value.data) ?? value;
}

function eventType(value: Record<string, unknown>): string | undefined {
  return lower(value.type ?? value.event ?? value.kind);
}

function checkId(data: Record<string, unknown>): string | undefined {
  const file = string(data.file ?? data.filePath ?? data.filename);
  const ancestors = Array.isArray(data.ancestorNames)
    ? data.ancestorNames.filter((item): item is string => typeof item === "string")
    : Array.isArray(data.nesting)
      ? data.nesting.filter((item): item is string => typeof item === "string")
      : Array.isArray(data.ancestorTitles)
        ? data.ancestorTitles.filter((item): item is string => typeof item === "string")
        : [];
  const name = string(data.name ?? data.title ?? data.fullName);
  if (name === undefined) return undefined;
  const line = typeof data.line === "number" && Number.isSafeInteger(data.line) ? data.line : undefined;
  const column = typeof data.column === "number" && Number.isSafeInteger(data.column) ? data.column : undefined;
  try {
    return stableCheckId([
      file ?? "<node-test>",
      ...ancestors,
      name,
      ...(line === undefined || column === undefined ? [] : [`@${line}:${column}`])
    ]);
  } catch {
    return undefined;
  }
}

function assertionFailure(data: Record<string, unknown>): boolean {
  if (nonAssertionFailure(data) !== undefined) return false;
  if (data.assertion === true || data.isAssertion === true) return true;
  const explicit = lower(data.failureClass ?? data.failureKind ?? data.errorType);
  if (explicit === "assertion" || explicit === "assertion-failed" || explicit === "test-assertion") {
    return true;
  }
  const details = object(data.details);
  const error = object(data.error) ?? object(details?.error);
  const cause = object(error?.cause);
  const errorName = lower(error?.name ?? error?.type);
  const errorCode = lower(error?.code);
  const causeName = lower(cause?.name ?? cause?.type);
  const causeCode = lower(cause?.code);
  return errorName === "assertionerror" || errorCode === "err_assertion" ||
    causeName === "assertionerror" || causeCode === "err_assertion";
}

function nonAssertionFailure(data: Record<string, unknown>): string | undefined {
  const details = object(data.details);
  const kind = lower(data.kind ?? data.scope ?? data.type ?? details?.type);
  if (kind === "hook") return "hook-error";
  if (kind === "fixture") return "fixture-error";
  if (kind === "collection" || kind === "root" || kind === "suite") return "collection-error";
  if (data.timeout === true) return "timeout";
  const error = object(data.error) ?? object(details?.error);
  const nativeFailure = lower(error?.failureType);
  if (nativeFailure === "hookfailed") return "hook-error";
  if (nativeFailure === "testtimeoutfailure") return "timeout";
  if (nativeFailure === "cancelledbyparent" || nativeFailure === "testaborted") return "cancelled";
  if (nativeFailure !== undefined && nativeFailure !== "testcodefailure") return "infrastructure-error";
  const explicit = lower(data.failureClass ?? data.failureKind ?? data.errorType);
  if (explicit !== undefined && !["assertion", "assertion-failed", "test-assertion"].includes(explicit)) {
    return explicit;
  }
  return undefined;
}

function eventEvidence(type: string, data: Record<string, unknown>, id: string): string[] {
  const sequence = string(data.sequence ?? data.id ?? data.testId);
  return [`node:${type}:${id}`, ...(sequence === undefined ? [] : [`sequence:${sequence}`])];
}

/** Collect node:test TestsStream/custom reporter events without parsing stdout text. */
export function collectNodeAcceptance(
  input: readonly unknown[] | string,
  options: NodeAcceptanceOptions
): AcceptanceRun {
  const parsed = eventsFromInput(input);
  const results = [] as ReturnType<typeof result>[];
  const seenCheckIds = new Set<string>();
  const duplicateCheckIds = new Set<string>();
  const pendingComplete = new Map<string, {
    readonly data: Record<string, unknown>;
    readonly type: string;
    readonly evidence: readonly string[];
    readonly attempts: number | null;
  }>();
  const diagnostics = [...parsed.diagnostics];
  let completed = false;
  let failedSummary = false;
  let completionEvidence: string[] = [];

  // start/pass/fail follow definition order, even for concurrent suites.
  // Execution-ordered complete events cannot supply unambiguous lineage.
  const stacks = new Map<string, string[]>();

  const append = (id: string, data: Record<string, unknown>, evidence: readonly string[],
    attemptCount: number | null, passed?: boolean) => {
    const failure = hasRetry(data) ? "retry" : (data.skip === true || typeof data.skip === "string") ? "skipped"
      : (data.todo === true || typeof data.todo === "string") ? "todo" : nonAssertionFailure(data);
    results.push(failure !== undefined
      ? result(options, "node:test", id, "UNKNOWN", evidence, failure, attemptCount)
      : passed === true ? result(options, "node:test", id, "PASS", evidence, "none", attemptCount)
      : passed === false && assertionFailure(data)
        ? result(options, "node:test", id, "FAIL", evidence, "assertion-failed", attemptCount)
        : result(options, "node:test", id, "UNKNOWN", evidence,
          passed === undefined ? "incomplete-output" : "infrastructure-error", attemptCount));
    if (seenCheckIds.has(id)) duplicateCheckIds.add(id);
    seenCheckIds.add(id);
  };

  for (const raw of parsed.events) {
    const value = object(raw);
    if (value === undefined) {
      diagnostics.push("malformed-event");
      continue;
    }
    const type = eventType(value);
    const rawData = eventData(value);
    const depth = rawData.nesting;
    const rawFile = string(rawData.file);
    const rawName = string(rawData.name);
    let ancestors: readonly string[] | undefined;
    if (typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 0 && depth <= 128 && rawFile !== undefined) {
      const stack = stacks.get(rawFile) ?? [];
      if (stack.length >= depth && !Array.isArray(rawData.ancestorNames) && !Array.isArray(rawData.ancestorTitles)) {
        ancestors = stack.slice(0, depth);
      }
      if (type === "test:start" && rawName !== undefined) {
        stack.length = depth;
        stack.push(rawName);
        stacks.set(rawFile, stack);
      }
    }
    const data = ancestors === undefined ? rawData : {...rawData, ancestorNames: ancestors};
    if (terminal(value) || (type === "test:complete" &&
        (value.completed === true || data.completed === true || value.terminal === true))) {
      completed = true;
      completionEvidence = [terminalEvidence(value, options.executionId)];
      continue;
    }
    if (type === undefined) {
      diagnostics.push("missing-event-type");
      continue;
    }
    if (type === "test:summary" && data.success === false) failedSummary = true;
    if (type === "test:enqueue" || type === "test:dequeue" ||
        type === "test:start" || type === "test:diagnostic" || type === "test:summary" ||
        type === "test:coverage" || type === "test:stdout" || type === "test:stderr") {
      if (type === "test:diagnostic" && (data.error !== undefined || data.failureClass !== undefined)) {
        diagnostics.push(`node-diagnostic:${string(data.failureClass) ?? "infrastructure-error"}`);
      }
      continue;
    }
    const details = object(data.details);
    const file = string(data.file ?? data.filePath);
    const name = string(data.name);
    const summary = lower(data.type ?? details?.type) === "suite" ||
      (file !== undefined && name !== undefined && resolve(name) === resolve(file));
    if (summary) {
      const error = object(details?.error);
      // A failed child already has its own result. Independent suite/file
      // failures still poison the run; summaries never become check evidence.
      if (error !== undefined && lower(error.failureType) !== "subtestsfailed") {
        diagnostics.push(`node-summary:${nonAssertionFailure(data) ?? "infrastructure-error"}`);
      }
      continue;
    }
    if (type === "test:complete" && typeof data.nesting === "number") continue;
    if (type === "test:plan" || type === "plan") {
      const count = data.count;
      const nesting = typeof data.nesting === "number" ? data.nesting : 0;
      if (nesting === 0 && typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
        completed = true;
        completionEvidence = [`node:test:plan:${count}`];
      } else if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
        diagnostics.push("malformed-plan");
      }
      continue;
    }
    const id = checkId(data);
    if (id === undefined) {
      diagnostics.push(`missing-check-id:${type}`);
      continue;
    }
    const evidence = eventEvidence(type, data, id);
    const attemptCount = attempts(data.attempts, hasRetry(data) ? 2 : 1);
    if (type === "test:complete" || type === "test-complete") {
      if (!seenCheckIds.has(id)) {
        pendingComplete.set(id, { data, type, evidence, attempts: attemptCount });
      }
      continue;
    }
    if (hasRetry(data)) {
      append(id, data, evidence, attemptCount);
      continue;
    }
    if (type === "test:skip" || type === "test-skip" || type === "skip") {
      append(id, {...data, skip: true}, evidence, attemptCount);
      continue;
    }
    if (type === "test:todo" || type === "test-todo" || type === "todo") {
      append(id, {...data, todo: true}, evidence, attemptCount);
      continue;
    }
    if (type === "test:pass" || type === "test-pass" || type === "pass" ||
        (type === "test:result" && lower(data.status) === "passed")) {
      append(id, data, evidence, attemptCount, true);
      continue;
    }
    if (type === "test:fail" || type === "test-fail" || type === "fail" ||
        (type === "test:result" && lower(data.status) === "failed")) {
      append(id, data, evidence, attemptCount, false);
      continue;
    }
    diagnostics.push(`unsupported-event:${type}`);
  }

  for (const [id, pending] of pendingComplete.entries()) {
    if (seenCheckIds.has(id)) continue;
    const details = object(pending.data.details);
    append(id, pending.data, pending.evidence, pending.attempts,
      typeof details?.passed === "boolean" ? details.passed : undefined);
  }
  for (let i = 0; i < results.length; i++) {
    if (duplicateCheckIds.has(results[i]!.checkId)) {
      results[i] = {...results[i]!, status: "UNKNOWN", failureClass: "duplicate-check"};
    }
  }
  if (failedSummary && results.every(result => result.status === "PASS")) {
    diagnostics.push("unexplained-summary-failure");
  }

  return run(options, "node:test", results, completed, completionEvidence, diagnostics);
}
