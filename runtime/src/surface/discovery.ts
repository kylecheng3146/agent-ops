import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { canonicalJson } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { lessonFires, loadLessons } from "../escape/lessons.js";
import { loadRules, ruleFires, ruleHits } from "../escape/rules.js";
import { AgentOpsError } from "../fs/paths.js";
import { appendLocalLog, type EscapeLessonLogEvent, type EscapeRuleLogEvent } from "../logging/local-log.js";
import { localStatePaths, readPrivateFile, writePrivateFile } from "../security/permissions.js";
import { globMatcher, isCovers, missingScenarios, parseSurface, SURFACE_AXES, type SurfaceAudit, type TaskSurface } from "./schema.js";

export type SurfaceCode = "SURFACE_MISSING" | "SURFACE_UNCLASSIFIED" | "SURFACE_QUERY_TOO_BROAD" |
  "SURFACE_EXCLUSION_TOO_BROAD" | "SURFACE_INCLUSION_TOO_BROAD" | "SCENARIO_MISSING" | "SURFACE_BUDGET_EXCEEDED" | "SURFACE_UNASSIGNED" |
  "ESCAPE_RULE_INVALID" | "ESCAPE_RULE_UNSAFE" | "ESCAPE_RULE_NO_EXCLUDE" | "SURFACE_DISMISSAL_TOO_BROAD" | "SURFACE_DISMISSAL_INVALID" |
  "SURFACE_DISCOVERY_FAILED" | "LESSON_MISSING" | "ESCAPE_LESSON_INVALID" | "ESCAPE_LESSON_UNSAFE";
/** Cheapest first: a budget overrun stops before the long tail of diff tokens. */
export const DISCOVERY_SOURCES = ["agent", "hunk-header", "template-fragment", "diff-token"] as const;
export type DiscoverySource = typeof DISCOVERY_SOURCES[number];

export const SURFACE_LIMITS = {
  // ponytail: derived queries over 10 files outside the diff are skipped as generic; incidental ones under that are dismissed by query.
  agentQueryFiles: 200, derivedQueryFiles: 10, exclusionFiles: 10, inclusionFiles: 10, dismissals: 128, dismissMinFiles: 4, budgetMs: 120_000, queryTimeoutMs: 30_000,
  tokenLength: 6, fragmentLength: 4, derivedQueries: 400
} as const;

