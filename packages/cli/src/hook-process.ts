import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { AgentOpsConfig } from "../../../runtime/src/contracts.js";
import { calculateConfigHash } from "../../../runtime/src/config/hash.js";
import { claudeStopRecursionMarker } from "../../../runtime/src/adapters/claude/input.js";
import {
  HARNESS_IDS,
  harnessDescriptor,
  type HarnessId
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
  runHookCommand,
  HOOK_EVENTS,
  type HookEvent
} from "./commands/hook.js";
import { loadEffectiveConfig, repositoryTrust } from "./context.js";

const HARNESSES = new Set<string>(HARNESS_IDS);
const MAX_HOOK_INPUT_BYTES = 1024 * 1024;
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
    const config =
      dependencies.loadConfig === undefined
        ? (await loadEffectiveConfig(root, "project")).config
        : await dependencies.loadConfig(root);
    const trustStatus =
      dependencies.trust === undefined
        ? await repositoryTrust(root, config, cliVersion)
        : await dependencies.trust(root, config, cliVersion);
    const rawInput = await readStdin(io.stdin);
    const parsedInput = parseInput(rawInput);
    const trusted = trustStatus === "TRUSTED";
    const gitRunner = dependencies.gitRunner ?? defaultGitRunner(root);
    const processRunner =
      dependencies.processRunner ?? new NodeVerificationProcessRunner();
    const stopVerification = shouldBuildStopVerification(
      harness as HarnessId,
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
      event: event as HookEvent,
      stdin: rawInput,
      config,
      trusted,
      ...(dependencies.advisory === undefined
        ? {}
        : { advisory: dependencies.advisory }),
      ...(stopVerification === undefined ? {} : { stopVerification })
    });
    if (output.stdout.length > 0) {
      io.writeStdout(output.stdout);
    }
    if (output.stderr.length > 0) {
      io.writeStderr(output.stderr);
    }
  } catch {
    // ponytail: fail-open by design; hook failures stay invisible to the harness.
  }
  return 0;
}
