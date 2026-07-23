const PRIVATE_KEY_LABEL = "(?:[A-Z0-9]+ )?PRIVATE KEY";
const PRIVATE_KEY_BLOCK = new RegExp(
  [
    "-----BEGIN ",
    `(${PRIVATE_KEY_LABEL})`,
    "-----[\\s\\S]*?-----END \\1-----"
  ].join(""),
  "g"
);
const AUTHORIZATION_HEADER = new RegExp(
  [
    "(",
    "Authorization",
    "[ \\t]*:[ \\t]*)",
    "[^\\r\\n]+"
  ].join(""),
  "gi"
);
const KNOWN_TOKEN = new RegExp(
  [
    "\\b(?:",
    "gh[pousr]_[A-Za-z0-9]{20,}",
    "|github_pat_[A-Za-z0-9_]{20,}",
    "|sk-[A-Za-z0-9_-]{20,}",
    ")\\b"
  ].join(""),
  "g"
);
const SENSITIVE_KEY = [
  "(?:access[_-]?token|api[_-]?key|client[_-]?secret|",
  "password|token)"
].join("");
const QUOTED_KEY_VALUE = new RegExp(
  [
    `(\\b${SENSITIVE_KEY}\\b["']?[ \\t]*[:=][ \\t]*)`,
    "([\"'])",
    "(?:\\\\.|(?!\\2)[^\\r\\n\\\\])*",
    "\\2"
  ].join(""),
  "gi"
);
const UNQUOTED_KEY_VALUE = new RegExp(
  [
    `(\\b${SENSITIVE_KEY}\\b[ \\t]*[:=][ \\t]*)`,
    "([^\\s\"'&;,}]+)"
  ].join(""),
  "gi"
);

export function redactSecrets(value: string): string {
  return value
    .replace(
      PRIVATE_KEY_BLOCK,
      "-----BEGIN $1-----\n[REDACTED_PRIVATE_KEY]\n-----END $1-----"
    )
    .replace(AUTHORIZATION_HEADER, "$1[REDACTED_AUTHORIZATION]")
    .replace(KNOWN_TOKEN, "[REDACTED_TOKEN]")
    .replace(QUOTED_KEY_VALUE, "$1$2[REDACTED_VALUE]$2")
    .replace(UNQUOTED_KEY_VALUE, "$1[REDACTED_VALUE]");
}
