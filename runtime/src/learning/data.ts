import {canonicalJson} from "../config/hash.js";
import {sha256} from "../fs/hash.js";
import {AgentOpsError} from "../fs/paths.js";
import {redactSecrets} from "../security/redact.js";
import {SCENARIO_DIMENSIONS} from "../surface/schema.js";
import {globsOverlap} from "../escape/lessons.js";
import {validateCriteriaAdvice, type CriteriaAdvice} from "../review/criteria.js";

export const LEARNING_LIMITS = {candidates: 2, compositions: 1, invocations: 12, repetitions: 2} as const;
export const digest = (value: unknown): string => sha256(canonicalJson(value));
export const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export const exact = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const text = (v: unknown, max = 2048): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !v.includes("\0");
export const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
export function invalid(message: string): never {throw new AgentOpsError("LEARNING_INVALID", message);}
export function redactData(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactData);
  return object(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [redactSecrets(k), redactData(v)])) : value;
}

export interface Strategy {id: string; paths: string[]; cue: string; check: string}
export interface Proposal {strategies: Strategy[]; expectedImprovement: string; failureCondition: string}
export const strategyDigest = (strategies: readonly Strategy[]): string => digest(strategies.map(s => ({...s, paths: [...s.paths].sort()}))
  .sort((a, b) => a.id.localeCompare(b.id)));
export function parseProposal(value: unknown): Proposal {
  if (!object(value) || !exact(value, ["strategies", "expectedImprovement", "failureCondition"]) ||
      !text(value.expectedImprovement) || !text(value.failureCondition) || !Array.isArray(value.strategies) || value.strategies.length > 16)
    invalid("Proposal requires bounded strategies, expectedImprovement and failureCondition; no commands or policy fields.");
  const ids = new Set<string>(), contents = new Set<string>();
  const strategies = value.strategies.map(row => {
    if (!object(row) || !exact(row, ["id", "paths", "cue", "check"]) || typeof row.id !== "string" ||
        !/^[a-z][a-z0-9-]{0,63}$/u.test(row.id) || ids.has(row.id) || !text(row.cue) || !text(row.check) ||
        !Array.isArray(row.paths) || row.paths.length < 1 || row.paths.length > 8 || new Set(row.paths).size !== row.paths.length ||
        !row.paths.every(p => text(p, 256) && !/[\\\r\n]/u.test(p) && !p.startsWith("/") &&
          p.split("/").every(part => part !== "" && part !== "." && part !== "..") &&
          (!/[*?]/u.test(p) || (p.endsWith("/**") && !/[*?]/u.test(p.slice(0, -3)))))) invalid("Strategies need exact files or bounded directory/** scopes.");
    const key = digest({paths: [...row.paths].sort(), cue: row.cue, check: row.check});
    if (contents.has(key)) invalid("Duplicate strategies.");
    ids.add(row.id); contents.add(key);
    return {id: row.id, paths: [...row.paths] as string[], cue: row.cue, check: row.check};
  });
  for (let i = 0; i < strategies.length; i++) for (const other of strategies.slice(i + 1))
    if (strategies[i]!.paths.some(p => other.paths.some(q => globsOverlap(p, q))))
      invalid("Potential strategy conflict: overlapping scopes must be reconciled under one stable id.");
  return {strategies, expectedImprovement: value.expectedImprovement, failureCondition: value.failureCondition};
}

export interface LearningCase {id: string; split: "probe" | "holdout"; snapshot: Record<string, unknown>; expected: string[]}
export interface LearningSuite {schemaVersion: 1; cases: LearningCase[]}
export function casePaths(snapshot: Record<string, unknown>): string[] {
  const surface = snapshot.surface;
  if (!object(surface) || !Array.isArray(surface.included) || surface.included.length < 1 || surface.included.length > 16 ||
      !surface.included.every(row => object(row) && text(row.path, 256) && !row.path.startsWith("/") &&
        !/[\\\r\n]/u.test(row.path) && row.path.split("/").every(p => p !== "" && p !== "." && p !== "..")))
    invalid("Each case needs an explicit repository-relative included surface.");
  return surface.included.map(row => row.path as string);
}
export function parseSuite(value: unknown): LearningSuite {
  if (!object(value) || !exact(value, ["schemaVersion", "cases"]) || value.schemaVersion !== 1 ||
      !Array.isArray(value.cases) || value.cases.length < 4 || value.cases.length > 16) invalid("Suite needs 4–16 frozen cases.");
  const ids = new Set<string>(), inputs = new Set<string>();
  const cases = value.cases.map(row => {
    if (!object(row) || !exact(row, ["id", "split", "snapshot", "expected"]) || !text(row.id, 64) || ids.has(row.id) ||
        !["probe", "holdout"].includes(String(row.split)) || !object(row.snapshot) || !text(row.snapshot.originalGoal, 8192) ||
        !Array.isArray(row.snapshot.criteria) || row.snapshot.criteria.length < 2 || row.snapshot.criteria.length > 5 ||
        !row.snapshot.criteria.every(c => object(c) && text(c.id, 64) && text(c.description, 8192)) ||
        !Array.isArray(row.expected) || new Set(row.expected).size !== row.expected.length ||
        !row.expected.every(d => SCENARIO_DIMENSIONS.includes(d as never))) invalid("Invalid case or expected scenario set.");
    const input = digest(row.snapshot);
    casePaths(row.snapshot);
    if (inputs.has(input)) invalid("Probe and holdout tasks must have distinct inputs.");
    ids.add(row.id); inputs.add(input);
    return {id: row.id, split: row.split as LearningCase["split"], snapshot: row.snapshot, expected: [...row.expected] as string[]};
  });
  if (cases.filter(c => c.split === "probe").length < 2 || cases.filter(c => c.split === "holdout").length < 2)
    invalid("Reserve at least two independent holdout tasks and two probes.");
  return {schemaVersion: 1, cases};
}

