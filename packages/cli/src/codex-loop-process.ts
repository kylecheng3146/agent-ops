import {
  PROJECT_LOOP_EVENTS,
  resolveProjectLoopRoot,
  runProjectLoop,
  type ProjectLoopEvent,
  type ProjectLoopHarness,
  type ProjectLoopOptions
} from "../../../runtime/src/hooks/codex-loop.js";
import {officeEnabled, officeLoopPhaseHint, type OfficeSessionObservation} from "./office-entry.js";

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
  /** Display-only Office observation; failures never affect loop decisions. */
  readonly office?: (observation: OfficeSessionObservation) => Promise<void>;
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
    const input = parseInput(await readStdin(io.stdin));
    const inputIsObject = typeof input === "object" && input !== null && !Array.isArray(input);
    const managedRoot = inputIsObject
      ? await resolveProjectLoopRoot(input, dependencies.root ?? process.cwd(), harness).catch(() => null)
      : null;
    if (dependencies.office !== undefined && managedRoot !== null && await officeEnabled(managedRoot)) {
      const phase = officeLoopPhaseHint(input, managedRoot);
      void dependencies.office({
        root: managedRoot,
        harness,
        event,
        input,
        validated: true,
        ...(phase === undefined ? {} : {phase})
      }).catch(() => undefined);
    }
    const result = await runProjectLoop({
      harness,
      event,
      input,
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
