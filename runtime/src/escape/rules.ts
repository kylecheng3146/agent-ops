import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { readPrivateFile, writePrivateFile } from "../security/permissions.js";
import { globMatcher } from "../surface/schema.js";
import type { GitRunner } from "../verify/change-surface.js";
import type { AgentOpsConfig } from "../contracts.js";
import { ESCAPE_LABELS } from "./origin.js";

/** Escape Loop R2: learned, tracked, data-only rules. They can only add places a task must classify. */
export const RULES_DIRECTORY = ".agent-ops-escapes/rules";
export const RULE_LABELS = [...ESCAPE_LABELS, "surface-excluded", "surface-unseen"] as const;
/** Labels whose proof is a rule replayed at the escaped commit. */
export const SURFACE_LABELS: readonly string[] = ["surface", "surface-excluded", "surface-unseen"];
/** Labels whose proof is a promoted red-to-green behavioral check of the fixing task. */
export const CHECK_LABELS: readonly string[] = ["criteria", "verify"];
export const RULE_LIMITS = {backtestCommits: 200, maxFireRate: 0.3, backtestBudgetMs: 60_000, queryTimeoutMs: 30_000} as const;

export interface EscapeRule {
  readonly id: string;
  readonly escape: string;
  readonly label: typeof RULE_LABELS[number];
  readonly trigger: { readonly paths: readonly string[]; readonly tokens: readonly string[] };
  readonly expand: { readonly paths: readonly string[]; readonly queries: readonly string[] };
  readonly noExclude: boolean;
}
export interface LoadedRule { readonly rule: EscapeRule; readonly hash: string }
export interface Backtest { readonly commits: number; readonly fires: number; readonly rate: number }
export type EscapeProof =
  | { readonly status: "proven"; readonly rule: string; readonly ruleHash: string; readonly backtest: Backtest }
  | { readonly status: "check"; readonly check: string | null }
  | { readonly status: "lesson"; readonly reason: string }
  | { readonly status: "unproven"; readonly code: "ESCAPE_RULE_UNPROVEN" | "ESCAPE_RULE_TOO_BROAD" | "SURFACE_BUDGET_EXCEEDED";
      readonly reason: string; readonly rule?: string; readonly backtest?: Backtest };

export interface GitArgvResult { readonly code: number | null; readonly stdout: Buffer; readonly timedOut: boolean }
/** argv only: rule strings are repository data and must never meet a shell or a regex engine. */
export function runGit(root: string, args: readonly string[], timeoutMs: number): Promise<GitArgvResult> {
  return new Promise(resolve => {
    execFile("git", [...args], {cwd: root, encoding: "buffer", timeout: Math.max(1, timeoutMs), maxBuffer: 256 * 1024 * 1024, shell: false},
      (error, stdout) => {
        const failure = error as (NodeJS.ErrnoException & {killed?: boolean; code?: unknown}) | null;
        resolve({code: failure === null ? 0 : typeof failure.code === "number" ? failure.code : null,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0), timedOut: failure?.killed === true});
      });
  });
}
export const gitRunner = (root: string): GitRunner => ({run: async args => {
  const result = await runGit(root, args, RULE_LIMITS.queryTimeoutMs);
  return {exitCode: result.code ?? 128, stdout: result.stdout};
}});

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k));
const line = (v: unknown, min: number): v is string => typeof v === "string" && v.trim().length >= min && v.length <= 256 && !/[\0\n\r]/u.test(v);
const glob = (v: unknown): v is string => line(v, 1) && !v.startsWith("/") && !v.includes("\\") &&
  v.split("/").every(part => part !== "" && part !== "." && part !== "..");
const strings = (v: unknown, check: (s: unknown) => boolean): v is string[] =>
  Array.isArray(v) && v.length <= 32 && v.every(check) && new Set(v).size === v.length;

function invalid(file: string, message: string): never {
  throw new AgentOpsError("ESCAPE_RULE_INVALID", `${RULES_DIRECTORY}/${file}: ${message}`);
}

