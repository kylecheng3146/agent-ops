import { acceptanceError, acceptanceSourcePath, commitIdentity, materialPath } from "../schema/acceptance.js";
import { AgentOpsError } from "../fs/paths.js";
import { SCENARIO_DIMENSIONS } from "../surface/schema.js";
import { makeAcceptanceCheck, makeAcceptanceRun, type AcceptanceRun } from "../verify/acceptance-protocol.js";
import type { QaArtifactKind, QaArtifacts, QaAuthorResponse, QaConfig, QaControl, QaPolicyBinding, QaReference, QaVersion } from "./types.js";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => typeof v === "object" && v !== null && !Array.isArray(v);
const exact = (v: RecordValue, required: readonly string[], optional: readonly string[] = []) =>
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const shape = (v: unknown, fields: readonly string[], optional: readonly string[] = []): v is RecordValue => record(v) && exact(v, fields, optional);
export const qaId = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9-]{0,127}$/u.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const text = (v: unknown, max = 4096): v is string => typeof v === "string" && v.trim() !== "" && !v.includes("\0") && Buffer.byteLength(v) <= max;
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;
const date = (v: unknown): v is string => text(v, 64) &&
  /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(`${v.slice(0, 10)}T00:00:00Z`).toISOString().startsWith(v.slice(0, 10));
const list = (v: unknown, check: (v: unknown) => boolean, min = 0, max = 512): v is unknown[] => Array.isArray(v) &&
  v.length >= min && v.length <= max && Array.from({length: v.length}, (_, i) => Object.hasOwn(v, i) && check(v[i])).every(Boolean);
const strings = (v: unknown, check: (v: unknown) => boolean = text, min = 0): v is string[] =>
  list(v, check, min) && new Set(v).size === v.length;
const oneOf = (v: unknown, values: readonly unknown[]) => values.includes(v);
const kinds: readonly QaArtifactKind[] = ["plan", "attempt", "report", "execution", "decision", "attestation"];

export function validQaConfig(v: unknown): v is QaConfig {
  return shape(v, ["enabled"]) && typeof v.enabled === "boolean";
}
export function validQaPolicyBinding(v: unknown): v is QaPolicyBinding {
  return shape(v, ["schemaVersion", "required", "policyHash", "enrolledAt", "enrollment", "late"]) &&
    v.schemaVersion === 1 && v.required === true && hash(v.policyHash) && date(v.enrolledAt) &&
    oneOf(v.enrollment, ["new", "adopted"]) && typeof v.late === "boolean" && (v.enrollment !== "new" || v.late === false);
}
export function validQaVersion(v: unknown): v is QaVersion {
  const hashes = ["goalHash", "taskContractHash", "treeContractHash", "scopeHash", "policyHash", "configHash", "sourceFingerprint"];
  return shape(v, ["taskId", "candidateCommit", ...hashes]) && qaId(v.taskId) && commitIdentity(v.candidateCommit) && hashes.every(k => hash(v[k]));
}
export function validQaReference(v: unknown, kind?: QaArtifactKind): v is QaReference {
  return shape(v, ["kind", "digest"]) && oneOf(v.kind, kinds) && (kind === undefined || v.kind === kind) && hash(v.digest);
}
const references = (v: unknown, kind: QaArtifactKind, min = 0) =>
  list(v, ref => validQaReference(ref, kind), min) && new Set(v.map(ref => (ref as QaReference).digest)).size === v.length;
