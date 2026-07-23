import type { SecurityException } from "../contracts.js";
import type {
  GuardrailDecision,
  GuardrailEvaluationOptions
} from "./types.js";

const ID_PATTERN = /^[a-z][a-z0-9-]{0,127}$/;
const WINDOWS_RESERVED_SEGMENT =
  /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\..*)?$/i;

function isBoundedProjectScope(scope: string): boolean {
  if (
    scope.length === 0 ||
    scope === "." ||
    scope.includes("\0") ||
    scope.includes("\\") ||
    scope.includes("*") ||
    scope.includes("?") ||
    scope.includes("[") ||
    scope.startsWith("/") ||
    /^[A-Za-z]:/.test(scope)
  ) {
    return false;
  }
  return scope.split("/").every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.endsWith(".") &&
      !WINDOWS_RESERVED_SEGMENT.test(segment) &&
      /^[A-Za-z0-9._-]+$/.test(segment)
  );
}

function scopeContains(exceptionScope: string, evaluatedScope: string): boolean {
  return (
    evaluatedScope === exceptionScope ||
    evaluatedScope.startsWith(`${exceptionScope}/`)
  );
}

export function isActiveSecurityException(
  exception: SecurityException,
  ruleId: string,
  scope: string,
  now: Date
): boolean {
  const expiresAt = Date.parse(exception.expiresAt);
  return (
    ID_PATTERN.test(exception.ruleId) &&
    exception.ruleId === ruleId &&
    isBoundedProjectScope(exception.scope) &&
    isBoundedProjectScope(scope) &&
    scopeContains(exception.scope, scope) &&
    exception.reason.trim().length > 0 &&
    Number.isFinite(expiresAt) &&
    Number.isFinite(now.getTime()) &&
    expiresAt > now.getTime()
  );
}

export function applySecurityExceptions(
  decision: GuardrailDecision,
  scope: string,
  options: GuardrailEvaluationOptions
): GuardrailDecision {
  if (decision.action === "allow" || options.exceptions === undefined) {
    return decision;
  }
  const now = options.now;
  if (now === undefined) {
    return decision;
  }
  return options.exceptions.some((exception) =>
    isActiveSecurityException(exception, decision.ruleId, scope, now)
  )
    ? { action: "allow" }
    : decision;
}
