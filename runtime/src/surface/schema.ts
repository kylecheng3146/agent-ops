import { AgentOpsError } from "../fs/paths.js";
import { canonicalJson } from "../config/hash.js";

/** EVIDENCE-SURFACE-001: where else the change lands, recorded before criteria. */
export const SURFACE_AXES = ["dependents", "duplicates", "otherPaths", "sharedState"] as const;
export const SCENARIO_DIMENSIONS = ["initialState", "redo", "timeBoundary", "identitySwitch", "concurrency"] as const;
export const VALUE_CHANGE_KINDS = ["clear", "redact", "default", "normalize", "unit-format"] as const;

export type SurfaceAxisId = typeof SURFACE_AXES[number];
export type ScenarioId = typeof SCENARIO_DIMENSIONS[number];
export type SurfaceAxis = { readonly queries: readonly string[] } | { readonly na: string };
export type SurfaceScenario = { readonly applies: true; readonly behavior: string } | { readonly na: string };

export interface SurfaceAudit {
  readonly axes: Readonly<Record<SurfaceAxisId, SurfaceAxis>>;
  readonly included: readonly { readonly id: string; readonly path: string; readonly behavior: string }[];
  readonly excluded: readonly { readonly glob: string; readonly reason: string }[];
  readonly unknown: readonly { readonly id: string; readonly reader: string; readonly behavior: string; readonly path?: string }[];
  readonly contracts: readonly { readonly id: string; readonly name: string; readonly change: "compatible" | "breaking"; readonly behavior: string }[];
  readonly valueChanges: readonly {
    readonly producer: string; readonly kind: typeof VALUE_CHANGE_KINDS[number]; readonly change: string;
    readonly consumers: readonly string[]; readonly indirectConsumers: readonly string[];
  }[];
  /** Completeness is checked before review (SCENARIO_MISSING), not at create. */
  readonly scenarios: Readonly<Partial<Record<ScenarioId, SurfaceScenario>>>;
  /** Derived discovery queries judged incidental: their hits need no per-file row (guards in the surface gate). */
  readonly dismissed?: readonly { readonly query: string; readonly reason: string }[];
}
/** A child of a surfaced parent names the parent's included surfaces it delivers. */
export interface SurfaceCovers { readonly covers: readonly string[] }
export type TaskSurface = SurfaceAudit | SurfaceCovers;

export const isCovers = (surface: TaskSurface): surface is SurfaceCovers => "covers" in surface;

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 2048): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max && !v.includes("\0");
const id = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(v);
const exact = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
// "out of scope" names where the work stops, not why the surface is unaffected.
const reason = (v: unknown): v is string =>
  text(v) && !/^\s*(?:n\/?a|none|out[ -]of[ -]scope|unrelated|not relevant|irrelevant)\s*[.!]?\s*$/iu.test(v);
const glob = (v: unknown): v is string => text(v, 256) && !v.startsWith("/") && !v.includes("\\") &&
  !/[\n\r]/u.test(v) && v.split("/").every(part => part !== "" && part !== "." && part !== "..");
const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;

function invalid(message: string): never {
  throw new AgentOpsError("SURFACE_MISSING", message);
}

function axis(value: unknown, name: string): SurfaceAxis {
  if (record(value) && exact(value, ["na"])) {
    if (!reason(value.na)) invalid(`Axis ${name} n/a needs a reason the axis cannot apply.`);
    return {na: value.na};
  }
  if (!record(value) || !exact(value, ["queries"]) || !list(value.queries, 32) || value.queries.length === 0 ||
    !value.queries.every(q => text(q, 256) && !/[\n\r]/u.test(q)) || new Set(value.queries).size !== value.queries.length)
    invalid(`Axis ${name} needs 1-32 unique single-line fixed-string queries or {na: reason}.`);
  return {queries: [...value.queries as string[]]};
}

