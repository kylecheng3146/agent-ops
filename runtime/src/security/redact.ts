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
    "(?:Basic|Bearer)\\s+[^\\r\\n]+"
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
const KEY_VALUE = new RegExp(
  [
    "(\\b(?:access[_-]?token|api[_-]?key|client[_-]?secret|",
    "password|token)\\b[ \\t]*[:=][ \\t]*)",
    "([^\\s\"'&;]+)"
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
    .replace(KEY_VALUE, "$1[REDACTED_VALUE]");
}
