export const CODEX_SUPPORTED_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "Stop"
] as const;

export type CodexSupportedEvent =
  (typeof CODEX_SUPPORTED_EVENTS)[number];

export type CodexMatcherSupport = "tool-name" | "unsupported";

export function codexMatcherSupport(
  event: string
): CodexMatcherSupport {
  return event === "PreToolUse" ? "tool-name" : "unsupported";
}
