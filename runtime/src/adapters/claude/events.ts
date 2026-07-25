export const CLAUDE_SUPPORTED_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "Stop"
] as const;

export type ClaudeSupportedEvent =
  (typeof CLAUDE_SUPPORTED_EVENTS)[number];

export type ClaudeNonInteractiveTrust =
  | "dialog-skipped"
  | "interactive-dialog";

export function claudeNonInteractiveTrust(
  printMode: boolean
): ClaudeNonInteractiveTrust {
  return printMode ? "dialog-skipped" : "interactive-dialog";
}
