import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { appendLocalLog } from "../logging/local-log.js";
import { localStatePaths, readPrivateFile, writePrivateFile } from "../security/permissions.js";
import { globMatcher, isCovers, missingScenarios, parseSurface, SURFACE_AXES, type SurfaceAudit, type TaskSurface } from "./schema.js";

export type SurfaceCode = "SURFACE_MISSING" | "SURFACE_UNCLASSIFIED" | "SURFACE_QUERY_TOO_BROAD" |
  "SURFACE_EXCLUSION_TOO_BROAD" | "SCENARIO_MISSING" | "SURFACE_BUDGET_EXCEEDED" | "SURFACE_UNASSIGNED";
/** Cheapest first: a budget overrun stops before the long tail of diff tokens. */
export const DISCOVERY_SOURCES = ["agent", "hunk-header", "template-fragment", "diff-token"] as const;
export type DiscoverySource = typeof DISCOVERY_SOURCES[number];

export const SURFACE_LIMITS = {
  agentQueryFiles: 200, derivedQueryFiles: 30, exclusionFiles: 10, budgetMs: 120_000, queryTimeoutMs: 30_000,
  tokenLength: 6, fragmentLength: 4, derivedQueries: 400
} as const;

export interface SurfaceDiscovery {
  readonly cached: boolean;
  readonly sources: Readonly<Record<DiscoverySource, { readonly queries: number; readonly files: number }>>;
  /** Derived queries too generic to classify (> derivedQueryFiles hits); never agent queries. */
  readonly skipped: readonly { readonly source: DiscoverySource; readonly query: string; readonly files: number }[];
  /** Exclusions that now hide a file an earlier SURFACE_UNCLASSIFIED block named. */
  readonly postBlockExclusions: readonly { readonly path: string; readonly glob: string; readonly reason: string }[];
}

export type SurfaceGateResult =
  | { readonly status: "PASS"; readonly discovery: SurfaceDiscovery | null }
  | { readonly status: "NOT_RUN"; readonly code: SurfaceCode; readonly message: string; readonly details: readonly unknown[];
      readonly discovery?: SurfaceDiscovery };

export interface SurfaceGateInput {
  readonly root: string;
  readonly taskId: string;
  /** The tree root's audit; a child's own `covers` never stands in for it. */
  readonly surface: TaskSurface | undefined;
  readonly required: boolean;
  readonly children?: readonly { readonly taskId: string; readonly covers: readonly string[] }[];
  /** Resolved base commit; absent compares the working tree with HEAD. */
  readonly base?: string;
  readonly changedFiles: readonly string[];
  readonly configHash: string;
  readonly budgetMs?: number;
  readonly now?: () => number;
  /** Advisory profile active: per-source counts go to the local log. */
  readonly metrics?: boolean;
  readonly logHome?: string;
}

interface GitResult { readonly code: number | null; readonly stdout: Buffer; readonly timedOut: boolean }

/** argv only: queries are task text and must never meet a shell or a regex engine. */
function git(root: string, args: readonly string[], timeoutMs: number): Promise<GitResult> {
  return new Promise(resolve => {
    execFile("git", [...args], {cwd: root, encoding: "buffer", timeout: Math.max(1, timeoutMs), maxBuffer: 64 * 1024 * 1024, shell: false},
      (error, stdout) => {
        const failure = error as (NodeJS.ErrnoException & {killed?: boolean; code?: unknown}) | null;
        resolve({code: failure === null ? 0 : typeof failure.code === "number" ? failure.code : null,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0), timedOut: failure?.killed === true});
      });
  });
}

const zList = (value: Buffer) => value.toString("utf8").split("\0").filter(Boolean);

// Language keywords long enough to pass the length floor carry no surface signal.
const STOP = new Set(["return", "import", "export", "default", "function", "extends", "implements", "interface", "public",
  "private", "protected", "static", "struct", "string", "number", "boolean", "object", "symbol", "typeof", "instanceof",
  "delete", "select", "insert", "update", "values", "create", "require", "module", "exports", "global", "continue",
  "switch", "package", "abstract", "unsigned", "virtual", "override", "readonly", "declare", "namespace", "undefined",
  "nullptr", "lambda", "elseif", "except", "finally", "assert", "yield", "async", "await", "should", "expect",
  "describe", "result", "props", "children", "className", "length", "constructor", "prototype", "console", "Promise"]);
