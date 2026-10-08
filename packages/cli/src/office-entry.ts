import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

import { collectOfficeBuilding, type OfficeBuilding } from "../../../runtime/src/office/collect.js";
import { claimOffice, createOfficeServer, ensureOffice, legacyOfficeHome, officeRecordPath, readLiveOffice, officeUrl, releaseOffice, userOfficeHome, type OfficeHome } from "../../../runtime/src/office/server.js";
import { registerOfficeRepo } from "../../../runtime/src/office/repos.js";
import { recordOfficeSession, type OfficeSessionEvent } from "../../../runtime/src/office/sessions.js";
import { resolveCheckouts } from "../../../runtime/src/parallel/service.js";
import { createLaunchdDescriptor, LaunchdController } from "../../../runtime/src/run/macOS.js";
import { ensurePrivateDirectory, readPrivateFile } from "../../../runtime/src/security/permissions.js";
import { worktreeDependencies } from "./parallel-deps.js";
import type {NormalizedHookEvent} from "../../../runtime/src/hooks/events.js";
import {normalizeShellHookEvent} from "../../../runtime/src/hooks/shell.js";
import {AgentOpsError} from "../../../runtime/src/fs/paths.js";
import {loadEffectiveConfig} from "./context.js";

const entry = fileURLToPath(import.meta.url);

export type OfficeBrowser = (url: string) => Promise<void>;

/** Missing or invalid config keeps this Preview disabled. */
export async function officeEnabled(cwd: string): Promise<boolean> {
  if (process.env.AGENT_OPS_DISABLE === "1") return false;
  try {
    return (await loadEffectiveConfig(cwd, "project")).config.features.office?.enabled === true;
  } catch {
    return false;
  }
}

async function requireOffice(cwd: string): Promise<void> {
  if (!(await officeEnabled(cwd))) {
    throw new AgentOpsError("OFFICE_PREVIEW_DISABLED", "Office (Preview) is disabled. Enable it with agent-ops update --office on.");
  }
}

export interface OfficeSessionObservation {
  readonly root: string;
  readonly harness: string;
  readonly event: string;
  readonly input: unknown;
  /** Set only after the host entry has validated its managed root/config. */
  readonly validated?: boolean;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly phase?: string;
}

function recordValue(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  return (input as Record<string, unknown>)[key];
}

function observationInput(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function firstText(...values: unknown[]): string | undefined {
  return values.find((value): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\0\r\n]/u.test(value)
  );
}

function sessionIdentity(options: OfficeSessionObservation): string | undefined {
  const nested = recordValue(options.input, "input");
  return firstText(
    options.sessionId,
    recordValue(options.input, "session_id"),
    recordValue(options.input, "sessionId"),
    recordValue(options.input, "conversationId"),
    recordValue(options.input, "thread_id"),
    recordValue(options.input, "threadId"),
    recordValue(nested, "sessionID"),
    recordValue(nested, "session_id"),
    process.env.AGENT_OPS_SESSION_ID,
    process.env.CODEX_THREAD_ID
  );
}

function officeEvent(event: string): OfficeSessionEvent {
  return event === "SessionStart" ? "start" : event === "Stop" ? "stop" : event === "SessionEnd" ? "end" : "activity";
}

/** Phase hints come only from normalized native event kinds and exact agent-ops argv. */
export function officePhaseHint(event: NormalizedHookEvent): string | undefined {
  if (event.event === "file-write" || event.event === "content") return "implementing";
  const commands = event.event === "command"
    ? [event]
    : event.event === "command-batch"
      ? event.commands
      : [];
  let phase: string | undefined;
  for (const command of commands) {
    if (basename(command.command) !== "agent-ops") continue;
    const action = command.args[0];
    const next = action === "verify"
      ? "verifying"
      : action === "review"
        ? "reviewing"
        : action === "worktree" && command.args[1] === "finish"
          ? "integrating"
          : action === "task" && command.args[1] === "complete"
            ? "integrating"
            : action === "task"
              ? "planning"
              : undefined;
    if (next === "integrating" || next === "reviewing" || next === "verifying") phase = next;
    else if (phase === undefined && next !== undefined) phase = next;
  }
  return phase;
}

