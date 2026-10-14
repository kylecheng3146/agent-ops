import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { LEDGER_DIRECTORY, type EscapeRecord } from "../../../../runtime/src/escape/link.js";
import { loadRules } from "../../../../runtime/src/escape/rules.js";
import { readLocalLog } from "../../../../runtime/src/logging/local-log.js";
import { okEnvelope, type CliEnvelope } from "../output.js";

/** Below this many observations a count is shown but not trusted. */
export const MIN_SAMPLE = 10;

type Window = { readonly first: string | null; readonly last: string | null };
interface Section { readonly n: number; readonly status: "ok" | "insufficient-data"; readonly window: Window; readonly counts: Record<string, number> }
export interface EscapesReport {
  readonly misses: Section;
  readonly catches: Section;
  readonly origins: Section;
  readonly links: Section & { readonly reasons: Record<string, number> };
  readonly rules: readonly { readonly id: string; readonly label: string; readonly noExclude: boolean; readonly fires: number;
    readonly included: number; readonly excluded: number; readonly status: "ok" | "insufficient-data" }[];
  readonly retirementCandidates: readonly { readonly id: string; readonly reason: string }[];
  readonly warnings: readonly string[];
}
export interface EscapesCommandData extends EscapesReport { readonly text: string }

const status = (n: number) => n < MIN_SAMPLE ? "insufficient-data" as const : "ok" as const;
function section(rows: readonly { at?: string; key: string }[]): Section {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.key] = (counts[row.key] ?? 0) + 1;
  const times = rows.flatMap(row => row.at === undefined ? [] : [row.at]).sort();
  return {n: rows.length, status: status(rows.length), window: {first: times[0] ?? null, last: times.at(-1) ?? null}, counts};
}

/** Tracked ledger records; a symlinked or unreadable entry is skipped with a warning, never followed. */
async function ledger(root: string, warnings: string[]): Promise<EscapeRecord[]> {
  const directory = join(root, LEDGER_DIRECTORY);
  try {
    if (!(await lstat(directory)).isDirectory()) { warnings.push(`${LEDGER_DIRECTORY} is not a directory.`); return []; }
  } catch { return []; }
  const records: EscapeRecord[] = [];
  for (const name of (await readdir(directory)).filter(n => n.endsWith(".json")).sort()) {
    try {
      if (!(await lstat(join(directory, name))).isFile()) throw new Error("not a regular file");
      const value = JSON.parse(await readFile(join(directory, name), "utf8")) as EscapeRecord;
      if (typeof value.label === "string" && typeof value.link?.state === "string") records.push(value);
    } catch { warnings.push(`Skipped unreadable ledger record ${name}.`); }
  }
  return records;
}

/** Advisory, read-only and fail-open: every source that cannot be read becomes a warning. */
export async function buildEscapesReport(root: string, home?: string): Promise<EscapesReport> {
  const warnings: string[] = [];
  const records = await ledger(root, warnings).catch(() => { warnings.push("Ledger unreadable."); return []; });
  const events = await readLocalLog(home);
  let origins: { at?: string; key: string }[] = [];
  try {
    const state = JSON.parse(await readFile(join(root, ".agent-ops", "tasks", "state.json"), "utf8")) as
      { tasks?: { createdAt?: string; task?: { origin?: { kind?: string }; debug?: unknown } }[] };
    origins = (state.tasks ?? []).filter(r => r.task?.origin !== undefined || r.task?.debug !== undefined)
      .map(r => ({...(r.createdAt === undefined ? {} : {at: r.createdAt}), key: r.task?.origin?.kind ?? "undeclared"}));
  } catch { warnings.push("Task state unreadable; origin mix is empty."); }
  let rules: Awaited<ReturnType<typeof loadRules>> = [];
  try { rules = await loadRules(root); }
  catch (error) { warnings.push(`Rules unreadable: ${error instanceof Error ? error.message : "unknown error"}`); }
  const ruleEvents = events.flatMap(e => e.event.type === "escape-rule" ? [e.event] : []);
  const ruleRows = rules.map(({rule}) => {
    const fired = ruleEvents.filter(e => e.ruleId === rule.id);
    return {id: rule.id, label: rule.label, noExclude: rule.noExclude, fires: fired.length,
      included: fired.reduce((n, e) => n + e.included, 0), excluded: fired.reduce((n, e) => n + e.excluded, 0), status: status(fired.length)};
  });
  const links = section(records.map(r => ({at: r.declaredAt, key: r.link.state})));
  const reasons: Record<string, number> = {};
  for (const r of records) if (r.link.state === "unresolved") reasons[r.link.reason] = (reasons[r.link.reason] ?? 0) + 1;
  return {
    misses: section(records.map(r => ({at: r.declaredAt, key: r.label}))),
    catches: section(events.flatMap(e => e.event.type === "gate-catch" ? [{at: e.timestamp, key: e.event.code}] : [])),
    origins: section(origins),
    links: {...links, reasons},
    rules: ruleRows,
    // Retirement is never automatic: only rules with enough fires that never surfaced an included place are listed.
    retirementCandidates: ruleRows.filter(r => r.fires >= MIN_SAMPLE && r.included === 0)
      .map(r => ({id: r.id, reason: `fired ${r.fires} times; every hit was excluded (${r.excluded}) or none was included.`})),
    warnings
  };
}

function render(report: EscapesReport): string {
  const line = (name: string, s: Section) => `${name}: n=${s.n}${s.status === "ok" ? "" : " (insufficient-data)"}` +
    `${s.window.first === null ? "" : ` ${s.window.first} .. ${s.window.last}`}` +
    `${Object.keys(s.counts).length === 0 ? "" : ` - ${Object.entries(s.counts).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`}`;
  return [
    "Escape Loop report (advisory; raw counts; catches and rule fires come from this machine's local log)",
    line("Misses by gate (ledger)", report.misses),
    line("Catches by code (local log)", report.catches),
    line("Origin mix (tasks)", report.origins),
    line("Link states (ledger)", report.links) +
      (Object.keys(report.links.reasons).length === 0 ? "" : `; unresolved reasons: ${Object.entries(report.links.reasons).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`),
    `Rules: ${report.rules.length}`,
    ...report.rules.map(r => `- ${r.id} (${r.label}${r.noExclude ? ", noExclude" : ""}): fires ${r.fires}, included ${r.included}, excluded ${r.excluded}` +
      `${r.status === "ok" ? "" : " (insufficient-data)"}`),
    `Retirement candidates: ${report.retirementCandidates.length === 0 ? "none" : report.retirementCandidates.map(c => `${c.id} (${c.reason})`).join("; ")}`,
    ...report.warnings.map(w => `Warning: ${w}`)
  ].join("\n") + "\n";
}

export async function runEscapesCommand(options: { readonly root: string; readonly home?: string }): Promise<CliEnvelope<EscapesCommandData>> {
  const report = await buildEscapesReport(options.root, options.home);
  return okEnvelope("ESCAPES_REPORT", {...report, text: render(report)});
}
