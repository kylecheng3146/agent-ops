import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import type { FinishReceipt } from "../parallel/receipt.js";
import { NOTES_REF } from "../parallel/service.js";
import { readPrivateFile } from "../security/permissions.js";
import { globMatcher, isCovers, type SurfaceAudit } from "../surface/schema.js";
import { collectBaseChangePaths, collectChangeSurface, type GitRunner } from "../verify/change-surface.js";
import { RECEIPT_ID, validOrigin, type EscapeLabel, type TaskOrigin } from "./origin.js";

/** Git-tracked, data only: one record per task so parallel worktrees never conflict. */
export const LEDGER_DIRECTORY = ".agent-ops-escapes";

export interface FileFingerprint { readonly path: string; readonly digest: string }
export type EscapeLink =
  | { readonly state: "gated"; readonly receipt: string; readonly matchedBy: "override" | "range" | "head" | "fingerprint" }
  | { readonly state: "unresolved"; readonly reason: "receipt-not-local" | "ambiguous-receipt" | "link-unavailable"; readonly receipt?: string }
  | { readonly state: "ungated" };
/** Where the linked receipt's recorded surface audit put each file the fix touched. */
export type SurfaceFact = "included" | "excluded" | "hit" | "unseen" | "absent" | "no-audit" | "unavailable";
export type PrimaryLabel = EscapeLabel | "surface-excluded" | "surface-unseen";

export interface EscapeAssessment {
  readonly link: EscapeLink;
  readonly agentLabel: EscapeLabel;
  readonly label: PrimaryLabel;
  readonly missedPaths: readonly string[];
  readonly facts: readonly { readonly path: string; readonly surface: SurfaceFact }[];
  readonly residualRisks: readonly string[];
}
export interface EscapeRecord {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly escapeOf: string;
  readonly link: EscapeLink;
  readonly agentLabel: EscapeLabel;
  readonly label: PrimaryLabel;
  readonly missedPaths: readonly string[];
  readonly facts: EscapeAssessment["facts"];
  readonly residualRisks: number;
  readonly declaredAt: string;
}
interface LoadedReceipt { readonly id: string; readonly receipt: FinishReceipt }

const out = (result: { stdout: Uint8Array }) => new TextDecoder().decode(result.stdout);
function gitFailed(what: string): never {
  throw new AgentOpsError("ESCAPE_GIT_FAILED", `git ${what} failed while linking the escape.`);
}

/** Resolve a declared commit-ish to its full SHA (argv only), then validate the whole origin. */
export async function resolveOrigin(git: GitRunner, value: unknown): Promise<TaskOrigin> {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  let origin: unknown = raw;
  if (raw.kind === "escape-of") {
    const ref = raw.commit;
    if (typeof ref !== "string" || !/^[A-Za-z0-9._/^~][A-Za-z0-9._/^~-]{0,255}$/u.test(ref))
      throw new AgentOpsError("ESCAPE_ORIGIN_INVALID", "escape-of needs a commit.");
    const resolved = await git.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
    if (resolved.exitCode !== 0) throw new AgentOpsError("ESCAPE_ORIGIN_INVALID", `Commit ${ref} does not exist in this repository.`);
    origin = {...raw, commit: out(resolved).trim()};
  }
  if (!validOrigin(origin))
    throw new AgentOpsError("ESCAPE_ORIGIN_INVALID", "origin is {kind: escape-of, commit, label, receipt?} with label requirement|surface|scenario|criteria|verify|review|flagged|out-of-model, or {kind: pre-existing|external, reason}.");
  return origin;
}

/** Per-file diff identity that survives squash: blob ids and hunk positions are dropped. */
export async function fileFingerprints(git: GitRunner, from: string, to: string): Promise<FileFingerprint[]> {
  const names = await git.run(["diff", "--name-only", "-z", "--no-renames", from, to, "--"]);
  const diff = await git.run(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0",
    "--src-prefix=a/", "--dst-prefix=b/", from, to, "--"]);
  if (names.exitCode !== 0 || diff.exitCode !== 0) gitFailed("diff");
  const paths = out(names).split("\0").filter(Boolean);
  const chunks = ("\n" + out(diff)).split("\ndiff --git ").slice(1);
  if (chunks.length !== paths.length) gitFailed("diff");
  return paths.map((path, i) => ({path, digest: sha256(chunks[i]!.split("\n").slice(1)
    .filter(line => !line.startsWith("index ")).map(line => line.startsWith("@@") ? "@@" : line).join("\n"))}));
}