/** Loop adapters expose Bash and native edit events with the same safe shape. */
export function officeLoopPhaseHint(input: unknown, root: string): string | undefined {
  if (!observationInput(input)) return undefined;
  const tool = input.tool_name;
  if (tool === "Edit" || tool === "Write" || tool === "NotebookEdit" || tool === "FileWrite") return "implementing";
  if (tool !== "Bash") return undefined;
  const toolInput = recordValue(input, "tool_input");
  const command = recordValue(toolInput, "command");
  return typeof command === "string" ? officePhaseHint(normalizeShellHookEvent(command, root)) : undefined;
}

/** Records hook presence and starts Office at the production process boundary. */
export async function observeOfficeSession(options: OfficeSessionObservation): Promise<void> {
  if (process.env.AGENT_OPS_DISABLE === "1") return;
  if (options.validated !== true) return;
  // Host hooks with malformed or absent input are fail-open and must not
  // create a server from an unrelated process cwd.
  if (!observationInput(options.input)) return;
  const identity = sessionIdentity(options);
  if (identity === undefined) return;
  try {
    if (!(await officeEnabled(options.root))) return;
    const {mainRoot, commonDir} = await checkouts(options.root);
    await recordOfficeSession({
      sessionId: identity,
      harness: options.harness,
      projectRoot: mainRoot,
      commonDir,
      event: officeEvent(options.event),
      ...(options.agentId === undefined ? {} : {agentId: options.agentId}),
      ...(process.env.AGENT_OPS_RUN_ID === undefined ? {} : {runId: process.env.AGENT_OPS_RUN_ID}),
      ...(process.env.AGENT_OPS_WORKER_ID === undefined ? {} : {workerId: process.env.AGENT_OPS_WORKER_ID}),
      ...(process.env.AGENT_OPS_TASK_ID === undefined ? {} : {taskId: process.env.AGENT_OPS_TASK_ID}),
      ...(options.phase === undefined ? {} : {phase: options.phase}),
      host: options.harness
    });
    await registerOfficeRepo(officeHome(), {mainRoot, commonDir});
    // A resumed session may outlive the ten-minute idle shutdown. Reusing the
    // same ensure path revives the user's server without creating a tab
    // unless this call actually wins a new-server start claim.
    if (options.event !== "Stop" && options.event !== "SessionEnd") await ensureBackgroundOffice(options.root, undefined, openOfficeBrowser);
  } catch {
    // Office is display-only; a missing Git checkout, lock or launcher never blocks a host hook.
  }
}

async function checkouts(cwd: string): Promise<{ mainRoot: string; commonDir: string }> {
  return await resolveCheckouts(worktreeDependencies(), cwd);
}

/** The user's one Office; AGENT_OPS_HOME moves it with the rest of agent-ops' user state. */
export function officeHome(): OfficeHome {
  return userOfficeHome(process.env.AGENT_OPS_HOME ?? homedir());
}

const officeLabel = (key: string): string => "office-" + createHash("sha256").update(key).digest("hex").slice(0, 12);

/**
 * Stops and removes the server 0.7 ran for this one repository. Best effort
 * and once: without its record there is nothing left to retire. Its pid is
 * never signalled, since the record is only a file in the checkout; where
 * launchd is absent the old server simply idles out.
 */
export async function retireLegacyOffice(mainRoot: string, commonDir: string, launchd = new LaunchdController()): Promise<void> {
  const legacy = legacyOfficeHome(commonDir);
  if (await readPrivateFile(officeRecordPath(legacy), commonDir).catch(() => null) === null) return;
  if (launchd.supported) {
    await launchd.bootout(createLaunchdDescriptor({
      runId: officeLabel(commonDir), workerId: "server", privateDirectory: join(legacy.dir, "office"),
      command: process.execPath, args: [entry, mainRoot], cwd: mainRoot, pathEnvironment: process.env.PATH
    })).catch(() => {});
  }
  await rm(officeRecordPath(legacy), {force: true});
  await rm(join(legacy.dir, "office"), {recursive: true, force: true});
}

