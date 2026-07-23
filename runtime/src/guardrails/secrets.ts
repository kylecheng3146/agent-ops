import {
  GUARDRAIL_RULE_IDS,
  type GuardrailDecision
} from "./types.js";

const PRIVATE_KEY_BLOCK =
  /-----BEGIN (PGP PRIVATE KEY BLOCK|(?:[A-Z0-9]+ )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/g;
const KNOWN_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g;
const SENSITIVE_ASSIGNMENT =
  /\b(?:[a-z0-9]+[_-])*(?:access[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|password|token)\b["']?\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'&;,}]+))/gi;
const AUTHORIZATION_VALUE =
  /\bAuthorization\s*:\s*(?:Bearer|Basic|token)\s+([^\s,;]+)/gi;
const PLACEHOLDER =
  /(?:\[(?:REDACTED|REMOVED)[^\]]*\]|<[^>]*(?:example|placeholder|redacted|replace|your)[^>]*>|(?:change-?me|example|placeholder|redacted|replace-?me|sample)|x{6,})/i;

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value);
}

function hasHighEntropy(value: string): boolean {
  if (value.length < 24 || value.length > 4_096 || /\s/.test(value)) {
    return false;
  }
  const categories = [
    /[a-z]/.test(value),
    /[A-Z]/.test(value),
    /\d/.test(value),
    /[^A-Za-z0-9]/.test(value)
  ].filter(Boolean).length;
  return categories >= 3 && new Set(value).size >= 10;
}

function blocksPrivateKey(content: string): boolean {
  for (const match of content.matchAll(PRIVATE_KEY_BLOCK)) {
    const body = match[2]?.trim() ?? "";
    if (!isPlaceholder(body)) {
      return true;
    }
  }
  return false;
}

function blocksKnownToken(content: string): boolean {
  for (const match of content.matchAll(KNOWN_TOKEN)) {
    const token = match[0];
    if (!isPlaceholder(token)) {
      return true;
    }
  }
  return false;
}

function blocksSensitiveValue(content: string): boolean {
  for (const match of content.matchAll(SENSITIVE_ASSIGNMENT)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (!isPlaceholder(value) && hasHighEntropy(value)) {
      return true;
    }
  }
  for (const match of content.matchAll(AUTHORIZATION_VALUE)) {
    const value = match[1] ?? "";
    if (!isPlaceholder(value) && hasHighEntropy(value)) {
      return true;
    }
  }
  return false;
}

export function evaluateSecretContent(content: string): GuardrailDecision {
  if (blocksPrivateKey(content)) {
    return {
      action: "block",
      ruleId: GUARDRAIL_RULE_IDS.privateKey,
      reason: "Private-key material must not be persisted or transmitted."
    };
  }
  if (blocksKnownToken(content) || blocksSensitiveValue(content)) {
    return {
      action: "block",
      ruleId: GUARDRAIL_RULE_IDS.credential,
      reason: "Credential-shaped material must be replaced with a redacted value."
    };
  }
  return { action: "allow" };
}
