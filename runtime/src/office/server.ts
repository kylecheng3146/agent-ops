import {randomBytes, timingSafeEqual} from "node:crypto";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {rm} from "node:fs/promises";
import {join} from "node:path";

import {AgentOpsError} from "../fs/paths.js";
import {localStatePaths, readPrivateFile, withPrivateFileLock, writePrivateFile} from "../security/permissions.js";
import {officePage} from "./page.js";
import type {OfficeSnapshot} from "./snapshot.js";

export const OFFICE_IDLE_MS = 10 * 60 * 1000;
const ACTIVE = new Set(["active", "awaiting-input", "stopping"]);

export interface OfficeRecord {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly startedAt: string;
}

/** Where one Office keeps its record: `dir` inside the private-file `anchor`. */
export interface OfficeHome {
  readonly anchor: string;
  readonly dir: string;
}

/** The user's one Office, beside the other per-user agent-ops state. */
export const userOfficeHome = (homeDirectory: string): OfficeHome =>
  ({anchor: homeDirectory, dir: join(localStatePaths(homeDirectory).root, "office")});
/** Where 0.7 kept one Office per repository. */
export const legacyOfficeHome = (commonDir: string): OfficeHome => ({anchor: commonDir, dir: join(commonDir, "agent-ops")});

export const officeRecordPath = (home: OfficeHome): string => join(home.dir, "office.json");
const officeStartLockPath = (home: OfficeHome): string => join(home.dir, "office-start.lock");
export const officeUrl = (record: Pick<OfficeRecord, "port" | "token">): string =>
  `http://127.0.0.1:${record.port}/?token=${record.token}`;

export interface OfficeServerOptions {
  readonly snapshot: () => Promise<OfficeSnapshot>;
  readonly token?: string;
  readonly now?: () => number;
  readonly idleMs?: number;
  readonly onIdle: () => void;
}

export interface OfficeServer {
  readonly server: Server;
  readonly token: string;
  listen(): Promise<number>;
  /** Re-reads the building; calls onIdle once no run has been active for idleMs. */
  tick(): Promise<void>;
  close(): Promise<void>;
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {"Content-Type": type, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", ...headers});
  res.end(body);
}

/** Loopback-only, token-gated, GET-only view of the building. */
export function createOfficeServer(options: OfficeServerOptions): OfficeServer {
  const token = options.token ?? randomBytes(24).toString("base64url");
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? OFFICE_IDLE_MS;
  let lastActive = now();
  let port = 0;
  let idle = false;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // DNS-rebinding guard: a foreign name resolving to loopback still carries its own Host.
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 421, "text/plain", "Misdirected request\n");
    if (req.method !== "GET") return send(res, 405, "text/plain", "Method not allowed\n", {Allow: "GET"});
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (!same(url.searchParams.get("token") ?? "", token)) return send(res, 403, "text/plain", "Forbidden\n");
    if (url.pathname === "/") {
      const nonce = randomBytes(16).toString("base64");
      return send(res, 200, "text/html; charset=utf-8", officePage(nonce), {"Content-Security-Policy":
        `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'`});
    }
    if (url.pathname === "/snapshot.json") return send(res, 200, "application/json", JSON.stringify(await options.snapshot()));
    return send(res, 404, "text/plain", "Not found\n");
  };
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {if (!res.headersSent) send(res, 500, "text/plain", "Snapshot unavailable\n"); else res.end();});
  });
  return {
    server, token,
    listen: async () => await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        port = typeof address === "object" && address !== null ? address.port : 0;
        resolve(port);
      });
    }),
    tick: async () => {
      const snapshot = await options.snapshot().catch(() => null);
      const sessionIsPresent = snapshot?.lobby.some(desk =>
        (desk.sessionActive ?? desk.status === "active") && (desk.completedAt === undefined || desk.completedAt === null)
      ) ?? false;
      if (snapshot === null || snapshot.runs.some(run => ACTIVE.has(run.status)) || sessionIsPresent) lastActive = now();
      if (!idle && now() - lastActive >= idleMs) {idle = true; options.onIdle();}
    },
    close: async () => await new Promise<void>(resolve => {server.closeAllConnections(); server.close(() => resolve());})
  };
}

function alive(pid: number): boolean {
  try {process.kill(pid, 0); return true;}
  catch (error) {return (error as {code?: string}).code === "EPERM";}
}

/** A recorded server counts only if its process lives and it answers with its own token. */
export async function readLiveOffice(home: OfficeHome): Promise<OfficeRecord | null> {
  const source = await readPrivateFile(officeRecordPath(home), home.anchor).catch(() => null);
  if (source === null) return null;
  try {
    const record = JSON.parse(source) as OfficeRecord;
    if (!Number.isSafeInteger(record.pid) || !Number.isSafeInteger(record.port) || typeof record.token !== "string" || !alive(record.pid)) return null;
    const response = await fetch(`http://127.0.0.1:${record.port}/snapshot.json?token=${encodeURIComponent(record.token)}`,
      {signal: AbortSignal.timeout(2000)});
    await response.body?.cancel();
    return response.status === 200 ? record : null;
  } catch {return null;}
}

/**
 * Starts serving unless another live server already owns this home.
 * Returns null when this process should exit because one is already running.
 */
export async function claimOffice(home: OfficeHome, office: OfficeServer, pid = process.pid): Promise<OfficeRecord | null> {
  return await withPrivateFileLock(officeRecordPath(home), home.anchor, async () => {
    if (await readLiveOffice(home) !== null) return null;
    const record: OfficeRecord = {pid, port: await office.listen(), token: office.token, startedAt: new Date().toISOString()};
    await writePrivateFile(officeRecordPath(home), JSON.stringify(record) + "\n", home.anchor);
    return record;
  });
}

/** Reuse the live server, or start one and wait for it to record itself. */
export async function ensureOffice(home: OfficeHome, start: () => Promise<void>,
  options: {readonly timeoutMs?: number; readonly pollMs?: number} = {}): Promise<string> {
  return await withPrivateFileLock(officeStartLockPath(home), home.anchor, async () => {
    const live = await readLiveOffice(home);
    if (live !== null) return officeUrl(live);
    await start();
    const deadline = Date.now() + (options.timeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 200));
      const started = await readLiveOffice(home);
      if (started !== null) return officeUrl(started);
    }
    throw new AgentOpsError("OFFICE_START_FAILED", "The office server did not record itself in time.");
  });
}

/** Drop the record on exit, unless another server has replaced it. */
export async function releaseOffice(home: OfficeHome, record: OfficeRecord): Promise<void> {
  await withPrivateFileLock(officeRecordPath(home), home.anchor, async () => {
    const source = await readPrivateFile(officeRecordPath(home), home.anchor).catch(() => null);
    if (source !== null && (JSON.parse(source) as OfficeRecord).token === record.token) await rm(officeRecordPath(home), {force: true});
  });
}
