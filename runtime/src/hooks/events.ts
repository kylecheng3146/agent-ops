import type { Capability } from "../install/types.js";

export type HookStatus = "FAIL" | "PASS" | "UNKNOWN";
export type HookAction = "block" | "continue";

interface HookEventBase {
  readonly projectRoot: string;
  readonly sessionId?: string;
}

export interface SessionStartHookEvent extends HookEventBase {
  readonly event: "session-start";
}

export interface CommandHookEvent extends HookEventBase {
  readonly event: "command";
  readonly command: string;
  readonly args: readonly string[];
  readonly scope: string;
}

export interface HookCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface CommandBatchHookEvent extends HookEventBase {
  readonly event: "command-batch";
  readonly commands: readonly HookCommand[];
  readonly scope: string;
}

export interface ContentHookEvent extends HookEventBase {
  readonly event: "content";
  readonly content: string;
  readonly scope: string;
}

export interface StopHookEvent extends HookEventBase {
  readonly event: "stop";
  readonly terminationReason?: string;
  readonly fullyIdle?: boolean;
}

export interface UnsupportedHookEvent extends HookEventBase {
  readonly event: "unsupported";
}

export type NormalizedHookEvent =
  | CommandBatchHookEvent
  | CommandHookEvent
  | ContentHookEvent
  | SessionStartHookEvent
  | StopHookEvent
  | UnsupportedHookEvent;

export interface HookCommandEvidence {
  readonly commandId: string;
  readonly exitCode: number | null;
  readonly testCount: number | null;
}

export interface HookVerificationEvidence {
  readonly commandResults: readonly HookCommandEvidence[];
  readonly configHash: string;
  readonly timestamp: string;
}

export interface HookResult {
  readonly action: HookAction;
  readonly status: HookStatus;
  readonly code: string;
  readonly evidence?: HookVerificationEvidence;
  /** Human recovery guidance for an intentional denial. */
  readonly remedy?: string;
}

export interface HookDispatchOptions {
  readonly capabilities: readonly Capability[];
  readonly trusted: boolean;
  readonly advisory?: (event: SessionStartHookEvent) => Promise<void>;
  readonly stopVerification?: StopVerificationOptions;
  readonly completionGate?: CompletionGateOptions;
}

export interface CompletionGateOptions {
  readonly handle: (
    event: NormalizedHookEvent
  ) => Promise<HookResult | null>;
}

export interface StopVerifierReport {
  readonly status: HookStatus;
  readonly results: readonly HookCommandEvidence[];
}

export interface StopVerificationOptions {
  readonly confirmedConfig: boolean;
  readonly trusted: boolean;
  readonly scopeMapped: boolean;
  readonly recursionMarker: boolean;
  readonly configHash: string;
  readonly now?: () => string;
  readonly verify: () => Promise<StopVerifierReport>;
}
