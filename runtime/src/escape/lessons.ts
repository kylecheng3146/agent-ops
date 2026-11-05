import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import type { AgentTask } from "../contracts.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { readEscapeRecord } from "./link.js";
import { globMatcher, isCovers, type TaskSurface } from "../surface/schema.js";
import { readJsonDirectory, ruleFires, RULE_LIMITS, type Backtest } from "./rules.js";

/**
 * Escape lessons: a reflector's transferable cue for an escape no mechanical replay
 * covers. Only the trigger is proven; a fired lesson must be classified in the surface.
 */
export const LESSONS_DIRECTORY = ".agent-ops-escapes/lessons";
export const LESSON_LABELS = ["scenario", "requirement", "review"] as const;
export const LESSON_STATUSES = ["lesson", "no-entry", "not-run"] as const;

export interface EscapeLesson {
  readonly id: string;
  readonly escape: string;
  readonly taskId: string;
  readonly label: typeof LESSON_LABELS[number];
  readonly status: typeof LESSON_STATUSES[number];
  /** Status lesson: the cue, the check to make and the evidence; otherwise cue/check/trigger/backtest are null and evidence says why. */
  readonly cue: string | null;
  readonly check: string | null;
  readonly evidence: string;
  readonly trigger: { readonly paths: readonly string[]; readonly tokens: readonly string[] } | null;
  readonly backtest: Backtest | null;
  readonly reflector: { readonly target: string | null; readonly attempts: number };
}
export interface LoadedLesson { readonly lesson: EscapeLesson; readonly hash: string }

const KEYS = ["id", "escape", "taskId", "label", "status", "cue", "check", "evidence", "trigger", "backtest", "reflector"];
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k));
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 2048 && !v.includes("\0");
const line = (v: unknown, min: number): v is string => typeof v === "string" && v.trim().length >= min && v.length <= 256 && !/[\0\n\r]/u.test(v);
const glob = (v: unknown): v is string => line(v, 1) && !v.startsWith("/") && !v.includes("\\") &&
  v.split("/").every(part => part !== "" && part !== "." && part !== "..");
const strings = (v: unknown, check: (s: unknown) => boolean): v is string[] =>
  Array.isArray(v) && v.length <= 32 && v.every(check) && new Set(v).size === v.length;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

function invalid(file: string, message: string): never {
  throw new AgentOpsError("ESCAPE_LESSON_INVALID", `${LESSONS_DIRECTORY}/${file}: ${message}`);
}
const unsafe = (): never => {
  throw new AgentOpsError("ESCAPE_LESSON_UNSAFE", `${LESSONS_DIRECTORY} must be a real directory of regular <id>.json files.`);
};

/** Strict: exact keys, <id>.json naming; a stored lesson trigger is never broader than the backtest cap. */
export function parseLesson(value: unknown, file: string): EscapeLesson {
  if (!record(value) || !exact(value, KEYS)) invalid(file, `a lesson is exactly {${KEYS.join(", ")}}.`);
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.id) || file !== `${value.id}.json`)
    invalid(file, "id is lowercase kebab-case and names the file <id>.json.");
  if (typeof value.escape !== "string" || !/^[a-f0-9]{40,64}$/u.test(value.escape)) invalid(file, "escape is the full escaped commit SHA.");
  if (typeof value.taskId !== "string" || !/^task-[a-z0-9-]{1,64}$/u.test(value.taskId)) invalid(file, "taskId is the fixing task ID.");
  if (!LESSON_LABELS.includes(value.label as never)) invalid(file, `label is one of ${LESSON_LABELS.join(", ")}.`);
  if (!LESSON_STATUSES.includes(value.status as never)) invalid(file, `status is one of ${LESSON_STATUSES.join(", ")}.`);
  if (!text(value.evidence)) invalid(file, "evidence is non-empty text.");
  const {reflector} = value;
  if (!record(reflector) || !exact(reflector, ["target", "attempts"]) || (reflector.target !== null && !line(reflector.target, 1)) ||
    !count(reflector.attempts) || reflector.attempts > 2)
    invalid(file, "reflector is {target: string | null, attempts: 0-2}.");
  const base = {id: value.id, escape: value.escape, taskId: value.taskId, label: value.label as EscapeLesson["label"],
    status: value.status as EscapeLesson["status"], evidence: value.evidence,
    reflector: {target: reflector.target as string | null, attempts: reflector.attempts}};
  if (value.status !== "lesson") {
    if (value.cue !== null || value.check !== null || value.trigger !== null || value.backtest !== null)
      invalid(file, "a no-entry or not-run record has null cue, check, trigger and backtest.");
    return {...base, cue: null, check: null, trigger: null, backtest: null};
  }
  if (!text(value.cue) || !text(value.check)) invalid(file, "a lesson needs a cue and a check.");
  const {trigger, backtest} = value;
  if (!record(trigger) || !exact(trigger, ["paths", "tokens"]) || !strings(trigger.paths, glob) || trigger.paths.length === 0 ||
    !strings(trigger.tokens, v => line(v, 3)))
    invalid(file, "trigger needs 1-32 path globs and 0-32 fixed-string tokens (3+ characters).");
  if (!record(backtest) || !exact(backtest, ["commits", "fires", "rate"]) || !count(backtest.commits) || !count(backtest.fires) ||
    backtest.fires > backtest.commits || typeof backtest.rate !== "number" || !(backtest.rate >= 0 && backtest.rate <= RULE_LIMITS.maxFireRate))
    invalid(file, `backtest is {commits, fires, rate} with rate at most ${RULE_LIMITS.maxFireRate}.`);
  return {...base, cue: value.cue, check: value.check, trigger: {paths: [...trigger.paths], tokens: [...trigger.tokens]},
    backtest: {commits: backtest.commits, fires: backtest.fires, rate: backtest.rate}};
}