function session(v: unknown): boolean {
  return shape(v, ["host", "sessionId", "implementationSessionId", "implementationHost", "writable", "fallbackReason"]) &&
    oneOf(v.host, ["agy", "claude", "codex"]) && text(v.sessionId, 256) && text(v.implementationSessionId, 256) &&
    v.sessionId !== v.implementationSessionId && oneOf(v.implementationHost, [null, "agy", "claude", "codex"]) &&
    typeof v.writable === "boolean" && !(v.host === "agy" && v.writable) &&
    (v.fallbackReason === null || text(v.fallbackReason)) && (v.host !== v.implementationHost || text(v.fallbackReason));
}
function question(v: unknown): boolean {
  return shape(v, ["id", "prompt", "required", "criterionIds"]) && qaId(v.id) && text(v.prompt) &&
    typeof v.required === "boolean" && strings(v.criterionIds, text, 1);
}
function uniqueIds(v: unknown, check: (v: unknown) => boolean, min = 0): v is RecordValue[] {
  return list(v, check, min) && new Set(v.map(item => (item as RecordValue).id)).size === v.length;
}
function material(v: unknown): boolean {
  return shape(v, ["path", "role", "digest"]) && materialPath(v.path) && oneOf(v.role, ["test", "fixture", "helper"]) && hash(v.digest);
}
function fileReference(v: unknown): boolean {
  if (!shape(v, ["path", "digest"]) || !hash(v.digest) || !text(v.path)) return false;
  // Evidence may live in .agent-ops; still reject traversal, absolute paths and Git internals.
  const path = v.path.startsWith(".agent-ops/") ? v.path.slice(".agent-ops/".length) : v.path;
  return acceptanceSourcePath(path);
}
function qaCase(v: unknown, baselineCommit: string): boolean {
  if (!shape(v, ["id", "criterionIds", "surfaceIds", "required", "mode", "preconditions", "actions", "expected", "bindings"], ["nonmechanicalReason"]) ||
    !qaId(v.id) || !strings(v.criterionIds, text, 1) || !strings(v.surfaceIds, qaId) || typeof v.required !== "boolean" ||
    !strings(v.preconditions) || !strings(v.actions, text, 1) || !text(v.expected)) return false;
  return acceptanceError({mode: v.mode === "nonmechanical" ? "review-only" : v.mode, baselineCommit, bindings: v.bindings,
    ...(v.nonmechanicalReason === undefined ? {} : {reviewOnlyReason: v.nonmechanicalReason})}) === undefined;
}
function finding(v: unknown): boolean {
  return shape(v, ["id", "caseId", "criterionIds", "surfaceIds", "blocking", "introduced", "reproducible", "summary", "reproduction", "expected", "actual", "locations", "executions"]) &&
    qaId(v.id) && qaId(v.caseId) && strings(v.criterionIds, text, 1) && strings(v.surfaceIds, qaId) &&
    [v.blocking, v.introduced, v.reproducible].every(b => typeof b === "boolean") && text(v.summary) &&
    strings(v.reproduction, text, 1) && text(v.expected) && text(v.actual) &&
    list(v.locations, l => shape(l, ["path", "line"]) && acceptanceSourcePath(l.path) && integer(l.line, 1)) && references(v.executions, "execution");
}
function usage(v: unknown): boolean {
  return shape(v, ["inputTokens", "outputTokens", "totalTokens", "costUsd"]) &&
    [v.inputTokens, v.outputTokens, v.totalTokens].every(n => n === null || integer(n)) &&
    (v.costUsd === null || (typeof v.costUsd === "number" && Number.isFinite(v.costUsd) && v.costUsd >= 0));
}
function executionRun(v: unknown): boolean {
  if (!shape(v, ["protocolVersion", "executionId", "framework", "frameworkVersion", "phase", "results", "completed", "completionEvidence", "diagnostics"]) ||
      v.protocolVersion !== 1 || typeof v.completed !== "boolean" || !strings(v.completionEvidence) || !strings(v.diagnostics) || !list(v.results, result => shape(result,
        ["executionId", "framework", "frameworkVersion", "checkId", "phase", "status", "failureClass", "attempts", "evidence"]), 0, 4096)) return false;
  try {
    const run = v as unknown as AcceptanceRun;
    makeAcceptanceRun({...run, results: run.results.map(makeAcceptanceCheck)});
    return true;
  } catch {return false;}
}
function artifact(kind: QaArtifactKind, v: unknown): boolean {
  if (!record(v) || v.schemaVersion !== 1 || !validQaVersion(v.version)) return false;
  const version = v.version;
  const base = ["schemaVersion", "version"];
  switch (kind) {
    case "plan":
      return exact(v, [...base, "id", "originalGoal", "taskIds", "dependencyTaskIds", "scope", "session", "createdAt", "timing", "advisoryReferences", "cases", "scenarios", "environment", "questions"]) &&
        qaId(v.id) && text(v.originalGoal, 65536) && strings(v.taskIds, qaId, 1) && v.taskIds.includes(v.version.taskId) &&
        strings(v.dependencyTaskIds, qaId) && oneOf(v.scope, ["full", "partial"]) && session(v.session) && (v.session as RecordValue).writable === false && date(v.createdAt) &&
        oneOf(v.timing, ["early", "late"]) && list(v.advisoryReferences, fileReference) && uniqueIds(v.cases, c => qaCase(c, version.candidateCommit), 1) &&
        shape(v.scenarios, SCENARIO_DIMENSIONS) && Object.values(v.scenarios).every(s =>
          (shape(s, ["applies", "behavior"]) && s.applies === true && text(s.behavior)) || (shape(s, ["na"]) && text(s.na))) &&
        list(v.environment, e => shape(e, ["name", "required", "status", "evidence"]) && text(e.name) && typeof e.required === "boolean" &&
          oneOf(e.status, ["available", "missing", "unknown"]) && strings(e.evidence, text, 1)) && uniqueIds(v.questions, question);
    case "attempt":
      return exact(v, [...base, "id", "generation", "plan", "session", "startedAt", "finishedAt", "materials", "materialDigest", "executions", "usage"], ["lineage"]) &&
        // Lineage names the final candidate: imported material always moves it past the authored commit.
        (v.lineage === undefined || (shape(v.lineage, ["authoredCommit", "importedCommit"], ["materialsFrom"]) && commitIdentity(v.lineage.authoredCommit) &&
          v.lineage.importedCommit === version.candidateCommit && Array.isArray(v.materials) && (v.lineage.materialsFrom === undefined
            ? (v.materials.length === 0) === (v.lineage.authoredCommit === v.lineage.importedCommit)
            // A re-execution imported nothing: it names the candidate twice and the earlier import its materials came from.
            : commitIdentity(v.lineage.materialsFrom) && v.lineage.materialsFrom !== v.lineage.importedCommit &&
              v.lineage.authoredCommit === v.lineage.importedCommit && v.materials.length > 0))) &&
        qaId(v.id) && integer(v.generation, 1) && validQaReference(v.plan, "plan") && session(v.session) && (v.session as RecordValue).writable === true && date(v.startedAt) &&
        (v.finishedAt === null || (date(v.finishedAt) && Date.parse(v.finishedAt) >= Date.parse(v.startedAt))) && list(v.materials, material) &&
        new Set(v.materials.map(m => (m as RecordValue).path)).size === v.materials.length && hash(v.materialDigest) && references(v.executions, "execution") && usage(v.usage);
    case "execution":
      return exact(v, [...base, "caseId", "runnerId", "materialDigest", "run", "evidenceReferences"]) && qaId(v.caseId) && qaId(v.runnerId) &&
        hash(v.materialDigest) && executionRun(v.run) && list(v.evidenceReferences, fileReference, 1);
    case "report":
      return exact(v, [...base, "id", "attempt", "createdAt", "results", "findings", "questions"]) && qaId(v.id) && validQaReference(v.attempt, "attempt") && date(v.createdAt) &&
        list(v.results, r => shape(r, ["caseId", "status", "executions", "observations"]) && qaId(r.caseId) && oneOf(r.status, ["PASS", "FAIL", "UNKNOWN"]) &&
          references(r.executions, "execution") && strings(r.observations, text, 1), 1) &&
        new Set(v.results.map(r => (r as RecordValue).caseId)).size === v.results.length && uniqueIds(v.findings, finding) && uniqueIds(v.questions, question);
    case "decision":
      return exact(v, [...base, "plan", "questionId", "answer", "answeredBy", "answeredAt"]) && validQaReference(v.plan, "plan") &&
        qaId(v.questionId) && text(v.answer, 8192) && text(v.answeredBy, 256) && date(v.answeredAt);
    case "attestation":
      return exact(v, [...base, "plan", "report", "executions", "decisions", "materialDigest", "caseIds", "session", "generation", "sealedAt"], ["nonmechanicalCaseIds"]) &&
        validQaReference(v.plan, "plan") && validQaReference(v.report, "report") && references(v.executions, "execution") && references(v.decisions, "decision") &&
        hash(v.materialDigest) && strings(v.caseIds, qaId, 1) && (v.nonmechanicalCaseIds === undefined ||
          (strings(v.nonmechanicalCaseIds, qaId) && v.nonmechanicalCaseIds.every(id => (v.caseIds as string[]).includes(id)))) && session(v.session) && (v.session as RecordValue).writable === true && integer(v.generation, 1) && date(v.sealedAt);
  }
}
export function parseQaArtifact<K extends QaArtifactKind>(kind: K, value: unknown): QaArtifacts[K] {
  if (!kinds.includes(kind) || !artifact(kind, value)) throw new AgentOpsError("QA_ARTIFACT_INVALID", "QA artifact has an unsupported schema or invalid bounded data.");
  return structuredClone(value) as QaArtifacts[K];
}
/** Strict: an unknown key, a stale binding shape or a non-material role is a rejected response, not a partial one. */
export function parseQaAuthorResponse(v: unknown): QaAuthorResponse {
  if (!shape(v, ["schemaVersion", "generation", "plan", "candidateCommit", "materials", "requestedEdits", "observations", "questions"]) ||
      v.schemaVersion !== 1 || !integer(v.generation, 1) || !hash(v.plan) || !commitIdentity(v.candidateCommit) ||
      !list(v.materials, m => shape(m, ["path", "role", "caseIds"]) && text(m.path) && oneOf(m.role, ["test", "fixture", "helper"]) && strings(m.caseIds, qaId, 1)) ||
      new Set(v.materials.map(m => (m as RecordValue).path)).size !== v.materials.length ||
      !list(v.requestedEdits, e => shape(e, ["path", "reason"]) && text(e.path) && text(e.reason)) ||
      !list(v.observations, o => shape(o, ["caseId", "notes"]) && qaId(o.caseId) && strings(o.notes, text, 1)) || !uniqueIds(v.questions, question))
    throw new AgentOpsError("QA_RESPONSE_INVALID", "QA author response has an unsupported schema or invalid bounded data.");
  return structuredClone(v) as unknown as QaAuthorResponse;
}
export function parseQaControl(v: unknown): QaControl {
  if (!shape(v, ["schemaVersion", "taskId", "revision", "generation", "state", "continuation", "owner", "plan", "attempt", "report", "attestation", "progress", "updatedAt"],
      ["decisions", "native"]) || (v.decisions !== undefined && !references(v.decisions, "decision")) ||
      (v.native !== undefined && !(shape(v.native, ["session", "nativeSessionId", "checkout", "reason", "resetAt", "observedAt"]) && session(v.native.session) &&
        (v.native.session as RecordValue).writable === true && text(v.native.nativeSessionId, 256) && text(v.native.checkout) &&
        oneOf(v.native.reason, ["provider-limit", "denied"]) && (v.native.resetAt === null || date(v.native.resetAt)) && date(v.native.observedAt))) ||
      v.schemaVersion !== 1 || !qaId(v.taskId) || !integer(v.revision, 1) || !integer(v.generation, 1) ||
      !oneOf(v.state, ["planning", "plan-ready", "testing", "passed", "awaiting-repair", "awaiting-input", "blocked", "stopped"]) || typeof v.continuation !== "boolean" ||
      (v.state === "stopped" && v.continuation !== false) || !date(v.updatedAt) ||
      !["plan", "attempt", "report", "attestation"].every(k => v[k] === null || validQaReference(v[k], k as QaArtifactKind)) ||
      (v.owner !== null && !(shape(v.owner, ["controllerId", "session", "processId", "processIdentity"]) && text(v.owner.controllerId, 256) && session(v.owner.session) &&
        ((v.owner.processId === null && v.owner.processIdentity === null) || (integer(v.owner.processId, 1) && text(v.owner.processIdentity, 256))))) ||
      (v.progress !== null && !(shape(v.progress, ["semanticHash", "consecutive", "at"]) && hash(v.progress.semanticHash) && integer(v.progress.consecutive, 1) && date(v.progress.at))) ||
      (v.state === "passed" && (v.attestation === null || v.owner !== null)))
    throw new AgentOpsError("QA_CONTROL_INVALID", "QA control record has invalid schema, ownership or state.");
  return structuredClone(v) as unknown as QaControl;
}
