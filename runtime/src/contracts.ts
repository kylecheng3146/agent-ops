export type JsonPrimitive = boolean | null | number | string;

export type JsonValue = JsonObject | JsonPrimitive | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export const CONFIG_SCHEMA_VERSION = 2 as const;
export const TASK_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_SCHEMA_VERSION = 1 as const;

/** @deprecated Use the document-specific schema version constants. */
export const SCHEMA_VERSION = CONFIG_SCHEMA_VERSION;

export type Profile = "advisory" | "core" | "guardrails" | "loop";

export type EvidenceKind = "exit-code" | "file" | "test-count";

export interface EvidenceRequirement {
  kind: EvidenceKind;
  minimum?: number;
}

export interface VerifierCommand {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  required: boolean;
  shell?: false;
  timeoutMs?: number;
  evidence: EvidenceRequirement;
}

export interface ShellVerifierCommand {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  required: boolean;
  shell: true;
  acknowledgeRisk: true;
  timeoutMs?: number;
  evidence: EvidenceRequirement;
}

export type VerificationCommand = ShellVerifierCommand | VerifierCommand;

export interface VerificationConfig {
  commands: VerificationCommand[];
}

export interface PathMapping {
  path: string;
  verifierIds: string[];
}

export interface SecurityException {
  ruleId: string;
  scope: string;
  expiresAt: string;
  reason: string;
}

export interface AgentOpsFeatures {
  stopVerification: {
    enabled: boolean;
  };
}

export interface AgentOpsConfig {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  profiles: Profile[];
  verification: VerificationConfig;
  features: AgentOpsFeatures;
  pathMappings: PathMapping[];
  securityExceptions: SecurityException[];
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  verifierIds: string[];
}

export interface AgentTask {
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  id: string;
  title: string;
  criteria: AcceptanceCriterion[];
}

export interface VerificationEvidence {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  taskId: string;
  criterionId: string;
  commandId: string;
  argv: string[];
  cwd: string;
  scope: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  testCount: number | null;
  toolVersions: Record<string, string>;
  configHash: string;
}

export type InstallScope = "project" | "user";

export type HarnessId = "claude" | "codex" | "opencode";

/**
 * A selection of harnesses, never empty. Releases up to 0.1.4 stored a single
 * string with `"both"` standing in for two harnesses; that shape is migrated on
 * read.
 */
export type Harness = HarnessId[];

/**
 * The manifest versions independently of config, tasks, and evidence: only its
 * own shape changed when the harness selection became a list.
 */
export const MANIFEST_SCHEMA_VERSION = 2 as const;

export interface ManagedPathRecord {
  id: string;
  path: string;
  hash: string;
  owner: "agent-ops";
}

export interface ManagedMarkerRecord extends ManagedPathRecord {
  startMarker: string;
  endMarker: string;
}

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PreCompact"
  | "PostCompact"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop";

/**
 * Hook handlers live inside a settings file the harness owns, so the record
 * tracks which events agent-ops registered rather than a whole-file hash.
 */
export interface ManagedHookRecord {
  id: string;
  path: string;
  harness: HarnessId;
  events: HookEventName[];
  owner: "agent-ops";
}

export interface InstallManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  scope: InstallScope;
  harness: Harness;
  artifacts: ManagedPathRecord[];
  markers: ManagedMarkerRecord[];
  hooks?: ManagedHookRecord[];
}

export interface ValidationError {
  code: string;
  path: string;
  message: string;
}

export interface ValidationSuccess<T> {
  ok: true;
  value: T;
  errors: [];
}

export interface ValidationFailure {
  ok: false;
  errors: ValidationError[];
}

export type ValidationResult<T> = ValidationFailure | ValidationSuccess<T>;
