import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { AgentOpsError } from "../fs/paths.js";
import { readPrivateFile, writePrivateFile } from "../security/permissions.js";

const execFile = promisify(execFileCallback);

export interface BootLoginIdentity {
  readonly boot: string;
  readonly login: string;
}

export interface LaunchdDescriptorInput {
  readonly runId: string;
  readonly workerId: string;
  readonly privateDirectory: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  readonly uid?: number;
  readonly pathEnvironment?: string;
}

export interface LaunchdDescriptor {
  readonly label: string;
  readonly domain: string;
  readonly path: string;
  readonly privateDirectory: string;
  readonly disabledPath: string;
  readonly xml: string;
}

export interface ResumeDecision {
  readonly resume: boolean;
  readonly reason: "same-login" | "boot-change" | "login-change";
}

export interface LaunchdExecResult {
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface LaunchdControllerOptions {
  readonly platform?: NodeJS.Platform;
  readonly uid?: number;
  readonly execFile?: (
    file: string,
    args: readonly string[],
    options: { readonly cwd?: string }
  ) => Promise<LaunchdExecResult>;
}

function xml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function shellSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 60) || "worker";
}

function assertPathInside(root: string, candidate: string): void {
  const canonicalRoot = resolve(root);
  const canonicalCandidate = resolve(candidate);
  if (canonicalCandidate !== canonicalRoot && !canonicalCandidate.startsWith(`${canonicalRoot}/`)) {
    throw new AgentOpsError("LAUNCHD_PATH_INVALID", "launchd transient state escaped its private directory.");
  }
}

function defaultUid(): number {
  if (typeof process.getuid !== "function") {
    throw new AgentOpsError("LAUNCHD_UID_UNAVAILABLE", "launchd requires a macOS user id.");
  }
  return process.getuid();
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { readonly cwd?: string }
): Promise<LaunchdExecResult> {
  return execFile(file, [...args], options).then((result) => ({
    stdout: result.stdout,
    stderr: result.stderr
  }));
}

export function createLaunchdDescriptor(input: LaunchdDescriptorInput): LaunchdDescriptor {
  if (input.runId.length === 0 || input.workerId.length === 0 || input.command.length === 0 || input.cwd.length === 0) {
    throw new AgentOpsError("LAUNCHD_DESCRIPTOR_INVALID", "launchd descriptor fields cannot be empty.");
  }
  const privateDirectory = resolve(input.privateDirectory);
  const label = `com.agent-ops.run.${shellSafe(input.runId)}.${shellSafe(input.workerId)}.${createHash("sha256").update(input.runId).digest("hex").slice(0, 8)}`;
  const path = join(privateDirectory, `${label}.plist`);
  const disabledPath = join(privateDirectory, `${label}.disabled.json`);
  assertPathInside(privateDirectory, path);
  assertPathInside(privateDirectory, disabledPath);
  const uid = input.uid ?? (process.platform === "darwin" ? defaultUid() : 0);
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new AgentOpsError("LAUNCHD_UID_INVALID", "launchd user id is invalid.");
  }
  const stdoutPath = input.stdoutPath ?? join(privateDirectory, `${label}.stdout.log`);
  const stderrPath = input.stderrPath ?? join(privateDirectory, `${label}.stderr.log`);
  assertPathInside(privateDirectory, stdoutPath);
  assertPathInside(privateDirectory, stderrPath);
  const argumentsXml = [input.command, ...input.args]
    .map((arg) => `    <string>${xml(arg)}</string>`)
    .join("\n");
  const xmlDocument = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>WorkingDirectory</key><string>${xml(input.cwd)}</string>