/** Strict parse of a stored or submitted surface; any defect is SURFACE_MISSING. */
export function parseSurface(value: unknown): TaskSurface {
  if (record(value) && exact(value, ["covers"])) {
    if (!list(value.covers, 256) || value.covers.length === 0 || !value.covers.every(id) || new Set(value.covers).size !== value.covers.length)
      invalid("covers must list unique parent surface IDs.");
    return {covers: [...value.covers as string[]]};
  }
  if (!record(value) || !exact(value, ["axes", "included", "excluded", "unknown", "contracts", "valueChanges", "scenarios"], ["dismissed"]))
    invalid("Surface file needs axes, included, excluded, unknown, contracts, valueChanges and scenarios (or covers for a child).");
  const axes = value.axes;
  if (!record(axes) || !exact(axes, [...SURFACE_AXES])) invalid("axes must name dependents, duplicates, otherPaths and sharedState.");
  const ids = new Set<string>();
  const unique = (v: string) => { if (ids.has(v)) invalid(`Duplicate surface ID ${v}.`); ids.add(v); return v; };
  if (!list(value.included, 256) || value.included.length === 0) invalid("included needs at least one surface (a single surface is fine).");
  const included = value.included.map(row => {
    if (!record(row) || !exact(row, ["id", "path", "behavior"]) || !id(row.id) || !glob(row.path) || !text(row.behavior))
      invalid("Each included surface needs id, path glob and observable behavior.");
    return {id: unique(row.id), path: row.path, behavior: row.behavior};
  });
  if (!list(value.excluded, 256)) invalid("excluded must be a list.");
  const excluded = value.excluded.map(row => {
    if (!record(row) || !exact(row, ["glob", "reason"]) || !glob(row.glob))
      invalid("Each exclusion needs a path glob and a reason.");
    if (!reason(row.reason)) invalid(`Exclusion ${row.glob}: say why the surface is unaffected; "out of scope" is not a reason.`);
    return {glob: row.glob, reason: row.reason};
  });
  if (!list(value.unknown, 256)) invalid("unknown must be a list.");
  const unknown = value.unknown.map(row => {
    if (!record(row) || !exact(row, ["id", "reader", "behavior"], ["path"]) || !id(row.id) || !text(row.reader) ||
      !text(row.behavior) || (row.path !== undefined && !glob(row.path)))
      invalid("Each UNKNOWN surface needs id, reader, behavior and an optional path glob.");
    return {id: unique(row.id), reader: row.reader, behavior: row.behavior, ...(row.path === undefined ? {} : {path: row.path as string})};
  });
  if (!list(value.contracts, 256)) invalid("contracts must be a list.");
  const contracts = value.contracts.map(row => {
    if (!record(row) || !exact(row, ["id", "name", "change", "behavior"]) || !id(row.id) || !text(row.name) ||
      (row.change !== "compatible" && row.change !== "breaking") || !text(row.behavior))
      invalid("Each shared contract needs id, name, change compatible|breaking and behavior.");
    return {id: unique(row.id), name: row.name, change: row.change as "compatible" | "breaking", behavior: row.behavior};
  });
  if (!list(value.valueChanges, 128)) invalid("valueChanges must be a list.");
  const valueChanges = value.valueChanges.map(row => {
    if (!record(row) || !exact(row, ["producer", "kind", "change", "consumers", "indirectConsumers"]) || !text(row.producer) ||
      !VALUE_CHANGE_KINDS.includes(row.kind as never) || !text(row.change) ||
      !list(row.consumers, 64) || row.consumers.length === 0 || !row.consumers.every(c => text(c, 512)) ||
      !list(row.indirectConsumers, 64) || !row.indirectConsumers.every(c => text(c, 512)))
      invalid("Each value change needs producer, kind, change, consumers (first hop) and indirectConsumers (second hop).");
    return {producer: row.producer, kind: row.kind as typeof VALUE_CHANGE_KINDS[number], change: row.change,
      consumers: [...row.consumers as string[]], indirectConsumers: [...row.indirectConsumers as string[]]};
  });
  const scenarios = value.scenarios;
  if (!record(scenarios) || Object.keys(scenarios).some(k => !SCENARIO_DIMENSIONS.includes(k as ScenarioId)))
    invalid(`scenarios may name only ${SCENARIO_DIMENSIONS.join(", ")}.`);
  const parsedScenarios: Partial<Record<ScenarioId, SurfaceScenario>> = {};
  for (const [key, row] of Object.entries(scenarios)) {
    if (record(row) && exact(row, ["applies", "behavior"]) && row.applies === true && text(row.behavior))
      parsedScenarios[key as ScenarioId] = {applies: true, behavior: row.behavior};
    else if (record(row) && exact(row, ["na"]) && reason(row.na)) parsedScenarios[key as ScenarioId] = {na: row.na};
    else invalid(`Scenario ${key} needs {applies: true, behavior} or {na: reason}.`);
  }
  let dismissed: { query: string; reason: string }[] | undefined;
  if (value.dismissed !== undefined) {
    if (!list(value.dismissed, 256)) invalid("dismissed must be a list.");
    const seen = new Set<string>();
    dismissed = value.dismissed.map(row => {
      if (!record(row) || !exact(row, ["query", "reason"]) || !text(row.query, 256) || /[\n\r]/u.test(row.query) || seen.has(row.query))
        invalid("Each dismissal needs a unique single-line query and a reason.");
      seen.add(row.query);
      if (!reason(row.reason) || row.reason.length > 256)
        invalid(`Dismissal ${row.query}: say in at most 256 characters why its hits are incidental; "out of scope" is not a reason.`);
      return {query: row.query, reason: row.reason};
    });
  }
  return {
    axes: Object.fromEntries(SURFACE_AXES.map(name => [name, axis(axes[name], name)])) as Record<SurfaceAxisId, SurfaceAxis>,
    included, excluded, unknown, contracts, valueChanges, scenarios: parsedScenarios, ...(dismissed === undefined ? {} : {dismissed})
  };
}