/** Receipt schema v2 fields: every commit in target..candidate and per-file fingerprints. */
export async function receiptRange(git: GitRunner, target: string, candidate: string):
  Promise<{ commits: string[]; fileFingerprints: FileFingerprint[] }> {
  const list = await git.run(["rev-list", "--reverse", `${target}..${candidate}`, "--"]);
  if (list.exitCode !== 0) gitFailed("rev-list");
  return {commits: out(list).split("\n").filter(Boolean), fileFingerprints: await fileFingerprints(git, target, candidate)};
}

export async function gitCommonDir(git: GitRunner, root: string): Promise<string> {
  const result = await git.run(["rev-parse", "--git-common-dir"]);
  if (result.exitCode !== 0) gitFailed("rev-parse");
  return resolve(root, out(result).trim());
}

/** Unreadable or foreign files are skipped: linking is advisory. */
export async function loadReceipts(commonDir: string): Promise<LoadedReceipt[]> {
  const directory = join(commonDir, "agent-ops", "receipts");
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const loaded: LoadedReceipt[] = [];
  for (const name of names.filter(n => n.endsWith(".json") && RECEIPT_ID.test(n.slice(0, -5))).sort()) {
    try {
      const source = await readPrivateFile(join(directory, name), commonDir);
      const receipt = source === null ? null : JSON.parse(source) as FinishReceipt;
      if (receipt !== null && (receipt.schemaVersion === 1 || receipt.schemaVersion === 2) && typeof receipt.candidateHead === "string")
        loaded.push({id: name.slice(0, -5), receipt});
    } catch { /* not a receipt this version can read */ }
  }
  return loaded;
}

const newest = (list: readonly LoadedReceipt[]) =>
  [...list].sort((a, b) => String(b.receipt.createdAt).localeCompare(String(a.receipt.createdAt)))[0]!;

/** Override, then range (v1: exact head), then per-file fingerprint, then unresolved or ungated. */
export async function resolveEscape(git: GitRunner, receipts: readonly LoadedReceipt[], commit: string, override?: string): Promise<EscapeLink> {
  if (override !== undefined) return receipts.some(r => r.id === override)
    ? {state: "gated", receipt: override, matchedBy: "override"} : {state: "unresolved", reason: "receipt-not-local", receipt: override};
  const range = receipts.filter(r => r.receipt.schemaVersion === 2 && r.receipt.commits?.includes(commit));
  if (range.length > 0) return {state: "gated", receipt: newest(range).id, matchedBy: "range"};
  const head = receipts.filter(r => r.receipt.schemaVersion === 1 && r.receipt.candidateHead === commit);
  if (head.length > 0) return {state: "gated", receipt: newest(head).id, matchedBy: "head"};
  const parent = await git.run(["rev-parse", "--verify", "--quiet", `${commit}^`]);
  if (parent.exitCode === 0) {
    const own = await fileFingerprints(git, out(parent).trim(), commit);
    const scored = receipts.map(r => ({r, score: own.filter(f => r.receipt.fileFingerprints?.some(g => g.path === f.path && g.digest === f.digest)).length}));
    const best = Math.max(0, ...scored.map(s => s.score));
    const winners = scored.filter(s => s.score === best && best > 0);
    if (winners.length === 1) return {state: "gated", receipt: winners[0]!.r.id, matchedBy: "fingerprint"};
    if (winners.length > 1) return {state: "unresolved", reason: "ambiguous-receipt"};
  }
  // finish notes the merged commit with its receipt path; a note without the receipt means another machine.
  const note = await git.run(["notes", `--ref=${NOTES_REF}`, "show", commit]);
  return note.exitCode === 0 ? {state: "unresolved", reason: "receipt-not-local"} : {state: "ungated"};
}

