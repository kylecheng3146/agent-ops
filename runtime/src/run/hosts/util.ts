import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";

import { AgentOpsError } from "../../fs/paths.js";
import type {
  NativeGoalActionResult,
  NativeGoalEvent,
  NativeGoalHandle,
  NativeGoalHostOptions,
  NativeGoalRequestContext
} from "./types.js";
import type { NativeGoalStatus, NativeHostKind } from "../types.js";
import { asNativePayload } from "./protocol.js";

export function spawnNative(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  options: NativeGoalHostOptions
): ChildProcessWithoutNullStreams {
  const spawn = options.spawn ?? ((name: string, argv: readonly string[], spawnOptions: SpawnOptions) =>
    nodeSpawn(name, [...argv], spawnOptions) as ChildProcessWithoutNullStreams);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...options.env, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  // Native clients can emit diagnostics independently of their structured
  // stdout protocol. Drain stderr so a long-lived writer cannot deadlock on a
  // full pipe; structured lifecycle events remain the source of truth.
  child.stderr.resume();
  return child;
}

export function assertContext(
  handle: NativeGoalHandle,
  context: NativeGoalRequestContext
): void {
  if (
    handle.runId !== context.runId ||
    handle.workerId !== context.workerId ||
    handle.generation !== context.generation ||
    handle.contractHash !== context.contractHash
  ) {
    throw new AgentOpsError(
      "NATIVE_STALE_WRITER",
      "The native action belongs to a stale run worker generation."
    );
  }
}

export function assertProcessRunning(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new AgentOpsError("NATIVE_PROCESS_CLOSED", "The native worker process is already closed.");
  }
}

export function actionResult(
  accepted: boolean,
  nativeStatus: NativeGoalStatus | "unknown",
  payload: unknown
): NativeGoalActionResult {
  return {
    actionId: randomUUID(),
    accepted,
    nativeStatus,
    payload: asNativePayload(payload)
  };
}

export function event(
  handle: NativeGoalHandle,
  type: NativeGoalEvent["type"],
  nativeStatus: NativeGoalStatus | "unknown",
  payload: unknown,
  now: () => Date
): NativeGoalEvent {
  return {
    type,
    host: handle.kind,
    runId: handle.runId,
    workerId: handle.workerId,
    generation: handle.generation,
    contractHash: handle.contractHash,
    at: now().toISOString(),
    nativeStatus,
    payload: asNativePayload(payload),
    proof: false
  };
}

export async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 10_000
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(settle, timeoutMs);
    child.once("exit", settle);
    child.once("error", settle);
  });
}

export function commandParts(
  options: NativeGoalHostOptions,
  fallbackCommand: string,
  fallbackArgs: readonly string[]
): { readonly command: string; readonly args: readonly string[] } {
  return {
    command: options.command ?? fallbackCommand,
    args: options.args ?? fallbackArgs
  };
}
