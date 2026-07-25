import type { FileOperation } from "../../../runtime/src/fs/transaction.js";

function escapeTerminalText(value: string): string {
  return value.replace(
    /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu,
    (character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined) {
        return "\\u{fffd}";
      }
      return codePoint <= 0xff
        ? `\\x${codePoint.toString(16).padStart(2, "0")}`
        : `\\u{${codePoint.toString(16)}}`;
    }
  );
}

export function formatOperationPlan(options: {
  readonly title: string;
  readonly metadata: readonly string[];
  readonly operations: readonly FileOperation[];
}): string {
  const lines = [
    options.title,
    ...options.metadata.map(escapeTerminalText),
    "Operations:"
  ];
  for (const operation of options.operations) {
    lines.push(
      `- ${operation.kind} ${escapeTerminalText(operation.path)}`,
      `  expected: ${operation.expectedHash ?? "<absent>"}`
    );
    if (operation.kind === "write") {
      lines.push(
        "  content:",
        ...operation.content
          .replace(/\n$/u, "")
          .split("\n")
          .map((line) => `    ${escapeTerminalText(line)}`)
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
