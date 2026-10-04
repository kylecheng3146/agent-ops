import { chmod, copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import type {
  AgentOpsConfig,
  WorktreeSetupCommand
} from "../contracts.js";
import { calculateConfigHash } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { parseInstallManifest } from "../fs/manifest.js";
import { AgentOpsError } from "../fs/paths.js";
import type { CompletionGateService } from "../hooks/completion-gate.js";
import { writeSessionMarker } from "../hooks/codex-loop.js";
import { readPrivateFile, withPrivateFileLock, writePrivateFile } from "../security/permissions.js";

/**
 * One Git worktree per writing session, so parallel sessions stop sharing the
 * change surface every fingerprint is taken over. Worktrees live inside the
 * main checkout, kept out of its surface by `.git/info/exclude` — never by
 * `.gitignore`, whose edit would itself be a change the gate has to explain.
 */
export const WORKTREE_DIRECTORY = ".worktrees";
export const WORKTREE_BRANCH_PREFIX = "agent-ops/";
export const WORKTREE_RECORD_PATH = ".agent-ops/tasks/worktree.json";
/** The notes ref `worktree finish` records a merge in. */
export const NOTES_REF = "agent-ops";
/** The note line binding a merge to the session that finished it. */
export const noteSessionLine = (sessionId: string): string => `session: ${sessionId}`;
const EXCLUDE_LINE = `/${WORKTREE_DIRECTORY}/`;
const NAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const SESSION = /^[^\0\r\n]{1,256}$/u;
const TARGET_BRANCH = /^[A-Za-z0-9._/-]{1,128}$/u;
const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60 * 1000;

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type TrustState = "TRUSTED" | "STALE" | "UNTRUSTED";

export interface WorktreeDependencies {
  readonly git: (cwd: string, args: readonly string[]) => Promise<GitResult>;
  readonly loadConfig: (root: string) => Promise<AgentOpsConfig>;
  readonly trust: {
    readonly status: (root: string, config: AgentOpsConfig) => Promise<TrustState>;
    readonly grant: (root: string, config: AgentOpsConfig) => Promise<void>;
    readonly revoke: (root: string, config: AgentOpsConfig) => Promise<void>;
  };
  /** The completion gate of one checkout, for seeding and redirecting sessions. */
  readonly gate: (root: string, config: AgentOpsConfig) => Promise<CompletionGateService>;
  readonly runSetup: (
    cwd: string,
    step: WorktreeSetupCommand
  ) => Promise<{ readonly exitCode: number | null; readonly output: string }>;
  readonly now?: () => string;
}

/** What `worktree add` leaves behind for finish, list and resume to read. */
export interface WorktreeRecord {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly branch: string;
  readonly path: string;
  readonly mainRoot: string;
  readonly targetBranch: string;
  readonly base: string;
  readonly sessionId: string;
  /** The subagent that owns this worktree; absent for the session's own. */
  readonly agentId?: string;
  /** F run identity; absent on legacy worktrees. */
  readonly runId?: string;
  readonly coordinatorId?: string;
  /** F worker identity; never inferred from a native session id. */
  readonly workerId?: string;
  /** Coordinator-issued owner session for an F worker. */
  readonly ownerSessionId?: string;
  /** F worker lease generation. */
  readonly workerGeneration?: number;
  readonly createdAt: string;
}

export interface RunWorktreeOwnership {
  readonly coordinatorId?: string;
  readonly runId: string;
  readonly workerId: string;
  readonly ownerSessionId: string;
  readonly generation: number;
}

/** The session's own worktree is open to its main thread; a subagent's only to that subagent. */
export function mayUseWorktree(
  record: WorktreeRecord,
  sessionId: string,
  agentId: string | undefined
): boolean {
  return record.sessionId === sessionId && (agentId === undefined || record.agentId === agentId);
}

/**
 * Run workers use an explicit coordinator mapping in addition to the legacy
 * session/agent guard. A native session id alone cannot claim a worktree.
 */
export function mayUseRunWorktree(
  record: WorktreeRecord,
  ownership: RunWorktreeOwnership,
  sessionId: string,
  agentId: string | undefined
): boolean {
  return mayUseWorktree(record, sessionId, agentId) &&
    record.runId === ownership.runId &&
    record.workerId === ownership.workerId &&
    record.ownerSessionId === ownership.ownerSessionId &&
    record.workerGeneration === ownership.generation;
}

export function assertRunWorktreeOwnership(
  record: WorktreeRecord,
  ownership: RunWorktreeOwnership
): void {
  if (
    record.runId !== ownership.runId ||
    record.workerId !== ownership.workerId ||
    record.ownerSessionId !== ownership.ownerSessionId ||
    record.workerGeneration !== ownership.generation
  ) {
    throw worktreeError(
      "WORKTREE_RUN_OWNERSHIP_MISMATCH",
      `Worktree ${record.name} is not owned by run ${ownership.runId}, worker ${ownership.workerId}, generation ${ownership.generation}.`
    );
  }
}

export interface WorktreeAddResult {
  readonly record: WorktreeRecord;
  readonly copied: readonly string[];
  readonly trusted: boolean;
  readonly setup: readonly string[];
}

function worktreeError(code: string, message: string): AgentOpsError {
  return new AgentOpsError(code, message);
}

async function git(
  deps: WorktreeDependencies,
  cwd: string,
  args: readonly string[],
  code: string,
  message: string
): Promise<string> {
  const result = await deps.git(cwd, args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split("\n")[0];
    throw worktreeError(code, detail === undefined || detail === "" ? message : `${message} ${detail}`);
  }
  return result.stdout.trim();
}

export function assertWorktreeName(name: string | undefined): string {
  if (name === undefined || !NAME.test(name) || name.includes("..")) {
    throw worktreeError(
      "WORKTREE_NAME_INVALID",
      "A worktree name is 1-64 lowercase letters, digits, '.', '_' or '-', starting and ending with a letter or digit."
    );
  }
  return name;
}

export function assertSessionId(sessionId: string | undefined): string {
  if (sessionId === undefined || !SESSION.test(sessionId)) {
    throw worktreeError(
      "WORKTREE_SESSION_REQUIRED",
      "Pass --session <id>: the conversation that will work in this worktree."
    );
  }
  return sessionId;
}

/**
 * The main checkout and the checkout `cwd` is in. They differ inside a linked
 * worktree. A repository whose common directory is not `<root>/.git` (bare,
 * or a separate git dir) has no main checkout to put worktrees in.
 */
export async function resolveCheckouts(
  deps: WorktreeDependencies,
  cwd: string
): Promise<{ readonly mainRoot: string; readonly currentRoot: string; readonly commonDir: string }> {
  const commonDir = await realpath(await git(deps, cwd,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    "WORKTREE_NOT_GIT", "Worktrees require a Git repository."));
  const currentRoot = await realpath(await git(deps, cwd,
    ["rev-parse", "--show-toplevel"], "WORKTREE_NOT_GIT", "Worktrees require a Git checkout."));
  if (basename(commonDir) !== ".git") {
    throw worktreeError("WORKTREE_LAYOUT_UNSUPPORTED",
      "Worktrees need a main checkout whose Git directory is <root>/.git.");
  }
  return { mainRoot: dirname(commonDir), currentRoot, commonDir };
}

export function worktreePath(mainRoot: string, name: string): string {
  return join(mainRoot, WORKTREE_DIRECTORY, name);
}

/** True when `path` is inside `<mainRoot>/.worktrees/`. */
export function insideWorktreeDirectory(mainRoot: string, path: string): boolean {
  return path.startsWith(`${join(mainRoot, WORKTREE_DIRECTORY)}${sep}`);
}

export interface WorktreeListEntry {
  readonly path: string;
  readonly branch: string | null;
}

/**
 * Parses `git worktree list --porcelain` into path/branch pairs.
 * Detached checkouts yield a null branch.
 */
export function parseWorktreeListPorcelain(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let currentPath: string | undefined;
  let currentBranch: string | null | undefined;
  const flush = () => {
    if (currentPath !== undefined) {
      entries.push({ path: currentPath, branch: currentBranch ?? null });
    }
    currentPath = undefined;
    currentBranch = undefined;
  };
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      currentBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line === "detached") {
      currentBranch = null;
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return entries.filter((entry) => entry.path.length > 0);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureExcluded(deps: WorktreeDependencies, mainRoot: string, commonDir: string): Promise<void> {
  const probe = await deps.git(mainRoot, ["check-ignore", "-q", "--no-index", `${WORKTREE_DIRECTORY}/probe`]);
  if (probe.exitCode === 0) return;
  const path = join(commonDir, "info", "exclude");
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    await mkdir(dirname(path), { recursive: true });
  }
  if (current.split(/\r?\n/u).includes(EXCLUDE_LINE)) return;
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${current}${separator}${EXCLUDE_LINE}\n`);
}

function portableRelative(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.startsWith("~") &&
    !path.includes("\\") && !path.includes("\0") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Files Git does not carry into a new worktree but the session needs there:
 * what agent-ops installed (rules, hooks, its own config) and whatever
 * `.worktreeinclude` names (gitignore syntax: `.env`, `local.properties`).
 * Only files missing from the new checkout are copied, so a tracked file
 * always keeps the branch's version.
 */
async function carriedFiles(deps: WorktreeDependencies, mainRoot: string): Promise<string[]> {
  // The config is what makes the new checkout an agent-ops checkout at all:
  // carried even when no manifest lists it.
  const paths = new Set<string>([".agent-ops/config.json"]);
  const manifestSource = await readFile(join(mainRoot, ".agent-ops", "manifest.json"), "utf8").catch(() => null);
  if (manifestSource !== null) {
    paths.add(".agent-ops/manifest.json");
    try {
      const manifest = parseInstallManifest(manifestSource);
      for (const { path } of [...manifest.artifacts, ...manifest.markers, ...(manifest.hooks ?? [])]) {
        paths.add(path);
      }
    } catch {
      // An unreadable manifest still leaves the manifest itself to copy.
    }
  }
  if (await exists(join(mainRoot, ".worktreeinclude"))) {
    const listed = await git(deps, mainRoot,
      ["ls-files", "-z", "--others", "--ignored", "--exclude-from=.worktreeinclude"],
      "WORKTREE_INCLUDE_INVALID", ".worktreeinclude could not be read.");
    for (const path of listed.split("\0")) paths.add(path);
  }
  return [...paths].filter((path) =>
    portableRelative(path) &&
    !path.startsWith(`${WORKTREE_DIRECTORY}/`) &&
    !path.startsWith(".agent-ops/tasks/") &&
    !path.startsWith(".agent-ops/reviews/")
  ).sort();
}

async function copyMissing(mainRoot: string, target: string, paths: readonly string[]): Promise<string[]> {
  const copied: string[] = [];
  for (const path of paths) {
    const source = join(mainRoot, ...path.split("/"));
    const destination = join(target, ...path.split("/"));
    let entry;
    try {
      entry = await lstat(source);
    } catch {
      continue;
    }
    if (!entry.isFile() || await exists(destination)) continue;
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    await chmod(destination, entry.mode & 0o777);
    copied.push(path);
  }
  return copied;
}

export async function readWorktreeRecord(root: string): Promise<WorktreeRecord | null> {
  const source = await readPrivateFile(join(root, ...WORKTREE_RECORD_PATH.split("/")), root).catch(() => null);
  if (source === null) return null;
  try {
    const value = JSON.parse(source) as Partial<WorktreeRecord>;
    return value.schemaVersion === 1 && typeof value.name === "string" &&
      (value.agentId === undefined || typeof value.agentId === "string") &&
      (value.runId === undefined || typeof value.runId === "string") &&
      (value.workerId === undefined || typeof value.workerId === "string") &&
      (value.coordinatorId === undefined || typeof value.coordinatorId === "string") &&
      (value.ownerSessionId === undefined || typeof value.ownerSessionId === "string") &&
      (value.workerGeneration === undefined || (typeof value.workerGeneration === "number" && Number.isSafeInteger(value.workerGeneration) && value.workerGeneration > 0)) &&
      typeof value.branch === "string" && typeof value.path === "string" &&
      typeof value.mainRoot === "string" && typeof value.targetBranch === "string" &&
      typeof value.base === "string" && typeof value.sessionId === "string" &&
      typeof value.createdAt === "string"
      ? value as WorktreeRecord
      : null;
  } catch {
    return null;
  }
}

export async function writeWorktreeRecord(record: WorktreeRecord): Promise<void> {
  await writePrivateFile(
    join(record.path, ...WORKTREE_RECORD_PATH.split("/")),
    `${JSON.stringify(record, null, 2)}\n`,
    record.path
  );
}

/** Points the session at the worktree from both sides of the gate. */
export async function bindSession(
  deps: WorktreeDependencies,
  record: WorktreeRecord,
  mainConfig: AgentOpsConfig,
  baselineFingerprint?: string
): Promise<void> {
  for (const harness of ["claude", "codex"] as const) {
    if (await exists(join(record.mainRoot, `.${harness}`))) {
      await writeSessionMarker({ root: record.path, harness, sessionId: record.sessionId });
    }
  }
  if (!mainConfig.features.completionGate.enabled) return;
  const worktreeConfig = await deps.loadConfig(record.path);
  await (await deps.gate(record.path, worktreeConfig)).seed(record.sessionId, baselineFingerprint);
  const mainGate = await deps.gate(record.mainRoot, mainConfig);
  // A subagent's worktree joins the session's roots instead of replacing its own.
  if (record.agentId === undefined) await mainGate.redirect(record.sessionId, record.path);
  else await mainGate.addRoot(record.sessionId, record.path);
}

export async function removeCheckout(
  deps: WorktreeDependencies, record: WorktreeRecord, force: boolean, expectedHead?: string
): Promise<void> {
  await git(deps, record.mainRoot,
    ["worktree", "remove", ...(force ? ["--force"] : []), record.path],
    "WORKTREE_REMOVE_FAILED", `Git could not remove ${record.path}.`);
  await git(deps, record.mainRoot, expectedHead === undefined
    ? ["branch", force ? "-D" : "-d", record.branch]
    : ["update-ref", "-d", `refs/heads/${record.branch}`, expectedHead],
  "WORKTREE_REMOVE_FAILED", `Git could not delete ${record.branch}.`);
}

/**
 * Creates `.worktrees/<name>` on `agent-ops/<name>` from `from` and makes it a
 * working agent-ops checkout for `sessionId`. With neither `from` nor
 * `targetBranch`, the branch recorded when the session began is both; without
 * a record, HEAD and its branch. When the main checkout is detached and
 * nothing is recorded, `targetBranch` names the branch `finish` merges back
 * into. A branch already checked out in another worktree is rejected before
 * Git runs, so the failure names the conflicting path.
 */
export async function addWorktree(
  deps: WorktreeDependencies,
  options: {
    readonly cwd: string;
    readonly name: string | undefined;
    readonly sessionId: string | undefined;
    readonly agentId?: string;
    readonly runOwnership?: RunWorktreeOwnership;
    readonly from?: string;
    readonly targetBranch?: string;
  }
): Promise<WorktreeAddResult> {
  const name = assertWorktreeName(options.name);
  const sessionId = assertSessionId(options.sessionId);
  if (options.targetBranch !== undefined && !TARGET_BRANCH.test(options.targetBranch)) {
    throw worktreeError("WORKTREE_TARGET_INVALID",
      `Invalid --target-branch ${options.targetBranch}; use 1-128 letters, digits, '.', '_', '/' or '-'.`);
  }
  if (options.from !== undefined && options.from.trim() === "") {
    throw worktreeError("WORKTREE_BASE_INVALID", "Invalid --from: a commit hash, branch or tag is required.");
  }
  const { mainRoot, currentRoot, commonDir } = await resolveCheckouts(deps, options.cwd);
  if (currentRoot !== mainRoot) {
    throw worktreeError("WORKTREE_NESTED",
      `Run worktree commands from the main checkout (${mainRoot}), not from inside a worktree.`);
  }
  // Without an explicit target or base, the branch the main checkout was on
  // when the session began, not the one it is on now: the user may have
  // switched since.
  const origin = options.targetBranch === undefined && options.from === undefined
    ? await readSessionOrigin(mainRoot, sessionId) : null;
  if (origin !== null &&
    (await deps.git(mainRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${origin}`])).exitCode !== 0) {
    throw worktreeError("WORKTREE_ORIGIN_MISSING",
      `The session began on ${origin}, which no longer exists; pass --target-branch to agent-ops worktree add.`);
  }
  const headRef = await deps.git(mainRoot, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const targetBranch = options.targetBranch ?? origin ?? headRef.stdout.trim();
  if (targetBranch === "") {
    throw worktreeError("WORKTREE_TARGET_REQUIRED",
      "The main checkout is detached; pass --target-branch <branch> naming the branch finish merges back into.");
  }
  if (!TARGET_BRANCH.test(targetBranch)) {
    throw worktreeError("WORKTREE_TARGET_INVALID",
      `Invalid target branch ${targetBranch}; use 1-128 letters, digits, '.', '_', '/' or '-'.`);
  }
  const fromRef = options.from ?? (origin === null ? "HEAD" : `refs/heads/${origin}`);
  const base = await git(deps, mainRoot, ["rev-parse", "--verify", `${fromRef}^{commit}`],
    options.from === undefined ? "WORKTREE_NO_COMMIT" : "WORKTREE_BASE_INVALID",
    options.from === undefined
      ? "The main checkout has no commit to branch from."
      : `Cannot resolve --from ${options.from} to a commit.`);
  const path = worktreePath(mainRoot, name);
  const branch = `${WORKTREE_BRANCH_PREFIX}${name}`;
  if (await exists(path)) {
    throw worktreeError("WORKTREE_EXISTS", `${path} already exists; pick another name or resume it.`);
  }
  if ((await deps.git(mainRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).exitCode === 0) {
    throw worktreeError("WORKTREE_EXISTS", `Branch ${branch} already exists; pick another name.`);
  }
  const listing = await deps.git(mainRoot, ["worktree", "list", "--porcelain"]);
  if (listing.exitCode === 0) {
    for (const entry of parseWorktreeListPorcelain(listing.stdout)) {
      if (entry.branch !== targetBranch && entry.branch !== branch) continue;
      const listed = await realpath(entry.path).catch(() => entry.path);
      if (listed === mainRoot) continue;
      throw worktreeError("WORKTREE_BRANCH_CHECKED_OUT",
        `Branch ${entry.branch} is already checked out at ${entry.path}; switch it back, finish or remove that worktree first (see agent-ops worktree list).`);
    }
  }
  const mainConfig = await deps.loadConfig(mainRoot);
  const mainTrust = await deps.trust.status(mainRoot, mainConfig);
  const setupSteps = mainConfig.worktree?.setup ?? [];
  if (setupSteps.length > 0 && mainTrust !== "TRUSTED") {
    throw worktreeError("WORKTREE_SETUP_UNTRUSTED",
      "worktree.setup runs repository commands and the main checkout is not trusted: trust is bound to the config hash, " +
      "so a hand edit of .agent-ops/config.json (adding worktree.setup, say) leaves it untrusted. " +
      "Trust is the user's to grant, once: run agent-ops update in the main checkout, which lists the commands it will trust and asks.");
  }

  await ensureExcluded(deps, mainRoot, commonDir);
  await git(deps, mainRoot, ["worktree", "add", "-b", branch, path, base],
    "WORKTREE_ADD_FAILED", "Git could not create the worktree.");
  const record: WorktreeRecord = {
    schemaVersion: 1,
    name,
    branch,
    path: await realpath(path),
    mainRoot,
    targetBranch,
    base,
    sessionId,
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    ...(options.runOwnership === undefined ? {} : {
      runId: options.runOwnership.runId,
      ...(options.runOwnership.coordinatorId === undefined ? {} : {coordinatorId: options.runOwnership.coordinatorId}),
      workerId: options.runOwnership.workerId,
      ownerSessionId: options.runOwnership.ownerSessionId,
      workerGeneration: options.runOwnership.generation
    }),
    createdAt: deps.now?.() ?? new Date().toISOString()
  };
  let trusted = false;
  try {
    const copied = await copyMissing(mainRoot, record.path, await carriedFiles(deps, mainRoot));
    const worktreeConfig = await deps.loadConfig(record.path);
    // The same commands the user already trusted, and nothing else: any
    // difference in config leaves the new checkout untrusted.
    if (mainTrust === "TRUSTED" && calculateConfigHash(worktreeConfig) === calculateConfigHash(mainConfig)) {
      await deps.trust.grant(record.path, worktreeConfig);
      trusted = true;
    }
    const setup: string[] = [];
    for (const step of setupSteps) {
      const result = await deps.runSetup(record.path, {
        ...step,
        timeoutMs: step.timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS
      });
      const label = [step.command, ...step.args].join(" ");
      if (result.exitCode !== 0) {
        throw worktreeError("WORKTREE_SETUP_FAILED",
          `Setup step failed (${label}, exit ${String(result.exitCode)}); the worktree was removed. ${result.output.trim().split("\n").slice(-5).join("\n")}`.trim());
      }
      setup.push(label);
    }
    await writeWorktreeRecord(record);
    await bindSession(deps, record, mainConfig);
    return { record, copied, trusted, setup };
  } catch (error) {
    if (mainConfig.features.completionGate.enabled) {
      const mainGate = await deps.gate(mainRoot, mainConfig);
      await (options.agentId === undefined ? mainGate.redirect(sessionId, null) : mainGate.removeRoot(sessionId, path))
        .catch(() => undefined);
    }
    if (trusted) await deps.trust.revoke(record.path, mainConfig).catch(() => undefined);
    await removeCheckout(deps, record, true).catch(() => undefined);
    throw error;
  }
}

/** `session-` plus the session id's first eight name-safe characters. */
export function sessionWorktreeName(sessionId: string): string {
  const slug = sessionId.toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 8);
  return `session-${slug === "" ? "0" : slug}`;
}

