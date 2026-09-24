import { chmod, copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import type {
  AgentOpsConfig,
  WorktreeSetupCommand
} from "../contracts.js";
import { calculateConfigHash } from "../config/hash.js";
import { parseInstallManifest } from "../fs/manifest.js";
import { AgentOpsError } from "../fs/paths.js";
import type { CompletionGateService } from "../hooks/completion-gate.js";
import { writeSessionMarker } from "../hooks/codex-loop.js";
import { readPrivateFile, writePrivateFile } from "../security/permissions.js";

/**
 * One Git worktree per writing session, so parallel sessions stop sharing the
 * change surface every fingerprint is taken over. Worktrees live inside the
 * main checkout, kept out of its surface by `.git/info/exclude` — never by
 * `.gitignore`, whose edit would itself be a change the gate has to explain.
 */
export const WORKTREE_DIRECTORY = ".worktrees";
export const WORKTREE_BRANCH_PREFIX = "agent-ops/";
export const WORKTREE_RECORD_PATH = ".agent-ops/tasks/worktree.json";
const EXCLUDE_LINE = `/${WORKTREE_DIRECTORY}/`;
const NAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const SESSION = /^[^\0\r\n]{1,256}$/u;
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
  readonly createdAt: string;
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
  const paths = new Set<string>();
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
  await (await deps.gate(record.mainRoot, mainConfig)).redirect(record.sessionId, record.path);
}

async function removeCheckout(deps: WorktreeDependencies, record: WorktreeRecord, force: boolean): Promise<void> {
  await git(deps, record.mainRoot,
    ["worktree", "remove", ...(force ? ["--force"] : []), record.path],
    "WORKTREE_REMOVE_FAILED", `Git could not remove ${record.path}.`);
  await git(deps, record.mainRoot, ["branch", force ? "-D" : "-d", record.branch],
    "WORKTREE_REMOVE_FAILED", `Git could not delete ${record.branch}.`);
}

/**
 * Creates `.worktrees/<name>` on `agent-ops/<name>` from the main checkout's
 * HEAD and makes it a working agent-ops checkout for `sessionId`.
 */
export async function addWorktree(
  deps: WorktreeDependencies,
  options: { readonly cwd: string; readonly name: string | undefined; readonly sessionId: string | undefined }
): Promise<WorktreeAddResult> {
  const name = assertWorktreeName(options.name);
  const sessionId = assertSessionId(options.sessionId);
  const { mainRoot, currentRoot, commonDir } = await resolveCheckouts(deps, options.cwd);
  if (currentRoot !== mainRoot) {
    throw worktreeError("WORKTREE_NESTED",
      `Run worktree commands from the main checkout (${mainRoot}), not from inside a worktree.`);
  }
  const targetBranch = await git(deps, mainRoot, ["symbolic-ref", "--short", "-q", "HEAD"],
    "WORKTREE_DETACHED_HEAD", "The main checkout must be on a branch to merge back into.");
  const base = await git(deps, mainRoot, ["rev-parse", "--verify", "HEAD^{commit}"],
    "WORKTREE_NO_COMMIT", "The main checkout has no commit to branch from.");
  const path = worktreePath(mainRoot, name);
  const branch = `${WORKTREE_BRANCH_PREFIX}${name}`;
  if (await exists(path)) {
    throw worktreeError("WORKTREE_EXISTS", `${path} already exists; pick another name or resume it.`);
  }
  if ((await deps.git(mainRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).exitCode === 0) {
    throw worktreeError("WORKTREE_EXISTS", `Branch ${branch} already exists; pick another name.`);
  }
  const mainConfig = await deps.loadConfig(mainRoot);
  const mainTrust = await deps.trust.status(mainRoot, mainConfig);
  const setupSteps = mainConfig.worktree?.setup ?? [];
  if (setupSteps.length > 0 && mainTrust !== "TRUSTED") {
    throw worktreeError("WORKTREE_SETUP_UNTRUSTED",
      "worktree.setup runs repository commands; run agent-ops trust grant in the main checkout first.");
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
      await (await deps.gate(mainRoot, mainConfig)).redirect(sessionId, null).catch(() => undefined);
    }
    if (trusted) await deps.trust.revoke(record.path, mainConfig).catch(() => undefined);
    await removeCheckout(deps, record, true).catch(() => undefined);
    throw error;
  }
}
