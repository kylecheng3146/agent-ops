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
  if (data.assertion === true || data.isAssertion === true) return true;
  const explicit = lower(data.failureClass ?? data.failureKind ?? data.errorType);
  if (explicit === "assertion" || explicit === "assertion-failed" || explicit === "test-assertion") {
    return true;
  }
  const details = object(data.details);
  const error = object(data.error) ?? object(details?.error);
  const cause = object(error?.cause);
  const errorName = lower(error?.name ?? error?.type);
  const errorCode = string(error?.code);
  const causeName = lower(cause?.name ?? cause?.type);
  const causeCode = string(cause?.code);
  return errorName === "assertionerror" || errorCode === "err_assertion" ||
    causeName === "assertionerror" || causeCode === "err_assertion";
}

function failureClass(data: Record<string, unknown>): string {
  const explicit = lower(data.failureClass ?? data.failureKind ?? data.errorType);
  if (explicit !== undefined && explicit !== "assertion" && explicit !== "assertion-failed") {
    return explicit;
  }
  const kind = lower(data.kind ?? data.scope);
  if (kind === "hook") return "hook-error";
  if (kind === "fixture") return "fixture-error";
  if (kind === "collection" || kind === "root" || kind === "suite") return "collection-error";
  if (data.timeout === true) return "timeout";
  return "infrastructure-error";
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
  const pendingComplete = new Map<string, {
    readonly data: Record<string, unknown>;
    readonly type: string;
    readonly evidence: readonly string[];
    readonly attempts: number | null;
  }>();
  const diagnostics = [...parsed.diagnostics];
  let completed = false;
  let completionEvidence: string[] = [];

  for (const raw of parsed.events) {
    const value = object(raw);
    if (value === undefined) {
      diagnostics.push("malformed-event");
      continue;
    }
    const type = eventType(value);
    const data = eventData(value);
    if (terminal(value) || (type === "test:complete" &&
        (value.completed === true || data.completed === true || value.terminal === true))) {
      completed = true;
      completionEvidence = [terminalEvidence(value, options.executionId)];
      continue;
    }
    if (type === undefined || type === "test:enqueue" || type === "test:dequeue" ||
        type === "test:start" || type === "test:diagnostic" || type === "test:summary" ||
        type === "test:coverage") {
      if (type === "test:diagnostic" && (data.error !== undefined || data.failureClass !== undefined)) {
        diagnostics.push(`node-diagnostic:${string(data.failureClass) ?? "infrastructure-error"}`);
      }
      continue;
    }
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
      const dataFile = string(data.file ?? data.filePath);
      if (string(data.name) === dataFile) {
        // The file-level completion is a summary of child results, not a
        // second check. Child test:pass/test:fail events carry the evidence.
      } else if (!seenCheckIds.has(id)) {
        pendingComplete.set(id, { data, type, evidence, attempts: attemptCount });
      }
      continue;
    }
    if (hasRetry(data)) {
      results.push(result(options, "node:test", id, "UNKNOWN", evidence, "retry", attemptCount));
      seenCheckIds.add(id);
      continue;
    }
    if (type === "test:skip" || type === "test-skip" || type === "skip") {
      results.push(result(options, "node:test", id, "UNKNOWN", evidence, "skipped", attemptCount));
      seenCheckIds.add(id);
      continue;
    }
    if (type === "test:todo" || type === "test-todo" || type === "todo") {
      results.push(result(options, "node:test", id, "UNKNOWN", evidence, "todo", attemptCount));
      seenCheckIds.add(id);
      continue;
    }
    if (type === "test:pass" || type === "test-pass" || type === "pass" ||
        (type === "test:result" && lower(data.status) === "passed")) {
      results.push(result(options, "node:test", id, "PASS", evidence, "none", attemptCount));
      seenCheckIds.add(id);
      continue;
    }
    if (type === "test:fail" || type === "test-fail" || type === "fail" ||
        (type === "test:result" && lower(data.status) === "failed")) {
      results.push(assertionFailure(data)
        ? result(options, "node:test", id, "FAIL", evidence, "assertion-failed", attemptCount)
        : result(options, "node:test", id, "UNKNOWN", evidence, failureClass(data), attemptCount));
      seenCheckIds.add(id);
      continue;
    }
    diagnostics.push(`unsupported-event:${type}`);
  }

  for (const [id, pending] of pendingComplete.entries()) {
    if (seenCheckIds.has(id)) continue;
    const details = object(pending.data.details);
    if (details?.passed === true) {
      results.push(result(options, "node:test", id, "PASS", pending.evidence, "none", pending.attempts));
    } else if (details?.passed === false) {
      results.push(assertionFailure(pending.data)
        ? result(options, "node:test", id, "FAIL", pending.evidence, "assertion-failed", pending.attempts)
        : result(options, "node:test", id, "UNKNOWN", pending.evidence, failureClass(pending.data), pending.attempts));
    } else {
      results.push(result(options, "node:test", id, "UNKNOWN", pending.evidence, "incomplete-output", pending.attempts));
    }
  }

  return run(options, "node:test", results, completed, completionEvidence, diagnostics);
}