/** The session's worktree name plus the first eight name-safe characters of the subagent id. */
export function agentWorktreeName(sessionId: string, agentId: string): string {
  const slug = agentId.toLowerCase().replace(/[^a-z0-9]/gu, "").slice(0, 8);
  return `${sessionWorktreeName(sessionId)}-${slug === "" ? "0" : slug}`;
}

/**
 * The worktree `sessionId` (or one of its subagents) works in, created on
 * first use. One already bound to the same session and agent is reused, so a
 * writer blocked twice before it moves still gets exactly one worktree.
 */
export async function ensureSessionWorktree(
  deps: WorktreeDependencies,
  options: { readonly cwd: string; readonly sessionId: string; readonly agentId?: string }
): Promise<WorktreeRecord> {
  const { mainRoot } = await resolveCheckouts(deps, options.cwd);
  const { agentId } = options;
  const name = agentId === undefined
    ? sessionWorktreeName(options.sessionId)
    : agentWorktreeName(options.sessionId, agentId);
  const existing = await readWorktreeRecord(worktreePath(mainRoot, name));
  if (existing?.sessionId === options.sessionId && existing.agentId === agentId) return existing;
  return (await addWorktree(deps, {
    cwd: mainRoot,
    name,
    sessionId: options.sessionId,
    ...(agentId === undefined ? {} : { agentId })
  })).record;
}