/** Strict: there is no field that removes a query, adds an exclusion or relaxes a gate. */
export function parseRule(value: unknown, file: string): EscapeRule {
  if (!record(value) || !exact(value, ["id", "escape", "label", "trigger", "expand", "noExclude"]))
    invalid(file, "a rule is exactly {id, escape, label, trigger: {paths, tokens}, expand: {paths, queries}, noExclude}.");
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.id) || file !== `${value.id}.json`)
    invalid(file, "id is lowercase kebab-case and names the file <id>.json.");
  if (typeof value.escape !== "string" || !/^[a-f0-9]{40,64}$/u.test(value.escape)) invalid(file, "escape is the full escaped commit SHA.");
  if (!RULE_LABELS.includes(value.label as never)) invalid(file, `label is one of ${RULE_LABELS.join(", ")}.`);
  const {trigger, expand} = value;
  if (!record(trigger) || !exact(trigger, ["paths", "tokens"]) || !strings(trigger.paths, glob) || !strings(trigger.tokens, v => line(v, 3)) ||
    trigger.paths.length + trigger.tokens.length === 0)
    invalid(file, "trigger needs 1-32 path globs and/or fixed-string tokens (3+ characters).");
  if (!record(expand) || !exact(expand, ["paths", "queries"]) || !strings(expand.paths, glob) || !strings(expand.queries, v => line(v, 3)) ||
    expand.paths.length + expand.queries.length === 0)
    invalid(file, "expand needs 1-32 path globs and/or fixed-string queries (3+ characters).");
  if (typeof value.noExclude !== "boolean") invalid(file, "noExclude is true or false.");
  return {id: value.id, escape: value.escape, label: value.label as EscapeRule["label"],
    trigger: {paths: [...trigger.paths], tokens: [...trigger.tokens]}, expand: {paths: [...expand.paths], queries: [...expand.queries]},
    noExclude: value.noExclude};
}

