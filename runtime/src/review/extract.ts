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
  for (let end = text.lastIndexOf("}"); end !== -1;
    end = text.lastIndexOf("}", end - 1)) {
    let depth = 0;
    for (let start = end; start >= 0; start -= 1) {
      const character = text[start];
      if (character === "}") {
        depth += 1;
        continue;
      }
      if (character !== "{") {
        continue;
      }
      depth -= 1;
      if (depth !== 0) {
        continue;
      }
      const candidate = parseObject(text.slice(start, end + 1));
      if (candidate !== undefined) {
        return candidate;
      }
      break;
    }
  }
  return undefined;
}
