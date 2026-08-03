import {
  PROJECT_LOOP_EVENTS,
  runProjectLoop,
  type ProjectLoopEvent,
  type ProjectLoopHarness,
  type ProjectLoopOptions
} from "../../../runtime/src/hooks/codex-loop.js";

const MAX_LOOP_INPUT_BYTES = 64 * 1024;

export interface LoopProcessIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
}

export interface LoopProcessDependencies {
  readonly root?: string;
  readonly now?: ProjectLoopOptions["now"];
  readonly gitStatus?: ProjectLoopOptions["gitStatus"];
  readonly telemetryMaxBytes?: number;
}

function isLoopHarness(value: string | undefined): value is ProjectLoopHarness {
  return value === "claude" || value === "codex";
}

function isLoopEvent(value: string | undefined): value is ProjectLoopEvent {
  return (
    value !== undefined &&
    (PROJECT_LOOP_EVENTS as readonly string[]).includes(value)
  );
}

async function readStdin(stream: NodeJS.ReadableStream): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), "utf8");
    total += buffer.byteLength;
    if (total > MAX_LOOP_INPUT_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function parseInput(source: string | null): unknown {
  if (source === null) {
    return null;
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return null;
  }
}

/**
 * Process boundary for the generated Bash launchers. Invalid input stays
 * fail-open; the runtime owns every policy decision and output shape.
 */
export async function runLoopProcess(
  argv: readonly string[],
  io: LoopProcessIo,
  dependencies: LoopProcessDependencies = {}
): Promise<0 | 2> {
  const [harness, event] = argv;
  if (!isLoopHarness(harness) || !isLoopEvent(event)) {
    return 0;
  }
  try {
    const result = await runProjectLoop({
      harness,
      event,
      input: parseInput(await readStdin(io.stdin)),
      root: dependencies.root ?? process.cwd(),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
      ...(dependencies.gitStatus === undefined
        ? {}
        : { gitStatus: dependencies.gitStatus }),
      ...(dependencies.telemetryMaxBytes === undefined
        ? {}
        : { telemetryMaxBytes: dependencies.telemetryMaxBytes })
    });
    if (result.stdout.length > 0) {
      io.writeStdout(result.stdout);
    }
    if (result.stderr.length > 0) {
      io.writeStderr(result.stderr);
    }
    return result.exitCode;
  } catch {
    return 0;
  }
}