function sessionOriginPath(mainRoot: string, sessionId: string): string {
  return join(mainRoot, ".agent-ops", "tasks", "session-origin", sha256(sessionId));
}

/** The branch recorded when `sessionId` began, or null. */
export async function readSessionOrigin(mainRoot: string, sessionId: string): Promise<string | null> {
  const value = (await readPrivateFile(sessionOriginPath(mainRoot, sessionId), mainRoot).catch(() => null))?.trim();
  return value !== undefined && TARGET_BRANCH.test(value) ? value : null;
}

/**
 * Pins the branch the main checkout is on to `sessionId`, first write wins:
 * SessionStart fires again on resume, compact and clear, by which time the
 * user may have moved. Nothing is recorded from inside a worktree or on a
 * detached HEAD, so a later add falls back to reading HEAD itself.
 */
export async function recordSessionOrigin(
  deps: WorktreeDependencies,
  options: { readonly cwd: string; readonly sessionId: string }
): Promise<void> {
  if (!SESSION.test(options.sessionId)) return;
  const { mainRoot, currentRoot } = await resolveCheckouts(deps, options.cwd);
  if (currentRoot !== mainRoot) return;
  const branch = (await deps.git(mainRoot, ["symbolic-ref", "--short", "-q", "HEAD"])).stdout.trim();
  if (!TARGET_BRANCH.test(branch)) return;
  const path = sessionOriginPath(mainRoot, options.sessionId);
  await withPrivateFileLock(path, mainRoot, async () => {
    if (await readPrivateFile(path, mainRoot) === null) await writePrivateFile(path, `${branch}\n`, mainRoot);
  });
}