export interface CaseResult {caseId: string; advice: CriteriaAdvice; omissions: {dimension: string; recommendationIndex: number}[]}
export interface Score {probe: {fp: number; fn: number}; holdout: {fp: number; fn: number}}
// shortcut: five-dimensional omission classification is a small benchmark; broaden only with independently labelled task families.
/** Expected labels stay in this evaluator, never in an authoring or solver prompt. */
export function scoreReply(value: unknown, suite: LearningSuite): {results: CaseResult[]; score: Score} {
  if (!object(value) || !exact(value, ["results"]) || !Array.isArray(value.results) || value.results.length !== suite.cases.length)
    invalid("Evaluation must answer every case exactly once.");
  const seen = new Set<string>();
  const score: Score = {probe: {fp: 0, fn: 0}, holdout: {fp: 0, fn: 0}};
  const results = value.results.map(row => {
    if (!object(row) || !exact(row, ["caseId", "advice", "omissions"]) || !text(row.caseId, 64) || seen.has(row.caseId) ||
        !validateCriteriaAdvice(row.advice) || !Array.isArray(row.omissions) || row.omissions.length > 5) invalid("Invalid evaluation output.");
    const item = suite.cases.find(c => c.id === row.caseId);
    if (item === undefined) invalid("Unknown evaluation case.");
    const criteria = item.snapshot.criteria as {id: string}[];
    if (row.advice.recommendations.some(r => r.criterionId !== "task" && !criteria.some(c => c.id === r.criterionId)))
      invalid("Unknown advice criterion.");
    const dimensions = new Set<string>(), indices = new Set<number>();
    for (const omission of row.omissions) {
      if (!object(omission) || !exact(omission, ["dimension", "recommendationIndex"]) ||
          !SCENARIO_DIMENSIONS.includes(omission.dimension as never) || dimensions.has(String(omission.dimension)) ||
          !Number.isSafeInteger(omission.recommendationIndex) || (omission.recommendationIndex as number) < 0 ||
          (omission.recommendationIndex as number) >= row.advice.recommendations.length || indices.has(omission.recommendationIndex as number))
        invalid("Each omission must cite one concrete recommendation and one unique scenario dimension.");
      dimensions.add(String(omission.dimension)); indices.add(omission.recommendationIndex as number);
    }
    score[item.split].fp += [...dimensions].filter(d => !item.expected.includes(d)).length + row.advice.recommendations.length - indices.size;
    score[item.split].fn += item.expected.filter(d => !dimensions.has(d)).length;
    seen.add(row.caseId);
    return row as unknown as CaseResult;
  });
  return {results, score};
}
export function improves(base: Score, candidate: Score): boolean {
  return candidate.probe.fp <= base.probe.fp && candidate.probe.fn <= base.probe.fn &&
    candidate.holdout.fp <= base.holdout.fp && candidate.holdout.fn < base.holdout.fn;
}

/** A gain elsewhere cannot pay for a new missed dimension, false positive or extra recommendation. */
export function noCaseRegressions(base: readonly CaseResult[], candidate: readonly CaseResult[], suite: LearningSuite): boolean {
  return suite.cases.every(item => {
    const before = base.find(r => r.caseId === item.id), after = candidate.find(r => r.caseId === item.id);
    if (before === undefined || after === undefined) return false;
    const known = new Set(before.omissions.map(o => o.dimension)), next = new Set(after.omissions.map(o => o.dimension));
    return item.expected.every(d => !known.has(d) || next.has(d)) &&
      [...next].every(d => item.expected.includes(d) || known.has(d)) &&
      after.advice.recommendations.length - after.omissions.length <= before.advice.recommendations.length - before.omissions.length;
  });
}
