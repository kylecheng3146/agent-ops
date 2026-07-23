import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { redactSecrets } from "../security/redact.js";

export type FailureApproachSignal =
  | "CHANGE_APPROACH_REQUIRED"
  | null;

export interface FailureFingerprintInput {
  readonly commandId: string;
  readonly failureClass: string;
  readonly exitCategory: string;
  readonly diagnostics: string;
}

export interface FailureFingerprint {
  readonly value: string;
  readonly commandId: string;
  readonly failureClass: string;
  readonly exitCategory: string;
  readonly diagnostics: string;
}

export interface FailureFingerprintState extends FailureFingerprint {
  readonly consecutive: number;
  readonly recordedAt: string;
}

export interface FailureFingerprintAdvance {
  readonly state: FailureFingerprintState;
  readonly signal: FailureApproachSignal;
}

const COMPONENT_PATTERN = /^[a-z][a-z0-9-]{0,127}$/u;
const MAX_DIAGNOSTIC_BYTES = 512;

function boundedUtf8(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    output += character;
    bytes += characterBytes;
  }
  return output;
}

function normalizedDiagnostic(value: string): string {
  const redacted = redactSecrets(value)
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/[ \t]+/gu, " "))
    .filter((line) => line.length > 0)
    .join("\n");
  return boundedUtf8(redacted, MAX_DIAGNOSTIC_BYTES);
}

function assertComponent(name: string, value: string): void {
  if (!COMPONENT_PATTERN.test(value)) {
    throw new AgentOpsError(
      "FINGERPRINT_INVALID",
      `Failure fingerprint ${name} is invalid.`
    );
  }
}

export function createFailureFingerprint(
  input: FailureFingerprintInput
): FailureFingerprint {
  assertComponent("commandId", input.commandId);
  assertComponent("failureClass", input.failureClass);
  assertComponent("exitCategory", input.exitCategory);
  const diagnostics = normalizedDiagnostic(input.diagnostics);
  const components = {
    commandId: input.commandId,
    failureClass: input.failureClass,
    exitCategory: input.exitCategory,
    diagnostics
  };
  return {
    value: sha256(JSON.stringify(components)),
    ...components
  };
}

export function advanceFailureFingerprint(
  previous: FailureFingerprintState | null,
  current: FailureFingerprint,
  recordedAt: string
): FailureFingerprintAdvance {
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new AgentOpsError(
      "FINGERPRINT_TIMESTAMP_INVALID",
      "Failure fingerprint timestamp must be ISO-compatible."
    );
  }
  const consecutive =
    previous?.value === current.value
      ? previous.consecutive + 1
      : 1;
  if (!Number.isSafeInteger(consecutive) || consecutive <= 0) {
    throw new AgentOpsError(
      "FINGERPRINT_COUNT_INVALID",
      "Failure fingerprint repetition count is invalid."
    );
  }
  return {
    state: {
      ...current,
      consecutive,
      recordedAt
    },
    signal:
      consecutive >= 2 ? "CHANGE_APPROACH_REQUIRED" : null
  };
}
