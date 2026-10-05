import {
  parseJsonDocument,
  parseJsonLines,
  stableCheckId,
  type AcceptanceRun
} from "../acceptance-protocol.js";
import {
  attempts,
  lower,
  object,
  result,
  run,
  string,
  terminal,
  terminalEvidence,
  type AcceptanceAdapterOptions
} from "./shared.js";

export interface RustAcceptanceOptions extends AcceptanceAdapterOptions {}

function inputEvents(input: unknown): {
  readonly events: readonly unknown[];
  readonly diagnostics: readonly string[];
} {
  if (Array.isArray(input)) return { events: input, diagnostics: [] };
  if (typeof input !== "string") {
    const value = object(input);
    return value === undefined
      ? { events: [], diagnostics: ["malformed-output"] }
      : { events: [value], diagnostics: [] };
  }
  const document = parseJsonDocument(input);
  if (Array.isArray(document)) return { events: document, diagnostics: [] };
  if (object(document) !== undefined) return { events: [document], diagnostics: [] };
  const lines = parseJsonLines(input);
  return {
    events: lines.values,
    diagnostics: lines.invalidLines.map((line) => `invalid-json-line:${line}`)
  };
}

function status(value: unknown): "PASS" | "FAIL" | "UNKNOWN" {
  const normalized = lower(value);
  if (normalized === "pass" || normalized === "passed" || normalized === "ok") return "PASS";
  if (normalized === "fail" || normalized === "failed") return "FAIL";
  return "UNKNOWN";
}

/**
 * Collect the stdlib harness' JSON-lines output. Native libtest text without
 * this explicit protocol is intentionally unsupported instead of guessed.
 */
export function collectRustAcceptance(
  input: unknown,
  options: RustAcceptanceOptions
): AcceptanceRun {
  const parsed = inputEvents(input);
  const results = [] as ReturnType<typeof result>[];
  const diagnostics = [...parsed.diagnostics];
  let completed = false;
  let completionEvidence: string[] = [];
  for (const raw of parsed.events) {
    const value = object(raw);
    if (value === undefined) {
      diagnostics.push("malformed-event");
      continue;
    }
    const type = lower(value.type ?? value.event ?? value.kind);
    if (terminal(value) || type === "completed" || type === "complete") {
      completed = true;
      completionEvidence = [terminalEvidence(value, options.executionId)];
      continue;
    }
    if (type !== "check" && type !== "assertion" && type !== "result") {
      diagnostics.push(`unsupported-event:${type ?? "unknown"}`);
      continue;
    }
    const rawId = string(value.checkId ?? value.testId ?? value.name);
    if (rawId === undefined) {
      diagnostics.push("missing-check-id");
      continue;
    }
    let checkId: string;
    try {
      checkId = stableCheckId([rawId]);
    } catch {
      diagnostics.push("missing-check-id");
      continue;
    }
    const checkStatus = status(value.status ?? value.outcome ?? value.state);
    const failureClass = lower(value.failureClass ?? value.failureKind) ??
      (checkStatus === "PASS" ? "none" : checkStatus === "FAIL" ? "infrastructure-error" : "unsupported-output");
    const evidence = Array.isArray(value.evidence)
      ? value.evidence.filter((item): item is string => typeof item === "string")
      : [`rust:${checkId}`];
    try {
      results.push(result(
        options,
        "rust-harness",
        checkId,
        checkStatus,
        evidence,
        failureClass,
        attempts(value.attempts, null)
      ));
    } catch {
      diagnostics.push(`malformed-result:${checkId}`);
    }
  }
  return run(options, "rust-harness", results, completed, completionEvidence, diagnostics);
}