/** git grep -F replay of the receipt's recorded queries at its candidate. */
export async function surfaceFacts(git: GitRunner, receipt: FinishReceipt, paths: readonly string[]): Promise<EscapeAssessment["facts"]> {
  const audits = receipt.tasks.map(t => t.task.surface).filter((s): s is SurfaceAudit => s !== undefined && !isCovers(s));
  if (audits.length === 0) return paths.map(path => ({path, surface: "no-audit" as const}));
  const head = receipt.candidateHead;
  const hits = new Set<string>();
  const queries = new Set(audits.flatMap(a => Object.values(a.axes).flatMap(axis => "queries" in axis ? axis.queries : [])));
  for (const query of queries) {
    const result = await git.run(["grep", "-F", "-l", "-z", "-I", "--no-color", "-e", query, head, "--"]);
    if (result.exitCode > 1) return paths.map(path => ({path, surface: "unavailable" as const}));
    for (const hit of out(result).split("\0").filter(Boolean)) hits.add(hit.slice(head.length + 1));
  }
  const included = audits.flatMap(a => a.included.map(row => globMatcher(row.path)));
  const excluded = audits.flatMap(a => a.excluded.map(row => globMatcher(row.glob)));
  const facts: { path: string; surface: SurfaceFact }[] = [];
  for (const path of paths) {
    const surface: SurfaceFact = included.some(m => m(path)) ? "included" : excluded.some(m => m(path)) ? "excluded" :
      (await git.run(["cat-file", "-e", `${head}:${path}`])).exitCode !== 0 ? "absent" : hits.has(path) ? "hit" : "unseen";
    facts.push({path, surface});
  }
  return facts;
}

/** Mechanical replay outranks the agent unless it named the only earlier gate. */
export function primaryLabel(agentLabel: EscapeLabel, facts: EscapeAssessment["facts"]): PrimaryLabel {
  if (agentLabel === "requirement") return agentLabel;
  if (facts.some(f => f.surface === "excluded")) return "surface-excluded";
  if (facts.some(f => f.surface === "unseen")) return "surface-unseen";
  return agentLabel;
}

/** Product files the fix touched since its base (tests and agent-ops data are not missed surfaces). */
export async function missedPaths(git: GitRunner, base: string): Promise<string[]> {
  const paths = new Set([...await collectBaseChangePaths(git, base), ...(await collectChangeSurface(git)).paths]);
  return [...paths].filter(path => !path.startsWith(".agent-ops") &&
    !/(?:^|\/)(?:tests?|fixtures)(?:\/|$)|(?:\.test|\.spec)\./u.test(path)).sort().slice(0, 200);
}

/** A hint only: which commits last wrote the lines the fix changed or removed. Omissions have none. */
export async function blameHints(git: GitRunner, base: string): Promise<{ commit: string; lines: number }[]> {
  const diff = await git.run(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U0",
    "--src-prefix=a/", "--dst-prefix=b/", base, "--"]);
  if (diff.exitCode !== 0) return [];
  const counts = new Map<string, number>();
  let path: string | null = null, hunks = 0;
  for (const line of out(diff).split("\n")) {
    if (line.startsWith("--- ")) { path = line.startsWith("--- a/") ? line.slice(6) : null; continue; }
    const hunk = /^@@ -(\d+)(?:,(\d+))? /u.exec(line);
    if (hunk === null || path === null || hunks >= 200) continue;
    const start = Number(hunk[1]), length = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (length === 0) continue;
    hunks += 1;
    const blame = await git.run(["blame", "--porcelain", "-L", `${start},+${length}`, base, "--", path]);
    if (blame.exitCode !== 0) continue;
    for (const header of out(blame).matchAll(/^([0-9a-f]{40,64}) \d+ \d+/gmu)) counts.set(header[1]!, (counts.get(header[1]!) ?? 0) + 1);
  }
  return [...counts].map(([commit, lines]) => ({commit, lines})).sort((a, b) => b.lines - a.lines || a.commit.localeCompare(b.commit)).slice(0, 10);
}

