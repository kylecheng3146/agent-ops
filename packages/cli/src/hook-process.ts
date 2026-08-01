import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { AgentOpsConfig } from "../../../runtime/src/contracts.js";
import { calculateConfigHash } from "../../../runtime/src/config/hash.js";
import {
  parseInstallManifest,
  PROJECT_MANIFEST_PATH
} from "../../../runtime/src/fs/manifest.js";
import { resolveContainedPath } from "../../../runtime/src/fs/paths.js";
import { redactSecrets } from "../../../runtime/src/security/redact.js";
import { claudeStopRecursionMarker } from "../../../runtime/src/adapters/claude/input.js";
import {
  HARNESS_IDS,
  harnessDescriptor,
  type HarnessId,
  type HookProcessOutput
} from "../../../runtime/src/install/harness.js";
import type {
  HookDispatchOptions,
  StopVerificationOptions
} from "../../../runtime/src/hooks/events.js";
import { runLifecycleAdvisory } from "../../../runtime/src/hooks/advisory.js";
import {
  STOP_VERIFICATION_ENV,
  StopVerificationService
} from "../../../runtime/src/hooks/stop-service.js";
import type {
  GitRunResult,
  GitRunner
} from "../../../runtime/src/verify/change-surface.js";
import {
  NodeVerificationProcessRunner,
  type VerificationProcessRunner
} from "../../../runtime/src/verify/spawn.js";
import {
  normalizeHookInput,
  runHookCommand,
  HOOK_EVENTS,
  type HookEvent
} from "./commands/hook.js";
import {
  loadProjectHookConfig,
  repositoryTrust,
  type ProjectHookConfigOutcome
} from "./context.js";

const HARNESSES = new Set<string>(HARNESS_IDS);
const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
const MAX_HOOK_MANIFEST_BYTES = 1024 * 1024;
const execFile = promisify(execFileCallback);

type TrustStatus = "TRUSTED" | "STALE" | "UNTRUSTED";

export interface HookProcessDependencies {
  readonly root?: string;
  readonly loadConfig?: (root: string) => Promise<AgentOpsConfig>;
  readonly trust?: (
    root: string,
    config: AgentOpsConfig,
    cliVersion: string
  ) => Promise<TrustStatus>;
  readonly advisory?: HookDispatchOptions["advisory"];
  readonly gitRunner?: GitRunner;
  readonly processRunner?: VerificationProcessRunner;
}

export interface HookProcessIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
}

async function readStdin(
  stream: NodeJS.ReadableStream
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), "utf8");
    total += buffer.byteLength;
    if (total > MAX_HOOK_INPUT_BYTES) {
      return "";
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function parseInput(source: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return null;
  }
}

function writeHookOutput(io: HookProcessIo, output: HookProcessOutput): void {
  if (output.stdout.length > 0) {
    io.writeStdout(output.stdout);
  }
  if (output.stderr.length > 0) {
    io.writeStderr(output.stderr);
  }
}

function failOpenOutput(
  harness: HarnessId,
  event: HookEvent
): HookProcessOutput {
  return harnessDescriptor(harness).runtime.formatOutput(event, {
    action: "continue",
    status: "PASS",
    code: "HOOK_FAIL_OPEN"
  });
}

