import type { ReviewTargetId } from "../contracts.js";

/**
 * The key holding the model's answer differs in every envelope, so every
 * target gets its own branch. Verified against tests/fixtures/review/.
 */
const ENVELOPE_KEYS: Readonly<Partial<Record<ReviewTargetId, string>>> = {
  agy: "response",
  claude: "result"
};

function parseObject(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Agy appends plan UI metadata even when native JSON Schema is enabled. */
function withoutAgyPlanMetadata(
  value: Record<string, unknown>
): Record<string, unknown> {
  const { toolAction: _toolAction, toolSummary: _toolSummary, ...report } = value;
  return report;
}

/**
 * The model's answer as text, before any JSON contract is applied. Returns
 * undefined rather than throwing so the caller can report
 * `unparseable-output` for every transport failure through one path.
 */
export function extractFinalMessage(
  target: ReviewTargetId,
  stdout: string
): string | undefined {
  const key = ENVELOPE_KEYS[target];
  if (key === undefined) {
    // codex: stdout is the final message itself.
    const trimmed = stdout.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  const envelope = parseObject(stdout);
  const value = envelope?.[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The last balanced JSON object in a block of model text. Scanning backwards
 * matters: models often restate the schema before answering, and the answer is
 * what comes last. This only ever runs on the extracted final message, never on
 * raw stdout, so it cannot capture a transport envelope.
 */
export function extractJsonObject(
  text: string
): Record<string, unknown> | undefined {
  return parseObject(text.trim());
}

/**
 * Review results use a strict native structured-output transport. Unlike the
 * legacy probe parser above, this path neither recovers fenced JSON nor accepts
 * a provider's generic text result field.
 */
export function extractReviewObject(
  target: ReviewTargetId,
  stdout: string
): Record<string, unknown> | undefined {
  if (target === "codex") {
    return extractJsonObject(stdout);
  }
  const envelope = parseObject(stdout);
  const key = target === "claude" ? "structured_output" : "response";
  const value = envelope?.[key];
  if (isRecord(value)) {
    return target === "agy" ? withoutAgyPlanMetadata(value) : value;
  }
  const parsed = typeof value === "string" ? extractJsonObject(value) : undefined;
  return parsed === undefined || target !== "agy"
    ? parsed
    : withoutAgyPlanMetadata(parsed);
}