/** Serve the user's office until no run or session has been active for the idle window. */
export async function serveOffice(cwd: string, onUrl: (url: string) => void = () => {}, openBrowser?: OfficeBrowser): Promise<void> {
  await requireOffice(cwd);
  const { mainRoot, commonDir } = await checkouts(cwd);
  const home = officeHome();
  await registerOfficeRepo(home, {mainRoot, commonDir});
  // ponytail: one shared 1s building so several polling tabs cost one git scan per repository
  let cached: { at: number; value: Promise<OfficeBuilding> } | null = null;
  const building = (): Promise<OfficeBuilding> => {
    if (cached === null || Date.now() - cached.at > 1000)
      cached = { at: Date.now(), value: collectOfficeBuilding(home, officeEnabled) };
    return cached.value;
  };
  let finish = (): void => {};
  const idle = new Promise<void>((resolve) => { finish = resolve; });
  const office = createOfficeServer({ snapshot: async () => (await building()).snapshot, onIdle: () => finish() });
  const record = await claimOffice(home, office);
  if (record === null) {
    const live = await readLiveOffice(home);
    if (live !== null) onUrl(officeUrl(live));
    return;
  }
  onUrl(officeUrl(record));
  if (openBrowser !== undefined) void openBrowser(officeUrl(record)).catch(() => undefined);
  const timer = setInterval(() => {
    cached = null;
    void building().then(current => current.repos > 0 ? office.tick() : finish(), () => office.tick());
  }, 15_000);
  await idle;
  clearInterval(timer);
  await releaseOffice(home, record);
  await office.close();
}

/** Reuse the user's live server or start one under launchd; null where launchd is unavailable. */
export async function ensureBackgroundOffice(cwd: string, launchd = new LaunchdController(), openBrowser?: OfficeBrowser): Promise<string | null> {
  await requireOffice(cwd);
  const { mainRoot, commonDir } = await checkouts(cwd);
  const home = officeHome();
  await registerOfficeRepo(home, {mainRoot, commonDir});
  await retireLegacyOffice(mainRoot, commonDir, launchd).catch(() => undefined);
  const live = await readLiveOffice(home);
  if (live !== null) return officeUrl(live);
  let started = false;
  const args = [entry, mainRoot];
  if (!launchd.supported) {
    const url = await ensureOffice(home, async () => {
      started = true;
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, args, {cwd: mainRoot, detached: true, stdio: "ignore", windowsHide: true});
        child.once("error", reject);
        child.once("spawn", () => {child.unref(); resolve();});
      });
    });
    if (started && openBrowser !== undefined) void openBrowser(url).catch(() => undefined);
    return url;
  }
  const privateDirectory = join(home.dir, "launchd");
  const descriptor = createLaunchdDescriptor({
    runId: officeLabel(home.dir), workerId: "server",
    privateDirectory, command: process.execPath, args,
    cwd: mainRoot, pathEnvironment: process.env.PATH
  });
  const url = await ensureOffice(home, async () => {
    started = true;
    // The descriptor write anchors on this directory, so it must exist first.
    await ensurePrivateDirectory(privateDirectory, home.anchor);
    await launchd.writeDescriptor(descriptor);
    // A server that exited idle stays loaded in launchd; reload it with the current descriptor.
    await launchd.bootout(descriptor).catch(() => {});
    await launchd.bootstrap(descriptor);
  });
  if (started && openBrowser !== undefined) void openBrowser(url).catch(() => undefined);
  return url;
}

export function openOfficeBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "rundll32.exe"
      : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {detached: true, stdio: "ignore", windowsHide: true});
    child.once("error", reject);
    child.once("spawn", () => {child.unref(); resolve();});
  });
}

if (process.argv[1] === entry) {
  await serveOffice(process.argv[2] ?? process.cwd(), () => {}, process.argv[3] === "--open" ? openOfficeBrowser : undefined);
  process.exit(0);
}
