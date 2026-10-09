import {readdir, rm} from "node:fs/promises";
import {join} from "node:path";

import {readPrivateFile, writePrivateFile} from "../security/permissions.js";

/**
 * Display-only activity records: while verify, review or worktree finish runs,
 * a small file under the repository's common Git directory says so, so the
 * Office can show QA, the reviewers or the integrator at work. Writing one
 * must never change the command it describes, so every write is fail-open,
 * and a record carries only allowlisted fields, never a token or a command.
 */
export type ActivityKind = "verify" | "review" | "finish";

export interface OfficeActivity {
  readonly kind: ActivityKind;
  readonly pid: number;
  readonly root: string;
  readonly startedAt: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly worktree?: string;
  /** Review only: the two planned reviewers, the round in progress and its reviewer. */
  readonly targets?: readonly string[];
  readonly round?: 1 | 2;
  readonly target?: string;
}

export type ActivityStart = Omit<OfficeActivity, "pid" | "startedAt">;
export type ActivityPatch = Partial<Pick<OfficeActivity, "taskId" | "targets" | "round" | "target">>;

export interface ActivityHandle {
  update(patch: ActivityPatch): Promise<void>;
  end(): Promise<void>;
}

const KINDS = new Set<ActivityKind>(["verify", "review", "finish"]);
const ID = /^[A-Za-z0-9._-]{1,128}$/u;
const TARGET = /^[a-z][a-z0-9-]{0,31}$/u;
const FILE = /^(verify|review|finish)-(\d{1,10})-(\d{1,10})\.json$/u;
const NOOP: ActivityHandle = {update: async () => {}, end: async () => {}};

export function activityDirectory(commonDir: string): string {
  return join(commonDir, "agent-ops", "office-activity");
}

/** Keeps only the allowlisted, well-formed fields; null when the record cannot stand. */
export function activityValue(value: unknown): OfficeActivity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!KINDS.has(item.kind as ActivityKind) || typeof item.pid !== "number" || !Number.isInteger(item.pid) || item.pid <= 0 ||
    typeof item.root !== "string" || item.root.length === 0 || item.root.length > 4096 ||
    typeof item.startedAt !== "string" || Number.isNaN(Date.parse(item.startedAt))) return null;
  const id = (field: unknown) => typeof field === "string" && ID.test(field) ? field : undefined;
  const targets = Array.isArray(item.targets) ? item.targets.filter((t): t is string => typeof t === "string" && TARGET.test(t)).slice(0, 2) : undefined;
  const round = item.round === 1 || item.round === 2 ? item.round : undefined;
  const target = typeof item.target === "string" && TARGET.test(item.target) ? item.target : undefined;
  const taskId = id(item.taskId), sessionId = id(item.sessionId), worktree = id(item.worktree);
  return {kind: item.kind as ActivityKind, pid: item.pid, root: item.root, startedAt: item.startedAt,
    ...(taskId === undefined ? {} : {taskId}), ...(sessionId === undefined ? {} : {sessionId}), ...(worktree === undefined ? {} : {worktree}),
    ...(targets === undefined || targets.length === 0 ? {} : {targets}), ...(round === undefined ? {} : {round}), ...(target === undefined ? {} : {target})};
}

let sequence = 0;

/** Starts a record; returns a handle whose writes never throw. No common dir means no record. */
export async function beginActivity(commonDir: string | undefined, start: ActivityStart,
  options: {readonly pid?: number; readonly now?: () => Date} = {}): Promise<ActivityHandle> {
  if (commonDir === undefined || commonDir.length === 0) return NOOP;
  const pid = options.pid ?? process.pid, startedAt = (options.now ?? (() => new Date()))().toISOString();
  let current = activityValue({...start, pid, startedAt});
  if (current === null) return NOOP;
  // One process may run several reviews at once (batch), so the name carries a sequence too.
  const path = join(activityDirectory(commonDir), `${current.kind}-${pid}-${++sequence}.json`);
  // Writes run one after another in call order, so a slow early write never lands over a later one,
  // and none runs after end() has removed the record.
  let queue: Promise<void> = Promise.resolve(), ended = false;
  const write = (): Promise<void> => (queue = queue.then(async () => {
    if (ended) return;
    try { await writePrivateFile(path, JSON.stringify(current) + "\n", commonDir); } catch { /* display only */ }
  }));
  await write();
  return {
    update: async patch => { const next = activityValue({...current, ...patch}); if (next !== null) { current = next; await write(); } },
    end: async () => { ended = true; await queue; try { await rm(path, {force: true}); } catch { /* display only */ } }
  };
}

/** Runs `work` with a record present; the record goes when the work ends, however it ends. */
export async function withActivity<T>(commonDir: string | undefined, start: ActivityStart, work: (handle: ActivityHandle) => Promise<T>): Promise<T> {
  const handle = await beginActivity(commonDir, start).catch(() => NOOP);
  try { return await work(handle); }
  finally { await handle.end().catch(() => undefined); }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as {code?: string}).code === "EPERM"; }
}

/** Live records only: malformed files, files whose name disagrees with their content and dead processes are skipped. */
export async function readActivities(commonDir: string, alive: (pid: number) => boolean = processAlive): Promise<OfficeActivity[]> {
  const directory = activityDirectory(commonDir);
  const names = (await readdir(directory).catch(() => [] as string[])).filter(name => FILE.test(name)).sort().slice(0, 200);
  const records: OfficeActivity[] = [];
  for (const name of names) {
    const match = FILE.exec(name)!;
    const source = await readPrivateFile(join(directory, name), commonDir).catch(() => null);
    if (source === null || source.length > 16 * 1024) continue;
    let value: OfficeActivity | null;
    try { value = activityValue(JSON.parse(source) as unknown); } catch { continue; }
    if (value === null || value.kind !== match[1] || value.pid !== Number(match[2]) || !alive(value.pid)) continue;
    records.push(value);
  }
  return records;
}