/** Every record (lesson, no-entry, not-run): finish and the report read these. Fails closed like loadRules. */
export async function readLessons(root: string): Promise<LoadedLesson[]> {
  return (await readJsonDirectory(root, LESSONS_DIRECTORY, unsafe, invalid))
    .map(({name, source, value}) => ({lesson: parseLesson(value, name), hash: sha256(source)}));
}

/** Only status lesson entries ever match a change. */
export async function loadLessons(root: string): Promise<LoadedLesson[]> {
  return (await readLessons(root)).filter(loaded => loaded.lesson.status === "lesson");
}

/** Fires on a diff's paths or changed-line tokens, exactly like an escape rule. */
export const lessonFires = (lesson: EscapeLesson, paths: readonly string[], diff: string): boolean =>
  lesson.trigger !== null && ruleFires({trigger: lesson.trigger}, paths, diff);


export const isLessonLabel = (label: string): label is EscapeLesson["label"] => (LESSON_LABELS as readonly string[]).includes(label);

/** Validated, then written without following links; one file per id, so a rerun replaces it. Commit it with the fix. */
export async function writeLesson(root: string, lesson: EscapeLesson): Promise<string> {
  parseLesson(lesson, `${lesson.id}.json`);
  for (const part of [".agent-ops-escapes", LESSONS_DIRECTORY]) {
    const path = join(root, part);
    try { if (!(await lstat(path)).isDirectory()) unsafe(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(path);
      if (!(await lstat(path)).isDirectory()) unsafe();
    }
  }
  const path = join(root, LESSONS_DIRECTORY, `${lesson.id}.json`);
  try { if (!(await lstat(path)).isFile()) unsafe(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // O_NOFOLLOW closes the lstat-to-open race on POSIX; Windows has no such flag.
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o644);
  try { await handle.writeFile(`${JSON.stringify(lesson, null, 2)}\n`, "utf8"); } finally { await handle.close(); }
  return path;
}

/**
 * Finish gate: an escape labelled scenario, requirement or review needs a lesson file
 * (lesson, no-entry or not-run) naming the task. The ledger record's label wins over the declared one.
 */
export async function lessonCompletionProblem(root: string, task: Pick<AgentTask, "id" | "origin">): Promise<{ code: string; reason: string } | null> {
  if (task.origin?.kind !== "escape-of") return null;
  const label = (await readEscapeRecord(root, task.id))?.label ?? task.origin.label;
  if (!isLessonLabel(label)) return null;
  let lessons: LoadedLesson[];
  try { lessons = await readLessons(root); }
  catch (error) {
    return {code: error instanceof AgentOpsError ? error.code : "ESCAPE_LESSON_INVALID", reason: error instanceof Error ? error.message : "Lessons unreadable."};
  }
  return lessons.some(loaded => loaded.lesson.taskId === task.id) ? null : {code: "ESCAPE_LESSON_MISSING",
    reason: `A ${label} escape needs a lesson record: run agent-ops escapes reflect --task ${task.id}, then commit ${LESSONS_DIRECTORY}/.`};
}

/** Included globs of an audit; a covers-only child uses its parent's included rows it covers. */
export function includedGlobs(surface: TaskSurface | undefined, parent?: TaskSurface): string[] {
  if (surface === undefined) return [];
  if (!isCovers(surface)) return surface.included.map(row => row.path);
  return parent === undefined || isCovers(parent) ? [] : parent.included.filter(row => surface.covers.includes(row.id)).map(row => row.path);
}

/** Early notice and advisory DATA: status lesson entries whose trigger paths overlap these globs. Throws like loadLessons. */
export async function pathMatchedLessons(root: string, globs: readonly string[]): Promise<EscapeLesson[]> {
  if (globs.length === 0) return [];
  return (await loadLessons(root)).map(({lesson}) => lesson).filter(lesson => lesson.trigger!.paths.some(path =>
    globs.some(glob => globsOverlap(path, glob))));
}

const wild = /[*?]/u;
/** A plain path overlaps a glob that matches it; two wildcard globs overlap when one static prefix contains the other. */
// ponytail: two wildcard globs are compared by static prefix only (src/**/*.md "overlaps" src/x/**); fine for a non-blocking notice.
export function globsOverlap(a: string, b: string): boolean {
  if (!wild.test(a)) return globMatcher(b)(a);
  if (!wild.test(b)) return globMatcher(a)(b);
  const [pa, pb] = [a, b].map(glob => glob.slice(0, glob.search(wild)));
  return pa!.startsWith(pb!) || pb!.startsWith(pa!);
}
