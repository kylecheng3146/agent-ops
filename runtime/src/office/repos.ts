import {join} from "node:path";

import {readPrivateFile, withPrivateFileLock, writePrivateFile} from "../security/permissions.js";
import type {OfficeHome} from "./server.js";

/** A repository whose hooks have reported to the user's one Office. */
export interface OfficeRepo {
  readonly mainRoot: string;
  readonly commonDir: string;
  readonly lastSeenAt: string;
}

const MAX_REPOS = 64;
const MAX_ROOT = 4_096;

export const officeReposPath = (home: OfficeHome): string => join(home.dir, "repos.json");

function parse(value: unknown): OfficeRepo | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const root = (text: unknown): text is string => typeof text === "string" && text.length > 0 && text.length <= MAX_ROOT && !/[\0\r\n]/u.test(text);
  if (!root(item.mainRoot) || !root(item.commonDir) || typeof item.lastSeenAt !== "string" || !Number.isFinite(Date.parse(item.lastSeenAt))) return null;
  return {mainRoot: item.mainRoot, commonDir: item.commonDir, lastSeenAt: item.lastSeenAt};
}

export async function readOfficeRepos(home: OfficeHome): Promise<OfficeRepo[]> {
  const source = await readPrivateFile(officeReposPath(home), home.anchor).catch(() => null);
  if (source === null) return [];
  try {
    const repos = (JSON.parse(source) as {repos?: unknown}).repos;
    return Array.isArray(repos) ? repos.slice(0, MAX_REPOS).map(parse).filter((repo): repo is OfficeRepo => repo !== null) : [];
  } catch {
    return [];
  }
}

async function update(home: OfficeHome, change: (repos: OfficeRepo[]) => OfficeRepo[]): Promise<void> {
  const path = officeReposPath(home);
  await withPrivateFileLock(path, home.anchor, async () => {
    const repos = change(await readOfficeRepos(home)).slice(-MAX_REPOS);
    await writePrivateFile(path, JSON.stringify({schemaVersion: 1, repos}) + "\n", home.anchor);
  });
}

/** Adds or refreshes one repository; the newest stays last. */
export async function registerOfficeRepo(home: OfficeHome, repo: {readonly mainRoot: string; readonly commonDir: string},
  now = Date.now()): Promise<void> {
  await update(home, repos => [...repos.filter(item => item.commonDir !== repo.commonDir),
    {mainRoot: repo.mainRoot, commonDir: repo.commonDir, lastSeenAt: new Date(now).toISOString()}]);
}

export async function forgetOfficeRepos(home: OfficeHome, commonDirs: readonly string[]): Promise<void> {
  if (commonDirs.length === 0) return;
  await update(home, repos => repos.filter(item => !commonDirs.includes(item.commonDir)));
}