async function readInstalledManifestForHarness(
  root: string,
  harness: HarnessId
): Promise<boolean> {
  try {
    const path = await resolveContainedPath(root, PROJECT_MANIFEST_PATH);
    const before = await lstat(path, { bigint: true });
    if (
      !before.isFile() ||
      before.size > BigInt(MAX_HOOK_MANIFEST_BYTES)
    ) {
      return false;
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const opened = await handle.stat({ bigint: true });
      const resolvedAgain = await resolveContainedPath(
        root,
        PROJECT_MANIFEST_PATH
      );
      const after = await lstat(resolvedAgain, { bigint: true });
      if (
        !opened.isFile() ||
        opened.size > BigInt(MAX_HOOK_MANIFEST_BYTES) ||
        after.dev !== before.dev ||
        after.ino !== before.ino
      ) {
        return false;
      }
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      while (totalBytes <= MAX_HOOK_MANIFEST_BYTES) {
        const chunk = Buffer.alloc(
          Math.min(64 * 1024, MAX_HOOK_MANIFEST_BYTES + 1 - totalBytes)
        );
        const { bytesRead } = await handle.read(
          chunk,
          0,
          chunk.length,
          null
        );
        if (bytesRead === 0) {
          return parseInstallManifest(
            Buffer.concat(chunks, totalBytes).toString("utf8")
          ).harness.includes(harness);
        }
        chunks.push(chunk.subarray(0, bytesRead));
        totalBytes += bytesRead;
      }
      return false;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function hookConfigOutcome(
  root: string,
  loadConfig: HookProcessDependencies["loadConfig"]
): Promise<ProjectHookConfigOutcome> {
  if (loadConfig === undefined) {
    return await loadProjectHookConfig(root);
  }
  try {
    return { kind: "loaded", config: await loadConfig(root) };
  } catch {
    return {
      kind: "invalid",
      path: join(root, ".agent-ops", "config.json")
    };
  }
}

async function invalidConfigOutput(options: {
  readonly root: string;
  readonly harness: HarnessId;
  readonly event: HookEvent;
  readonly input: unknown;
  readonly configPath: string;
}): Promise<HookProcessOutput | undefined> {
  const descriptor = harnessDescriptor(options.harness);
  const normalized = normalizeHookInput(options.harness, options.input);
  if (normalized === null) {
    return failOpenOutput(options.harness, options.event);
  }
  if (
    options.event !== "PreToolUse" ||
    normalized.event !== "command" ||
    !(await readInstalledManifestForHarness(options.root, options.harness))
  ) {
    return failOpenOutput(options.harness, options.event);
  }
  const registration = descriptor.control.registrations.find(
    ({ nativeEvent, normalizedEvent }) =>
      nativeEvent === options.event && normalizedEvent === normalized.event
  );
  if (registration === undefined || registration.runtimeFailure === "fail-open") {
    return failOpenOutput(options.harness, options.event);
  }
  if (
    options.harness === "opencode" &&
    registration.runtimeFailure === "fail-closed"
  ) {
    // The generated OpenCode plugin already turns an unavailable runtime into
    // its documented blocking error. Keep that contract in the shim.
    return undefined;
  }
  const remedy = `Fix ${redactSecrets(options.configPath)}, or set AGENT_OPS_DISABLE=1 in your shell to temporarily disable agent-ops.`;
  return descriptor.runtime.formatRuntimeFailure(
    options.event,
    registration.capability,
    remedy
  );
}

function defaultGitRunner(root: string): GitRunner {
  return {
    run: async (args: readonly string[]): Promise<GitRunResult> => {
      try {
        const result = await execFile("git", [...args], {
          cwd: root,
          encoding: "buffer"
        });
        return {
          exitCode: 0,
          stdout: result.stdout as Buffer
        };
      } catch (error) {
        const failure = error as {
          readonly status?: number | null;
          readonly stdout?: Uint8Array;
        };
        return {
          exitCode: failure.status ?? 1,
          stdout: failure.stdout ?? new Uint8Array()
        };
      }
    }
  };
}

function stopVerificationOptions(input: {
  readonly harness: HarnessId;
  readonly rawInput: unknown;
  readonly root: string;
  readonly config: AgentOpsConfig;
  readonly trusted: boolean;
  readonly gitRunner: GitRunner;
  readonly processRunner: VerificationProcessRunner;
}): StopVerificationOptions {
  const nativeRecursion =
    input.harness === "claude" &&
    claudeStopRecursionMarker(input.rawInput);
  const recursionActive =
    nativeRecursion || process.env[STOP_VERIFICATION_ENV] === "1";
  const configHash = calculateConfigHash(input.config);
  return {
    confirmedConfig: true,
    trusted: input.trusted,
    scopeMapped: true,
    recursionMarker: recursionActive,
    configHash,
    verify: async () =>
      await new StopVerificationService({
        root: input.root,
        config: input.config,
        trusted: input.trusted,
        gitRunner: input.gitRunner,
        processRunner: input.processRunner,
        recursionActive,
        configHash
      }).verify()
  };
}

function shouldBuildStopVerification(
  harness: HarnessId,
  event: unknown,
  config: AgentOpsConfig,
  rawInput: unknown
): boolean {
  if (event !== "Stop" || !config.features.stopVerification.enabled) {
    return false;
  }
  let normalized: { readonly event?: string };
  try {
    normalized = harnessDescriptor(harness).runtime.normalizeInput(rawInput);
  } catch {
    return false;
  }
  if (normalized.event !== "stop") {
    return false;
  }
  return harnessDescriptor(harness).control.registrations.some(
    ({ capability, support }) =>
      capability === "optional-stop-verify" && support !== "unsupported"
  );
}

/**
 * Runs one hook invocation. Always resolves to exit code 0: a hook that
 * cannot answer must never block the harness it advises.
 */
export async function runHookProcess(
  argv: readonly string[],
  io: HookProcessIo,
  cliVersion: string,
  dependencies: HookProcessDependencies = {}
): Promise<number> {
  const [harness, event] = argv;
  if (
    harness === undefined ||
    !HARNESSES.has(harness) ||
    event === undefined ||
    !(HOOK_EVENTS as readonly string[]).includes(event)
  ) {
    io.writeStderr(
      `Usage: agent-ops hook <${HARNESS_IDS.join("|")}> <SessionStart|PreToolUse|Stop>\n`
    );
    return 0;
  }
  try {
    const root = dependencies.root ?? process.cwd();
    const harnessId = harness as HarnessId;
    const hookEvent = event as HookEvent;
    if (process.env.AGENT_OPS_DISABLE === "1") {
      writeHookOutput(io, failOpenOutput(harnessId, hookEvent));
      return 0;
    }
    const rawInput = await readStdin(io.stdin);
    const parsedInput = parseInput(rawInput);
    const configOutcome = await hookConfigOutcome(root, dependencies.loadConfig);
    if (configOutcome.kind === "invalid") {
      const output = await invalidConfigOutput({
        root,
        harness: harnessId,
        event: hookEvent,
        input: parsedInput,
        configPath: configOutcome.path
      });
      if (output !== undefined) {
        writeHookOutput(io, output);
      }
      return 0;
    }
    const config = configOutcome.config;
    const trustStatus =
      dependencies.trust === undefined
        ? await repositoryTrust(root, config, cliVersion)
        : await dependencies.trust(root, config, cliVersion);
    const trusted = trustStatus === "TRUSTED";
    const gitRunner = dependencies.gitRunner ?? defaultGitRunner(root);
    const processRunner =
      dependencies.processRunner ?? new NodeVerificationProcessRunner();
    const stopVerification = shouldBuildStopVerification(
      harnessId,
      event,
      config,
      parsedInput
    )
      ? stopVerificationOptions({
          harness: harness as HarnessId,
          rawInput: parsedInput,
          root,
          config,
          trusted,
          gitRunner,
          processRunner
        })
      : undefined;
    const output = await runHookCommand({
      harness: harness as HarnessId,
      event: hookEvent,
      stdin: rawInput,
      config,
      trusted,
      ...(dependencies.advisory === undefined
        ? {}
        : { advisory: dependencies.advisory }),
      ...(stopVerification === undefined ? {} : { stopVerification })
    });
    writeHookOutput(io, output);
  } catch {
    // ponytail: fail-open by design; hook failures stay invisible to the harness.
  }
  return 0;
}
