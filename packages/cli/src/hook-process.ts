import {
  HARNESS_IDS,
  type HarnessId
} from "../../../runtime/src/install/harness.js";
import {
  runHookCommand,
  HOOK_EVENTS,
  type HookEvent
} from "./commands/hook.js";
import { loadEffectiveConfig, repositoryTrust } from "./context.js";

const HARNESSES = new Set<string>(HARNESS_IDS);
const MAX_HOOK_INPUT_BYTES = 1024 * 1024;

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

/**
 * Runs one hook invocation. Always resolves to exit code 0: a hook that
 * cannot answer must never block the harness it advises.
 */
export async function runHookProcess(
  argv: readonly string[],
  io: HookProcessIo,
  cliVersion: string
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
    const root = process.cwd();
    const config = (await loadEffectiveConfig(root, "project")).config;
    const output = await runHookCommand({
      harness: harness as HarnessId,
      event: event as HookEvent,
      stdin: await readStdin(io.stdin),
      config,
      trusted:
        (await repositoryTrust(root, config, cliVersion)) === "TRUSTED"
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