export interface SurfaceDiscovery {
  readonly cached: boolean;
  readonly sources: Readonly<Record<DiscoverySource, { readonly queries: number; readonly files: number }>>;
  /** Derived queries too generic to classify (> derivedQueryFiles hits outside the diff), fewest first; never agent queries. */
  readonly skipped: readonly { readonly source: DiscoverySource; readonly query: string; readonly files: number }[];
  /** Exclusions that now hide a file an earlier SURFACE_UNCLASSIFIED block named. */
  readonly postBlockExclusions: readonly { readonly path: string; readonly glob: string; readonly reason: string }[];
  /** Dismissed derived queries with their hit count outside the diff; postBlock when one hid a blocked file. */
  readonly dismissed: readonly { readonly query: string; readonly files: number; readonly postBlock: boolean }[];
  /** Derived queries over the per-kind cap that were never searched, by source; empty under the cap. */
  readonly truncated: readonly { readonly source: DiscoverySource; readonly dropped: number }[];
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
export function extractDiffQueries(diff: string):
  { tokens: string[]; fragments: string[]; functions: string[]; dropped: Record<Exclude<DiscoverySource, "agent">, number> } {
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
  // ponytail: fixed caps on derived queries, reported as dropped; the 120 s budget bounds the rest.
  const cap = (values: Set<string>) => [...values].slice(0, SURFACE_LIMITS.derivedQueries);
  const over = (values: Set<string>) => Math.max(0, values.size - SURFACE_LIMITS.derivedQueries);
  return {tokens: cap(tokens), fragments: cap(fragments), functions: cap(functions),
    dropped: {"hunk-header": over(functions), "template-fragment": over(fragments), "diff-token": over(tokens)}};
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

async function logRuleMetrics(home: string, rows: readonly (EscapeRuleLogEvent | EscapeLessonLogEvent)[]): Promise<void> {
  try {
    const state = localStatePaths(home);
    for (const row of rows) await appendLocalLog(join(state.logDirectory, "events.ndjson"), row, {anchorDirectory: state.anchorDirectory});
  } catch { /* advisory only */ }
}

/** Verify's advisory lines: the review-time stop to fix first, and derived queries discovery never searched. */
export function surfaceAdvisory(gate: SurfaceGateResult): string[] {
  const truncated = gate.discovery?.truncated ?? [];
  const dropped = truncated.length === 0 ? [] : [`Surface: ${truncated.reduce((sum, row) => sum + row.dropped, 0)} derived queries ` +
    `were not searched (${truncated.map(row => `${row.source} ${row.dropped}`).join(", ")})`];
  if (gate.status === "PASS") return ["Surface: PASS", ...dropped];
  const paths = gate.details.flatMap(d => typeof d === "object" && d !== null && "path" in d ? [String(d.path)]
    : typeof d === "object" && d !== null && "lesson" in d ? [`lesson ${String(d.lesson)}`] : []);
  return [`Surface (advisory; review would stop with ${gate.code}): ${gate.message}`,
    ...paths.slice(0, 20).map(path => `  - ${path}`), ...(paths.length > 20 ? [`  ... ${paths.length - 20} more`] : []), ...dropped];
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
  // Escape Loop R2: learned rules fail closed before any discovery.
  let rules: Awaited<ReturnType<typeof loadRules>>;
  try { rules = await loadRules(input.root); }
  catch (error) {
    if (error instanceof AgentOpsError && (error.code === "ESCAPE_RULE_INVALID" || error.code === "ESCAPE_RULE_UNSAFE"))
      return notRun(error.code, error.message, []);
    throw error;
  }
  let lessons: Awaited<ReturnType<typeof loadLessons>>;
  try { lessons = await loadLessons(input.root); }
  catch (error) {
    if (error instanceof AgentOpsError && (error.code === "ESCAPE_LESSON_INVALID" || error.code === "ESCAPE_LESSON_UNSAFE"))
      return notRun(error.code, error.message, []);
    throw error;
  }
  const now = input.now ?? Date.now;
  const started = now();
  const budget = input.budgetMs ?? SURFACE_LIMITS.budgetMs;
  const remaining = () => budget - (now() - started);
  // A git or read failure must stop review: treating it as "no hits" would pass an unproven surface.
  const failed = (detail: Record<string, string>) => notRun("SURFACE_DISCOVERY_FAILED",
    "Discovery could not finish (a git command failed or a changed file was unreadable), so it cannot show the surface is covered; fix the cause and rerun.",
    [detail]);
  const changed = new Set(input.changedFiles);
  const tracked = await git(input.root, ["ls-files", "-z"], Math.min(SURFACE_LIMITS.queryTimeoutMs, Math.max(1, remaining())));
  if (tracked.timedOut || remaining() <= 0) return notRun("SURFACE_BUDGET_EXCEEDED", "Discovery budget exhausted listing files.", []);
  if (tracked.code !== 0) return failed({command: "git ls-files"});
  const trackedFiles = zList(tracked.stdout);
  const exclusions = surface.excluded.map(row => ({...row, match: globMatcher(row.glob)}));
  for (const row of exclusions) {
    const files = trackedFiles.filter(row.match);
    const diffFiles = [...changed].filter(row.match);
    if (files.length > SURFACE_LIMITS.exclusionFiles || diffFiles.length > 0)
      return notRun("SURFACE_EXCLUSION_TOO_BROAD", diffFiles.length > 0 ? "Files in the diff cannot be excluded."
        : `One exclusion may hide at most ${SURFACE_LIMITS.exclusionFiles} files.`, [{glob: row.glob, files: files.length, diffFiles}]);
  }
  // An included or UNKNOWN glob classifies every hit it matches, so it is capped like an exclusion.
  for (const glob of [...surface.included.map(row => row.path), ...surface.unknown.flatMap(row => row.path === undefined ? [] : [row.path])]) {
    const match = globMatcher(glob);
    const files = trackedFiles.filter(path => match(path) && !changed.has(path)).length;
    if (files > SURFACE_LIMITS.inclusionFiles)
      return notRun("SURFACE_INCLUSION_TOO_BROAD", `One included or UNKNOWN glob may cover at most ${SURFACE_LIMITS.inclusionFiles} ` +
        "files outside the diff; list narrower paths, each with its own behavior.", [{glob, files}]);
  }
  const headResult = await git(input.root, ["rev-parse", "HEAD"], SURFACE_LIMITS.queryTimeoutMs);
  if (headResult.code !== 0) return failed({command: "git rev-parse"});
  const head = headResult.stdout.toString("utf8").trim();
  const diffResult = await git(input.root, ["diff", "-U0", "--no-color", "--no-ext-diff", input.base ?? "HEAD", "--"],
    SURFACE_LIMITS.queryTimeoutMs);
  if (diffResult.code !== 0) return failed({command: "git diff"});
  let diff = diffResult.stdout.toString("utf8");
  // Worktree mode: an untracked file in the change scope is all added lines, which git diff never shows.
  if (input.base === undefined) {
    const indexed = new Set(trackedFiles);
    for (const path of input.changedFiles.filter(path => !indexed.has(path))) {
      let content: Buffer;
      try {
        // Never follow a symlink out of the worktree; git records only its target text.
        if (!(await lstat(join(input.root, path))).isFile()) continue;
        content = await readFile(join(input.root, path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return failed({path, error: String((error as NodeJS.ErrnoException).code ?? "read")});
      }
      // NUL marks binary, as git grep -I treats it.
      if (!content.includes(0)) diff += "\n" + content.toString("utf8").split("\n").map(line => "+" + line).join("\n");
    }
  }
  // Escape lessons: a fired lesson is classified in surface.lessons before any reviewer, like a scenario.
  const fired = lessons.filter(({lesson}) => lessonFires(lesson, [...changed], diff));
  const answers = surface.lessons ?? {};
  const answerOf = (id: string) => answers[id] === undefined ? "unanswered" as const : "applies" in answers[id]! ? "applies" as const : "na" as const;
  if (input.metrics === true && fired.length > 0) await logRuleMetrics(input.logHome ?? process.env.AGENT_OPS_HOME ?? homedir(),
    fired.map(({lesson}) => ({type: "escape-lesson", lessonId: lesson.id, answer: answerOf(lesson.id)})));
  const unanswered = fired.filter(({lesson}) => answerOf(lesson.id) === "unanswered");
  if (unanswered.length > 0) return notRun("LESSON_MISSING", "Fired escape lessons need an answer in the surface lessons key: " +
    "{applies: true, behavior} or {na: reason}.", unanswered.map(({lesson}) => ({lesson: lesson.id, cue: lesson.cue, check: lesson.check})));
  const derived = extractDiffQueries(diff);
  const agent = [...new Set(SURFACE_AXES.flatMap(name => {const axis = surface.axes[name]; return "queries" in axis ? axis.queries : [];}))];
  const planned: {source: DiscoverySource; query: string}[] = [];
  const seen = new Set<string>();
  for (const [source, queries] of [["agent", agent], ["hunk-header", derived.functions], ["template-fragment", derived.fragments],
    ["diff-token", derived.tokens]] as const)
    for (const query of queries) if (!seen.has(query)) { seen.add(query); planned.push({source, query}); }
  const key = sha256(canonicalJson({head, base: input.base ?? null, diff: sha256(diff), queries: [...agent].sort(), config: input.configHash,
    lessons: lessons.map(row => row.hash).sort()}));
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
      // Exit 1 is "no match"; anything else (including a signal) is a failure, never an empty hit list.
      if (result.code !== 0 && result.code !== 1) return failed({command: "git grep", query});
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
  const unclassified = new Map<string, {source: DiscoverySource | "escape-rule"; query: string}[]>();
  const metrics = new Map<DiscoverySource, {hits: Set<string>; included: Set<string>; excluded: Set<string>}>(
    DISCOVERY_SOURCES.map(source => [source, {hits: new Set(), included: new Set(), excluded: new Set()}]));
  const dismissals = new Map((surface.dismissed ?? []).map(row => [row.query, row.reason]));
  if (dismissals.size > SURFACE_LIMITS.dismissals)
    return notRun("SURFACE_DISMISSAL_TOO_BROAD", `At most ${SURFACE_LIMITS.dismissals} queries may be dismissed; split the change.`,
      [{dismissed: dismissals.size}]);
  const recorded = new Set(agent);
  const dismissed: {query: string; files: number; postBlock: boolean}[] = [];
  for (const query of dismissals.keys()) {
    if (recorded.has(query)) return notRun("SURFACE_DISMISSAL_INVALID", "A recorded axis query cannot be dismissed; classify its hits.", [{query}]);
    const hit = hits.find(row => row.query === query && row.source !== "agent");
    const outside = hit === undefined ? [] : hit.files.filter(path => !changed.has(path));
    if (hit !== undefined && outside.length < SURFACE_LIMITS.dismissMinFiles)
      return notRun("SURFACE_DISMISSAL_INVALID", `A query reaching fewer than ${SURFACE_LIMITS.dismissMinFiles} files outside the diff ` +
        "is the likeliest sibling signal and cannot be dismissed; classify its files.", [{query, files: outside}]);
    if (hit !== undefined) dismissed.push({query, files: outside.length, postBlock: outside.some(path => blocked.includes(path))});
  }
  for (const hit of hits) {
    sources[hit.source].queries += 1;
    if (hit.source === "agent" && hit.files.length > SURFACE_LIMITS.agentQueryFiles)
      return notRun("SURFACE_QUERY_TOO_BROAD", `Query hits more than ${SURFACE_LIMITS.agentQueryFiles} files; record a more specific fixed string.`,
        [{query: hit.query, files: hit.files.length}]);
    const outside = hit.files.filter(path => !changed.has(path)).length;
    if (hit.source !== "agent" && outside > SURFACE_LIMITS.derivedQueryFiles) {
      skipped.push({source: hit.source, query: hit.query, files: outside});
      continue;
    }
    if (hit.source !== "agent" && dismissals.has(hit.query)) continue;
    const metric = metrics.get(hit.source)!;
    for (const path of hit.files) {
      metric.hits.add(path);
      if (changed.has(path) || included.some(match => match(path)) || unknownPaths.some(match => match(path))) metric.included.add(path);
      else if (exclusions.some(row => row.match(path))) metric.excluded.add(path);
      else unclassified.set(path, [...(unclassified.get(path) ?? []), {source: hit.source, query: hit.query}]);
    }
  }
  // A fired rule's hits must be classified like any other; noExclude hits cannot be excluded.
  const ruleRows: EscapeRuleLogEvent[] = [];
  const noExclude: {ruleId: string; path: string; glob: string}[] = [];
  for (const {rule} of rules) {
    if (!ruleFires(rule, [...changed], diff)) continue;
    if (remaining() <= 0) return notRun("SURFACE_BUDGET_EXCEEDED", "Discovery budget exhausted before escape rules ran.", [{rule: rule.id}]);
    let paths: string[];
    try { paths = await ruleHits(input.root, rule, undefined, Math.min(SURFACE_LIMITS.queryTimeoutMs, remaining())); }
    catch (error) {
      if (error instanceof AgentOpsError) return notRun("SURFACE_BUDGET_EXCEEDED", error.message, [{rule: rule.id}]);
      throw error;
    }
    const row: EscapeRuleLogEvent = {type: "escape-rule", ruleId: rule.id, included: 0, excluded: 0};
    for (const path of paths) {
      if (changed.has(path) || included.some(match => match(path)) || unknownPaths.some(match => match(path))) { row.included += 1; continue; }
      const exclusion = exclusions.find(e => e.match(path));
      if (exclusion !== undefined) { row.excluded += 1; if (rule.noExclude) noExclude.push({ruleId: rule.id, path, glob: exclusion.glob}); }
      else unclassified.set(path, [...(unclassified.get(path) ?? []), {source: "escape-rule", query: `rule:${rule.id}`}]);
    }
    ruleRows.push(row);
  }
  if (input.metrics === true) await logRuleMetrics(input.logHome ?? process.env.AGENT_OPS_HOME ?? homedir(), ruleRows);
  if (noExclude.length > 0)
    return notRun("ESCAPE_RULE_NO_EXCLUDE", "A learned escape rule marks these places noExclude: include them or mark them UNKNOWN.", noExclude);
  for (const source of DISCOVERY_SOURCES) sources[source].files = metrics.get(source)!.hits.size;
  const truncated = DISCOVERY_SOURCES.flatMap(source => source === "agent" || derived.dropped[source] === 0 ? []
    : [{source, dropped: derived.dropped[source]}]);
  const discovery: SurfaceDiscovery = {cached, sources, skipped: skipped
    .sort((a, b) => a.files - b.files || (a.query < b.query ? -1 : a.query > b.query ? 1 : 0)).slice(0, 50), postBlockExclusions, dismissed,
    truncated};
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
