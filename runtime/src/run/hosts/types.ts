import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";

import type { NativeHostKind, NativeGoalStatus } from "../types.js";

export type NativeJson =
  | null
  | boolean
  | number
  | string
  | NativeJson[]
  | { [key: string]: NativeJson };

export interface NativeGoalRequestContext {
  readonly runId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly contractHash: string;
}

export interface NativeGoalStartInput extends NativeGoalRequestContext {
  readonly cwd: string;
  readonly objective?: string;
  readonly tokenBudget?: number | null;
  readonly sessionId?: string;
  readonly nativeVersion?: string | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

export interface NativeGoalUpdate extends NativeGoalRequestContext {
  readonly objective: string;
  readonly tokenBudget?: number | null;
}

export interface NativeGoalHandle extends NativeGoalRequestContext {
  readonly kind: NativeHostKind;
  readonly sessionId: string;
  readonly threadId: string | null;
  readonly nativeVersion: string | null;
  readonly cwd: string;
  readonly processId: number | null;
  readonly startedAt: string;
  readonly process: ChildProcessWithoutNullStreams;
  readonly goalStatus: NativeGoalStatus | "unknown";
}

export type NativeGoalEventType =
  | "ready"
  | "message"
  | "goal-updated"
  | "usage"
  | "completed"
  | "error"
  | "closed";

export interface NativeGoalEvent {
  readonly transportMethod?: string;
  readonly type: NativeGoalEventType;
  readonly host: NativeHostKind;
  readonly runId: string;
  readonly workerId: string;
  readonly generation: number;
  readonly contractHash: string;
  readonly at: string;
  readonly nativeStatus: NativeGoalStatus | "unknown";
  readonly payload: NativeJson;
  /** This event is observational and cannot satisfy an agent-ops criterion. */
  readonly proof: false;
}

export interface NativeGoalActionResult {
  readonly actionId: string;
  readonly accepted: boolean;
  readonly nativeStatus: NativeGoalStatus | "unknown";
  readonly payload: NativeJson;
}

export interface NativeGoalHost {
  readonly kind: NativeHostKind;
  start(input: NativeGoalStartInput): Promise<NativeGoalHandle>;
  activate(
    handle: NativeGoalHandle,
    objective: string,
    context: NativeGoalRequestContext,
    tokenBudget?: number | null
  ): Promise<NativeGoalActionResult>;
  update(
    handle: NativeGoalHandle,
    update: NativeGoalUpdate
  ): Promise<NativeGoalActionResult>;
  observe(
    handle: NativeGoalHandle,
    options?: { readonly signal?: AbortSignal }
  ): AsyncIterable<NativeGoalEvent>;
  interrupt(
    handle: NativeGoalHandle,
    context: NativeGoalRequestContext
  ): Promise<NativeGoalActionResult>;
  stop(
    handle: NativeGoalHandle,
    context: NativeGoalRequestContext,
    signal?: NodeJS.Signals
  ): Promise<NativeGoalActionResult>;
  resume(
    input: NativeGoalStartInput,
    sessionId: string,
    objective?: string
  ): Promise<NativeGoalHandle>;
}

export interface NativeGoalHostOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions
  ) => ChildProcessWithoutNullStreams;
  readonly now?: () => Date;
  readonly requestTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly nativeVersion?: string | null;
}