${input.pathEnvironment === undefined ? "" : "  <key>EnvironmentVariables</key><dict><key>PATH</key><string>" + xml(input.pathEnvironment) + "</string></dict>"}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(stderrPath)}</string>
</dict>
</plist>
`;
  return {
    label,
    domain: `gui/${uid}`,
    path,
    privateDirectory,
    disabledPath,
    xml: xmlDocument
  };
}

export function compareBootLogin(
  saved: BootLoginIdentity,
  current: BootLoginIdentity
): ResumeDecision {
  if (saved.boot !== current.boot) {
    return { resume: false, reason: "boot-change" };
  }
  if (saved.login !== current.login) {
    return { resume: false, reason: "login-change" };
  }
  return { resume: true, reason: "same-login" };
}

export async function readBootIdentity(
  platform: NodeJS.Platform = process.platform,
  run: LaunchdControllerOptions["execFile"] = defaultExecFile
): Promise<string> {
  if (platform !== "darwin") {
    return `platform:${platform}`;
  }
  const result = await run("sysctl", ["-n", "kern.boottime"], {});
  const value = result.stdout?.trim();
  if (value === undefined || value.length === 0) {
    throw new AgentOpsError("LAUNCHD_BOOT_IDENTITY_UNAVAILABLE", "macOS boot identity was empty.");
  }
  return value;
}

export function readLoginIdentity(uid = defaultUid()): string {
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new AgentOpsError("LAUNCHD_UID_INVALID", "macOS login user id is invalid.");
  }
  return `uid:${uid}:${process.env.LOGNAME ?? process.env.USER ?? "unknown"}`;
}

/** A uid alone survives logout/login; the GUI audit session identifies this login. */
export async function readGuiLoginIdentity(uid = defaultUid(),
  run: LaunchdControllerOptions["execFile"] = defaultExecFile): Promise<string> {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new AgentOpsError("LAUNCHD_UID_INVALID", "Invalid macOS login user id.");
  const result = await run("launchctl", ["print", `gui/${uid}`], {});
  const security = result.stdout?.match(/^\tsecurity context = \{[\s\S]*?^\t\}/mu)?.[0];
  const auditSession = security?.match(/^\s*asid = ([0-9]+)$/mu)?.[1];
  if (auditSession === undefined) throw new AgentOpsError("LAUNCHD_LOGIN_IDENTITY_UNAVAILABLE", "Cannot identify the current GUI audit session.");
  return `gui:${uid}:asid:${auditSession}`;
}

export class LaunchdController {
  private readonly platform: NodeJS.Platform;
  private readonly uid: number;
  private readonly run: NonNullable<LaunchdControllerOptions["execFile"]>;

  constructor(options: LaunchdControllerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.uid = options.uid ?? (this.platform === "darwin" ? defaultUid() : 0);
    this.run = options.execFile ?? defaultExecFile;
  }

  get supported(): boolean {
    return this.platform === "darwin";
  }

  async writeDescriptor(descriptor: LaunchdDescriptor): Promise<void> {
    this.assertSupported();
    await writePrivateFile(descriptor.path, descriptor.xml, descriptor.privateDirectory);
  }

  async bootstrap(descriptor: LaunchdDescriptor): Promise<void> {
    this.assertSupported();
    await this.run("launchctl", ["bootstrap", descriptor.domain, descriptor.path], {
      cwd: descriptor.privateDirectory
    });
  }

  async wake(descriptor: LaunchdDescriptor): Promise<void> {
    this.assertSupported();
    try {await this.bootstrap(descriptor);}
    catch {await this.run("launchctl", ["kickstart", `${descriptor.domain}/${descriptor.label}`], {cwd: descriptor.privateDirectory});}
  }

  async bootout(descriptor: LaunchdDescriptor): Promise<void> {
    this.assertSupported();
    try {
      await this.run("launchctl", ["bootout", `${descriptor.domain}/${descriptor.label}`], {cwd: descriptor.privateDirectory});
    } catch (cause) {
      const failure = cause as {stderr?: unknown; code?: unknown};
      if (failure.code !== 3 || typeof failure.stderr !== "string" || !failure.stderr.includes("No such process")) throw cause;
    }
  }

  async disableRestart(descriptor: LaunchdDescriptor, reason: string): Promise<void> {
    this.assertSupported();
    if (reason.length === 0 || reason.length > 512 || reason.includes("\0")) {
      throw new AgentOpsError("LAUNCHD_DISABLE_REASON_INVALID", "launchd disable reason is invalid.");
    }
    await writePrivateFile(
      descriptor.disabledPath,
      `${JSON.stringify({ disabled: true, reason, at: new Date().toISOString() })}\n`,
      descriptor.privateDirectory
    );
    await this.run("launchctl", ["disable", `${descriptor.domain}/${descriptor.label}`], {
      cwd: descriptor.privateDirectory
    });
  }

  async isRestartDisabled(descriptor: LaunchdDescriptor): Promise<boolean> {
    return (await readPrivateFile(descriptor.disabledPath, descriptor.privateDirectory)) !== null;
  }

  async enableRestart(descriptor: LaunchdDescriptor): Promise<void> {
    this.assertSupported();
    await this.run("launchctl", ["enable", `${descriptor.domain}/${descriptor.label}`], {
      cwd: descriptor.privateDirectory
    });
    await rm(descriptor.disabledPath, { force: true });
  }

  private assertSupported(): void {
    if (!this.supported) {
      throw new AgentOpsError("LAUNCHD_UNSUPPORTED", "Transient launchd primitives require macOS.");
    }
  }
}
