import type { AcceptanceRunner, CriterionAcceptance } from "../contracts.js";

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 4096 && !v.includes("\0");
const id = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9-]{0,127}$/u.test(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every(k => allowed.includes(k));
const dense = (v: unknown): v is unknown[] => Array.isArray(v) &&
  Array.from({length: v.length}, (_, i) => Object.hasOwn(v, i)).every(Boolean);
const strings = (v: unknown): v is string[] =>
  dense(v) && v.length <= 512 && v.every(text) && new Set(v).size === v.length;
export const commitIdentity = (v: unknown): v is string =>
  typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v);
export function materialPath(v: unknown): v is string {
  return text(v) && !v.startsWith("/") && !v.includes("\\") &&
    v.split("/").every(p => p !== "" && p !== "." && p !== ".." &&
      ![".git", ".agent-ops", "node_modules"].includes(p)) &&
    !/^(?:dist|build|\.tmp)\//u.test(v) &&
    !/^(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.(?:toml|lock)|pyproject\.toml)$/u.test(v);
}
export function acceptanceError(v: unknown): string | undefined {
  if (!record(v) || !keys(v, ["mode", "baselineCommit", "bindings"]) ||
    !["behavioral", "invariant", "review-only"].includes(String(v.mode)) ||
    !commitIdentity(v.baselineCommit) || !dense(v.bindings) || v.bindings.length > 64)
    return "Acceptance requires a mode, immutable commit SHA and bounded bindings.";
  if (v.mode === "review-only") return v.bindings.length === 0 ? undefined : "Review-only has no mechanical bindings.";
  if (v.bindings.length === 0) return "Mechanical acceptance requires a binding.";
  const identities = new Set<string>();
  let red = 0;
  for (const binding of v.bindings) {
    if (!record(binding) || !keys(binding, ["runnerId", "checkIds", "redCheckIds", "materials"]) ||
      !id(binding.runnerId) || !strings(binding.checkIds) || binding.checkIds.length === 0 ||
      !dense(binding.materials) || binding.materials.length === 0 || binding.materials.length > 512)
      return "Binding requires a runner, unique check IDs and explicit materials.";
    if (binding.redCheckIds !== undefined &&
      (!strings(binding.redCheckIds) || binding.redCheckIds.some(c => !(binding.checkIds as string[]).includes(c))))
      return "Red checks must be unique members of checkIds.";
    red += (binding.redCheckIds as string[] | undefined)?.length ?? 0;
    const paths = new Set<string>();
    for (const material of binding.materials) {
      if (!record(material) || !keys(material, ["path", "role"]) || !materialPath(material.path) ||
        !["test", "fixture", "helper"].includes(String(material.role)) || paths.has(material.path))
        return "Materials must be unique safe relative test, fixture or helper files.";
      paths.add(material.path);
    }
    for (const check of binding.checkIds) {
      const identity = binding.runnerId + "\0" + check;
      if (identities.has(identity)) return "Duplicate runner/check binding.";
      identities.add(identity);
    }
  }
  if (v.mode === "behavioral" && red === 0) return "Behavioral acceptance requires at least one designated red check.";
  if (v.mode === "invariant" && red !== 0) return "Invariant acceptance does not designate red checks.";
  return undefined;
}
export function runnerError(v: unknown): string | undefined {
  if (!record(v) || !keys(v, ["id", "command", "args", "cwd", "adapter", "timeoutMs", "setup", "build", "testBuild"]) ||
    !id(v.id) || !text(v.command) || !dense(v.args) || v.args.length > 512 ||
    !v.args.every(a => typeof a === "string" && !a.includes("\0") && a.length <= 4096 &&
      (a === "{materials}" || !/[{}]/u.test(a))) ||
    !(v.cwd === "." || materialPath(v.cwd)) ||
    !["generic", "node", "jest", "vitest", "pytest", "rust"].includes(String(v.adapter)))
    return "Acceptance runner requires fixed executable/argv, safe cwd and supported adapter.";
  const timeout = (t: unknown) => t === undefined ||
    (Number.isSafeInteger(t) && (t as number) > 0 && (t as number) <= 3_600_000);
  if (!timeout(v.timeoutMs)) return "Runner timeout is invalid.";
  for (const phase of ["setup", "build", "testBuild"]) {
    if (v[phase] === undefined) continue;
    if (!dense(v[phase]) || (v[phase] as unknown[]).length > 64) return "Runner setup/build must be bounded.";
    for (const step of v[phase] as unknown[]) {
      if (!record(step) || !keys(step, ["command", "args", "timeoutMs"]) || !text(step.command) ||
        !dense(step.args) || step.args.length > 512 ||
        !step.args.every(a => typeof a === "string" && !a.includes("\0") && a.length <= 4096) ||
        !timeout(step.timeoutMs)) return "Setup/build steps require fixed command/argv and timeout.";
    }
  }
  return undefined;
}
export function isAcceptance(v: unknown): v is CriterionAcceptance { return acceptanceError(v) === undefined; }
export function isAcceptanceRunner(v: unknown): v is AcceptanceRunner { return runnerError(v) === undefined; }