async function kind(path: string): Promise<"missing" | "directory" | "file" | "other"> {
  try {
    const stat = await lstat(path);
    return stat.isSymbolicLink() ? "other" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}
const unsafe = (): never => {
  throw new AgentOpsError("ESCAPE_RULE_UNSAFE", `${RULES_DIRECTORY} must be a real directory of regular <id>.json files.`);
};

/** Fails closed: a broken or symlinked rule never silently stops tightening. */
export async function loadRules(root: string): Promise<LoadedRule[]> {
  for (const directory of [".agent-ops-escapes", RULES_DIRECTORY]) {
    const found = await kind(join(root, directory));
    if (found === "missing") return [];
    if (found !== "directory") unsafe();
  }
  const rules: LoadedRule[] = [];
  for (const name of (await readdir(join(root, RULES_DIRECTORY))).sort()) {
    const path = join(root, RULES_DIRECTORY, name);
    if (await kind(path) !== "file") unsafe();
    if (!name.endsWith(".json")) invalid(name, "only <id>.json rule files belong here.");
    // O_NOFOLLOW closes the lstat-to-open race on POSIX; Windows has no such flag.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let source: string;
    try { source = await handle.readFile("utf8"); } finally { await handle.close(); }
    let value: unknown;
    try { value = JSON.parse(source); } catch { invalid(name, "not JSON."); }
    rules.push({rule: parseRule(value, name), hash: sha256(source)});
  }
  return rules;
}

/** Added and removed lines only: headers and context never trigger. */
function changedLines(diff: string): string[] {
  return diff.split("\n").filter(l => /^[+-]/u.test(l) && !l.startsWith("+++") && !l.startsWith("---")).map(l => l.slice(1));
}

/** A rule fires when a changed path matches a trigger glob or a changed line contains a trigger token. */
export function ruleFires(rule: EscapeRule, paths: readonly string[], diff: string): boolean {
  const globs = rule.trigger.paths.map(globMatcher);
  if (paths.some(path => globs.some(match => match(path)))) return true;
  if (rule.trigger.tokens.length === 0) return false;
  const lines = changedLines(diff);
  return rule.trigger.tokens.some(token => lines.some(l => l.includes(token)));
}

const zList = (value: Buffer) => value.toString("utf8").split("\0").filter(Boolean);

/** Files a fired rule puts in front of the task: path globs over tracked files plus git grep -F queries; ref absent = working tree. */
export async function ruleHits(root: string, rule: EscapeRule, ref?: string, timeoutMs: number = RULE_LIMITS.queryTimeoutMs): Promise<string[]> {
  const hits = new Set<string>();
  const fail = (): never => { throw new AgentOpsError("SURFACE_BUDGET_EXCEEDED", `Rule ${rule.id} could not list its expand hits in time.`); };
  if (rule.expand.paths.length > 0) {
    const files = await runGit(root, ref === undefined ? ["ls-files", "-z"] : ["ls-tree", "-r", "-z", "--name-only", ref], timeoutMs);
    if (files.code !== 0) fail();
    const globs = rule.expand.paths.map(globMatcher);
    for (const path of zList(files.stdout)) if (globs.some(match => match(path))) hits.add(path);
  }
  for (const query of rule.expand.queries) {
    const result = await runGit(root, ["grep", "-F", "-l", "-z", "-I", "--no-color", "-e", query, ...(ref === undefined ? [] : [ref]), "--"], timeoutMs);
    if (result.timedOut || (result.code !== 0 && result.code !== 1)) fail();
    for (const hit of zList(result.stdout)) hits.add(ref === undefined ? hit : hit.slice(ref.length + 1));
  }
  // A rule's own text names its queries; the ledger is never a product surface.
  return [...hits].filter(path => !path.startsWith(".agent-ops-escapes/")).sort();
}

/** One commit's own change against its first parent (the empty tree for a root commit). */
export async function commitChange(root: string, commit: string): Promise<{ paths: string[]; diff: string }> {
  const names = await runGit(root, ["show", "-m", "--first-parent", "--format=", "--name-only", "-z", "--no-renames", commit, "--"], RULE_LIMITS.queryTimeoutMs);
  const diff = await runGit(root, ["show", "-m", "--first-parent", "--format=", "-U0", "--no-color", "--no-ext-diff", "--no-textconv",
    "--no-renames", commit, "--"], RULE_LIMITS.queryTimeoutMs);
  if (names.code !== 0 || diff.code !== 0) throw new AgentOpsError("ESCAPE_GIT_FAILED", `git show ${commit} failed.`);
  return {paths: zList(names.stdout), diff: diff.stdout.toString("utf8")};
}

/** Product files a past fix commit touched (tests and agent-ops data are not missed surfaces). */
export async function fixPaths(root: string, fix: string): Promise<string[]> {
  return (await commitChange(root, fix)).paths.filter(path => !path.startsWith(".agent-ops") &&
    !/(?:^|\/)(?:tests?|fixtures)(?:\/|$)|(?:\.test|\.spec)\./u.test(path)).sort().slice(0, 200);
}

/**
 * The trigger against the last 200 first-parent commits, in one argv git call.
 * ponytail: one `git log -p` buffered in memory (256 MiB cap); stream it if huge histories need it.
 */
export async function backtestRule(root: string, loaded: LoadedRule, budgetMs: number = RULE_LIMITS.backtestBudgetMs): Promise<Backtest> {
  const head = (await runGit(root, ["rev-parse", "HEAD"], RULE_LIMITS.queryTimeoutMs)).stdout.toString("utf8").trim();
  const cachePath = join(root, ".agent-ops", "tasks", "escape", "backtest",
    sha256(canonicalJson({head, rule: loaded.hash, limit: RULE_LIMITS.backtestCommits})) + ".json");
  try {
    const cached = await readPrivateFile(cachePath, root);
    if (cached !== null) return JSON.parse(cached) as Backtest;
  } catch { /* recompute */ }
  const log = await runGit(root, ["log", "--first-parent", "-m", "-n", String(RULE_LIMITS.backtestCommits), "-p", "-U0", "--no-color",
    "--no-ext-diff", "--no-textconv", "--no-renames", "--format=%x00commit %H", "HEAD", "--"], budgetMs);
  if (log.timedOut) throw new AgentOpsError("SURFACE_BUDGET_EXCEEDED", `Backtest of rule ${loaded.rule.id} exceeded its ${budgetMs} ms budget.`);
  if (log.code !== 0) throw new AgentOpsError("ESCAPE_GIT_FAILED", "git log failed during the rule backtest.");
  const commits = log.stdout.toString("utf8").split("\0commit ").slice(1);
  let fires = 0;
  for (const chunk of commits) {
    const paths = [...chunk.matchAll(/^diff --git a\/.+? b\/(.+)$/gmu)].map(m => m[1]!);
    if (ruleFires(loaded.rule, paths, chunk)) fires += 1;
  }
  const result: Backtest = {commits: commits.length, fires, rate: commits.length === 0 ? 0 : Math.round(fires / commits.length * 1000) / 1000};
  await writePrivateFile(cachePath, JSON.stringify(result), root).catch(() => undefined);
  return result;
}

/**
 * Proof per label. Surface labels need a rule for this escape that fires on the
 * escaped commit's own diff and whose hits at that commit cover every missed
 * path that existed there; no test or review ever runs at the escaped commit.
 */
export async function proveEscape(input: { root: string; escapeOf: string; label: string; missedPaths: readonly string[];
  promote?: string; budgetMs?: number }): Promise<EscapeProof> {
  if (CHECK_LABELS.includes(input.label)) return {status: "check", check: input.promote ?? null};
  if (!SURFACE_LABELS.includes(input.label))
    return {status: "lesson", reason: `${input.label}: no mechanical replay exists for this gate; recorded as an unproven lesson.`};
  const rules = (await loadRules(input.root)).filter(r => r.rule.escape === input.escapeOf);
  if (rules.length === 0) return {status: "unproven", code: "ESCAPE_RULE_UNPROVEN",
    reason: `No ${RULES_DIRECTORY}/<id>.json rule names escape ${input.escapeOf}.`};
  const change = await commitChange(input.root, input.escapeOf);
  const required: string[] = [];
  for (const path of input.missedPaths)
    if ((await runGit(input.root, ["cat-file", "-e", `${input.escapeOf}:${path}`], RULE_LIMITS.queryTimeoutMs)).code === 0) required.push(path);
  const reasons: string[] = [];
  for (const loaded of rules) {
    if (!ruleFires(loaded.rule, change.paths, change.diff)) { reasons.push(`${loaded.rule.id} does not fire on the escaped commit`); continue; }
    const hits = new Set(await ruleHits(input.root, loaded.rule, input.escapeOf));
    const missing = required.filter(path => !hits.has(path));
    if (missing.length > 0) { reasons.push(`${loaded.rule.id} misses ${missing.slice(0, 5).join(", ")}`); continue; }
    let backtest: Backtest;
    try { backtest = await backtestRule(input.root, loaded, input.budgetMs); }
    catch (error) {
      if (error instanceof AgentOpsError && error.code === "SURFACE_BUDGET_EXCEEDED")
        return {status: "unproven", code: "SURFACE_BUDGET_EXCEEDED", reason: error.message, rule: loaded.rule.id};
      throw error;
    }
    if (backtest.rate > RULE_LIMITS.maxFireRate) return {status: "unproven", code: "ESCAPE_RULE_TOO_BROAD", rule: loaded.rule.id, backtest,
      reason: `${loaded.rule.id} fires on ${backtest.fires} of the last ${backtest.commits} first-parent commits (> ${RULE_LIMITS.maxFireRate * 100}%).`};
    return {status: "proven", rule: loaded.rule.id, ruleHash: loaded.hash, backtest};
  }
  return {status: "unproven", code: "ESCAPE_RULE_UNPROVEN", reason: reasons.join("; ")};
}

/** Printed only: agent-ops never writes .agent-ops/config.json for an executable rule. */
export function configProposal(promote: string, config: AgentOpsConfig | undefined): unknown {
  const [runnerId, checkId] = promote.split(":") as [string, string];
  const runner = config?.verification.acceptanceRunners?.find(r => r.id === runnerId);
  return {note: "Proposal only: review it, then apply it yourself and confirm trust with agent-ops update; agent-ops never writes this config.",
    promote: {runnerId, checkId},
    verification: {commands: [{id: `escape-${checkId}`.slice(0, 64), command: runner?.command ?? "<runner command>", args: [...runner?.args ?? []],
      cwd: runner?.cwd ?? ".", required: true, evidence: {kind: "exit-code"}}]}};
}