const SEPARATOR = /^[:._/#-]|[:._/#-]$/u;
const LITERAL = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\\n]|\\.)*)`/gu;
const COMPOUND = /[a-z0-9][A-Z]|[A-Za-z0-9][_$][A-Za-z0-9]|[A-Za-z][0-9]/u;
const INTERPOLATION = /\$\{[^}]*\}|\{[^}]*\}|%[sdifjo]/u;

function functionName(context: string): string | undefined {
  const match = /\b(?:function|def|func|fn|class|interface|struct|sub|procedure|type)\s+([A-Za-z_$][\w$]*)/u.exec(context) ??
    /([A-Za-z_$][\w$]*)\s*[=:]\s*(?:async\s*)?(?:function\b|\()/u.exec(context) ?? /([A-Za-z_$][\w$]*)\s*\(/u.exec(context);
  const name = match?.[1];
  return name !== undefined && name.length >= SURFACE_LIMITS.fragmentLength && !STOP.has(name) ? name : undefined;
}

/** Fixed strings a change implies: literals and identifiers, template fragments, enclosing functions. */
export function extractDiffQueries(diff: string): { tokens: string[]; fragments: string[]; functions: string[] } {
  const tokens = new Set<string>(), fragments = new Set<string>(), functions = new Set<string>();
  for (const line of diff.split("\n")) {
    const hunk = /^@@ [^@]* @@ ?(.*)$/u.exec(line);
    if (hunk !== null) {
      const name = functionName(hunk[1] ?? "");
      if (name !== undefined) functions.add(name);
      continue;
    }
    if (!/^[+-]/u.test(line) || line.startsWith("+++") || line.startsWith("---")) continue;
    const body = line.slice(1);
    for (const literal of body.matchAll(LITERAL)) {
      const content = literal[1] ?? literal[2] ?? literal[3] ?? "";
      for (const piece of content.split(new RegExp(INTERPOLATION.source, "gu")))
        if (piece.length >= SURFACE_LIMITS.fragmentLength && SEPARATOR.test(piece) && piece.trim() === piece) fragments.add(piece);
      if (!INTERPOLATION.test(content) && content.trim().length >= SURFACE_LIMITS.tokenLength) tokens.add(content);
    }
    // ponytail: compound identifiers only (snake_case, camelCase, digits), so prose
    // words in docs and comments are not queries; aliases are phase 2.
    for (const identifier of body.replace(LITERAL, " ").matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/gu))
      if (identifier[0].length >= SURFACE_LIMITS.tokenLength && !STOP.has(identifier[0]) && COMPOUND.test(identifier[0]))
        tokens.add(identifier[0]);
  }
  // ponytail: fixed caps on derived queries; the 120 s budget bounds the rest.
  const cap = (values: Set<string>) => [...values].slice(0, SURFACE_LIMITS.derivedQueries);
  return {tokens: cap(tokens), fragments: cap(fragments), functions: cap(functions)};
}

function notRun(code: SurfaceCode, message: string, details: readonly unknown[], discovery?: SurfaceDiscovery): SurfaceGateResult {
  return {status: "NOT_RUN", code, message, details: details.slice(0, 200), ...(discovery === undefined ? {} : {discovery})};
}

/** Advisory metrics: fail-open, never evidence. */
async function logMetrics(home: string, rows: readonly Record<string, number | string>[]): Promise<void> {
  try {
    const state = localStatePaths(home);
    for (const row of rows) await appendLocalLog(join(state.logDirectory, "events.ndjson"),
      {type: "surface-metrics", ...row} as never, {anchorDirectory: state.anchorDirectory});
  } catch { /* advisory only */ }
}

export async function logSurfaceResidualRisks(count: number, home = process.env.AGENT_OPS_HOME ?? homedir()): Promise<void> {
  await logMetrics(home, [{source: "review", hits: 0, included: 0, excluded: 0, postBlockExclusions: 0, residualRisks: count}]);
}

/** EVIDENCE-SURFACE-001 gate run before any reviewer: every hit must be classified. */
export async function runSurfaceGate(input: SurfaceGateInput): Promise<SurfaceGateResult> {
  if (input.surface === undefined) return input.required
    ? notRun("SURFACE_MISSING", "This task requires a surface audit: task revise --surface-file <json>.", []) : {status: "PASS", discovery: null};
  let surface: SurfaceAudit;
  try {
    const parsed = parseSurface(input.surface);
    if (isCovers(parsed)) return notRun("SURFACE_MISSING", "A covers-only surface needs a surfaced parent.", []);
    surface = parsed;
  } catch (error) {
    return notRun("SURFACE_MISSING", error instanceof Error ? error.message : "Unparseable surface.", []);
  }
  const scenarios = missingScenarios(surface);
  if (scenarios.length > 0) return notRun("SCENARIO_MISSING", "Every scenario dimension needs applies+behavior or n/a: reason.", scenarios);
  if (input.children !== undefined && input.children.length > 0) {
    const included = new Set(surface.included.map(row => row.id));
    const covered = new Set(input.children.flatMap(child => child.covers));
    const uncovered = [...included].filter(id => !covered.has(id));
    const unknown = [...covered].filter(id => !included.has(id));
    if (uncovered.length > 0 || unknown.length > 0)
      return notRun("SURFACE_UNASSIGNED", "Children covers must equal the parent included surfaces.", [{uncovered, unknown}]);
  }
  const now = input.now ?? Date.now;
  const started = now();
  const budget = input.budgetMs ?? SURFACE_LIMITS.budgetMs;
  const remaining = () => budget - (now() - started);
  const changed = new Set(input.changedFiles);
  const tracked = await git(input.root, ["ls-files", "-z"], Math.min(SURFACE_LIMITS.queryTimeoutMs, Math.max(1, remaining())));
  if (tracked.timedOut || remaining() <= 0) return notRun("SURFACE_BUDGET_EXCEEDED", "Discovery budget exhausted listing files.", []);
  const exclusions = surface.excluded.map(row => ({...row, match: globMatcher(row.glob)}));
  for (const row of exclusions) {
    const files = zList(tracked.stdout).filter(row.match);
    const diffFiles = [...changed].filter(row.match);
    if (files.length > SURFACE_LIMITS.exclusionFiles || diffFiles.length > 0)
      return notRun("SURFACE_EXCLUSION_TOO_BROAD", diffFiles.length > 0 ? "Files in the diff cannot be excluded."
        : `One exclusion may hide at most ${SURFACE_LIMITS.exclusionFiles} files.`, [{glob: row.glob, files: files.length, diffFiles}]);
  }
  const head = (await git(input.root, ["rev-parse", "HEAD"], SURFACE_LIMITS.queryTimeoutMs)).stdout.toString("utf8").trim();
  const diff = (await git(input.root, ["diff", "-U0", "--no-color", "--no-ext-diff", input.base ?? "HEAD", "--"],
    SURFACE_LIMITS.queryTimeoutMs)).stdout.toString("utf8");
  const derived = extractDiffQueries(diff);
  const agent = [...new Set(SURFACE_AXES.flatMap(name => {const axis = surface.axes[name]; return "queries" in axis ? axis.queries : [];}))];
  const planned: {source: DiscoverySource; query: string}[] = [];
  const seen = new Set<string>();
  for (const [source, queries] of [["agent", agent], ["hunk-header", derived.functions], ["template-fragment", derived.fragments],
    ["diff-token", derived.tokens]] as const)
    for (const query of queries) if (!seen.has(query)) { seen.add(query); planned.push({source, query}); }
  const key = sha256(canonicalJson({head, base: input.base ?? null, diff: sha256(diff), queries: [...agent].sort(), config: input.configHash}));
  const cachePath = join(input.root, ".agent-ops", "tasks", "surface", "cache", key + ".json");
  let hits: {source: DiscoverySource; query: string; files: string[]}[] | undefined;
  let cached = false;
  try {
    const stored = await readPrivateFile(cachePath, input.root);
    if (stored !== null) { hits = JSON.parse(stored) as typeof hits; cached = true; }
  } catch { hits = undefined; }
  if (hits === undefined) {
    hits = [];
    for (const {source, query} of planned) {
      if (remaining() <= 0) return notRun("SURFACE_BUDGET_EXCEEDED",
        `Discovery exceeded its ${budget} ms budget; narrow the diff or queries. Remaining queries were not skipped silently.`,
        [{source, query, remaining: planned.length - hits.length}]);
      const result = await git(input.root, ["grep", "-F", "-l", "-z", "-I", "--no-color", "-e", query, "--"],
        Math.min(SURFACE_LIMITS.queryTimeoutMs, remaining()));
      if (result.timedOut) return notRun("SURFACE_BUDGET_EXCEEDED", "A discovery query timed out.", [{source, query}]);
      hits.push({source, query, files: result.code === 0 ? zList(result.stdout) : []});
    }
    await writePrivateFile(cachePath, JSON.stringify(hits), input.root).catch(() => undefined);
  }
  const included = surface.included.map(row => globMatcher(row.path));
  const unknownPaths = surface.unknown.flatMap(row => row.path === undefined ? [] : [globMatcher(row.path)]);
  const blockPath = join(input.root, ".agent-ops", "tasks", "surface", input.taskId + ".blocks.json");
  let blocked: string[] = [];
  try { blocked = JSON.parse(await readPrivateFile(blockPath, input.root) ?? "[]") as string[]; } catch { blocked = []; }
  const postBlockExclusions = blocked.flatMap(path => {
    const row = exclusions.find(exclusion => exclusion.match(path));
    return row === undefined ? [] : [{path, glob: row.glob, reason: row.reason}];
  });
  const sources = Object.fromEntries(DISCOVERY_SOURCES.map(source => [source, {queries: 0, files: 0}])) as Record<DiscoverySource, {queries: number; files: number}>;
  const skipped: {source: DiscoverySource; query: string; files: number}[] = [];
  const unclassified = new Map<string, {source: DiscoverySource; query: string}[]>();
  const metrics = new Map<DiscoverySource, {hits: Set<string>; included: Set<string>; excluded: Set<string>}>(
    DISCOVERY_SOURCES.map(source => [source, {hits: new Set(), included: new Set(), excluded: new Set()}]));
  for (const hit of hits) {
    sources[hit.source].queries += 1;
    if (hit.source === "agent" && hit.files.length > SURFACE_LIMITS.agentQueryFiles)
      return notRun("SURFACE_QUERY_TOO_BROAD", `Query hits more than ${SURFACE_LIMITS.agentQueryFiles} files; record a more specific fixed string.`,
        [{query: hit.query, files: hit.files.length}]);
    if (hit.source !== "agent" && hit.files.length > SURFACE_LIMITS.derivedQueryFiles) {
      skipped.push({source: hit.source, query: hit.query, files: hit.files.length});
      continue;
    }
    const metric = metrics.get(hit.source)!;
    for (const path of hit.files) {
      metric.hits.add(path);
      if (changed.has(path) || included.some(match => match(path)) || unknownPaths.some(match => match(path))) metric.included.add(path);
      else if (exclusions.some(row => row.match(path))) metric.excluded.add(path);
      else unclassified.set(path, [...(unclassified.get(path) ?? []), {source: hit.source, query: hit.query}]);
    }
  }
  for (const source of DISCOVERY_SOURCES) sources[source].files = metrics.get(source)!.hits.size;
  const discovery: SurfaceDiscovery = {cached, sources, skipped: skipped.slice(0, 50), postBlockExclusions};
  if (input.metrics === true) await logMetrics(input.logHome ?? process.env.AGENT_OPS_HOME ?? homedir(), DISCOVERY_SOURCES.map(source => ({source,
    hits: metrics.get(source)!.hits.size, included: metrics.get(source)!.included.size, excluded: metrics.get(source)!.excluded.size,
    postBlockExclusions: postBlockExclusions.length, residualRisks: 0})));
  if (unclassified.size > 0) {
    const paths = [...unclassified.keys()].sort();
    await writePrivateFile(blockPath, JSON.stringify([...new Set([...blocked, ...paths])].sort()), input.root).catch(() => undefined);
    return notRun("SURFACE_UNCLASSIFIED", "Discovery found places outside the diff and the surface lists; include, exclude with a reason, or mark UNKNOWN.",
      paths.map(path => ({path, hits: unclassified.get(path)!.slice(0, 5)})), discovery);
  }
  return {status: "PASS", discovery};
}