/** Linking is advisory: a Git failure leaves the escape unresolved, never blocks the declaration. */
export async function assessEscape(input: { root: string; git: GitRunner; origin: Extract<TaskOrigin, { kind: "escape-of" }>; base: string }):
  Promise<EscapeAssessment> {
  let receipts: LoadedReceipt[] = [], link: EscapeLink;
  try {
    receipts = await loadReceipts(await gitCommonDir(input.git, input.root));
    link = await resolveEscape(input.git, receipts, input.origin.commit, input.origin.receipt);
  } catch { link = {state: "unresolved", reason: "link-unavailable"}; }
  const paths = await missedPaths(input.git, input.base);
  const linked = link.state === "gated" ? receipts.find(r => r.id === link.receipt)?.receipt : undefined;
  let facts: EscapeAssessment["facts"] = [];
  if (linked !== undefined) {
    try { facts = await surfaceFacts(input.git, linked, paths); }
    catch { facts = paths.map(path => ({path, surface: "unavailable" as const})); }
  }
  return {link, agentLabel: input.origin.label, label: primaryLabel(input.origin.label, facts), missedPaths: paths, facts,
    residualRisks: linked?.residualRisks ?? []};
}

export function ledgerPath(root: string, taskId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(taskId)) throw new AgentOpsError("ESCAPE_TASK_INVALID", "Invalid task ID for the escape ledger.");
  return join(root, LEDGER_DIRECTORY, `${taskId}.json`);
}

/** The ledger is repository content: never follow a checked-in symlink out of the worktree. */
async function unsafe(target: string, kind: "directory" | "file"): Promise<boolean> {
  try {
    const stat = await lstat(target);
    return stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function safeLedgerPath(root: string, taskId: string): Promise<string> {
  const path = ledgerPath(root, taskId);
  if (await unsafe(join(root, LEDGER_DIRECTORY), "directory") || await unsafe(path, "file"))
    throw new AgentOpsError("ESCAPE_LEDGER_UNSAFE", `${LEDGER_DIRECTORY} must be a real directory of regular files.`);
  return path;
}

/** One record per task; re-declaring replaces it. Commit it with the fix. */
export async function declareEscape(input: { root: string; git: GitRunner; taskId: string; origin: Extract<TaskOrigin, { kind: "escape-of" }>;
  base: string; now: string }): Promise<{ record: EscapeRecord; path: string; blame: { commit: string; lines: number }[] }> {
  const assessment = await assessEscape(input);
  const record: EscapeRecord = {schemaVersion: 1, taskId: input.taskId, escapeOf: input.origin.commit, link: assessment.link,
    agentLabel: assessment.agentLabel, label: assessment.label, missedPaths: assessment.missedPaths, facts: assessment.facts,
    residualRisks: assessment.residualRisks.length, declaredAt: input.now};
  await safeLedgerPath(input.root, input.taskId);
  await mkdir(join(input.root, LEDGER_DIRECTORY), {recursive: true});
  const path = await safeLedgerPath(input.root, input.taskId);
  // O_NOFOLLOW closes the lstat-to-open race on POSIX; Windows has no such flag.
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644);
  try { await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8"); } finally { await handle.close(); }
  return {record, path, blame: await blameHints(input.git, input.base)};
}

export async function removeEscapeRecord(root: string, taskId: string): Promise<void> {
  await rm(await safeLedgerPath(root, taskId), {force: true});
}

export async function readEscapeRecord(root: string, taskId: string): Promise<EscapeRecord | null> {
  try { return JSON.parse(await readFile(await safeLedgerPath(root, taskId), "utf8")) as EscapeRecord; }
  catch { return null; }
}

/** Review packet data: the declaration, a fresh assessment, and whether the tracked record still matches it. */
export async function escapeReviewData(input: { root: string; git: GitRunner; taskId: string; origin: TaskOrigin; base: string }) {
  if (input.origin.kind !== "escape-of") return {taskId: input.taskId, origin: input.origin};
  const assessment = await assessEscape({...input, origin: input.origin});
  const recorded = await readEscapeRecord(input.root, input.taskId);
  const current = recorded !== null && JSON.stringify([recorded.escapeOf, recorded.link, recorded.label, recorded.missedPaths, recorded.facts]) ===
    JSON.stringify([input.origin.commit, assessment.link, assessment.label, assessment.missedPaths, assessment.facts]);
  return {taskId: input.taskId, origin: input.origin, ...assessment, recordCurrent: current};
}