export function missingScenarios(surface: SurfaceAudit): ScenarioId[] {
  return SCENARIO_DIMENSIONS.filter(name => surface.scenarios[name] === undefined);
}

/** `**` crosses directories, `*` and `?` stay within one segment. */
export function globMatcher(pattern: string): (path: string) => boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  const expression = new RegExp(`^${source}$`, "u");
  return path => expression.test(path);
}

export type SurfaceDelta = "unchanged" | {
  readonly added?: Readonly<Record<string, readonly unknown[]>>;
  readonly removed?: Readonly<Record<string, readonly unknown[]>>;
  readonly changed?: Readonly<Record<string, { readonly before: unknown; readonly after: unknown }>>;
};

/** What one revision did to the surface: list rows added/removed, other fields before/after. Size follows the edit, not the audit. */
export function surfaceDelta(before: TaskSurface | null | undefined, after: TaskSurface | null | undefined): SurfaceDelta {
  const key = (value: unknown) => canonicalJson(value ?? null);
  if (key(before) === key(after)) return "unchanged";
  const from = (before ?? {}) as Record<string, unknown>, to = (after ?? {}) as Record<string, unknown>;
  const added: Record<string, unknown[]> = {}, removed: Record<string, unknown[]> = {};
  const changed: Record<string, { before: unknown; after: unknown }> = {};
  for (const field of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
    const a = from[field], b = to[field];
    if (key(a) === key(b)) continue;
    if (Array.isArray(a) && Array.isArray(b)) {
      const old = new Set(a.map(key)), next = new Set(b.map(key));
      const plus = b.filter(row => !old.has(key(row))), minus = a.filter(row => !next.has(key(row)));
      if (plus.length > 0) added[field] = plus;
      if (minus.length > 0) removed[field] = minus;
    } else changed[field] = {before: a ?? null, after: b ?? null};
  }
  return {...(Object.keys(added).length > 0 ? {added} : {}), ...(Object.keys(removed).length > 0 ? {removed} : {}),
    ...(Object.keys(changed).length > 0 ? {changed} : {})};
}
