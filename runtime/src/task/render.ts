import type { StoredTaskRecord } from "./store.js";

export function safeTaskText(value: string): string {
  return value.replace(
    /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu,
    (character) => {
      if (character === "\n") {
        return " ";
      }
      const codePoint = character.codePointAt(0);
      return codePoint === undefined
        ? "\\u{fffd}"
        : `\\u{${codePoint.toString(16)}}`;
    }
  );
}

export function renderTaskMarkdown(record: StoredTaskRecord): string {
  const lines = [
    `# ${safeTaskText(record.task.title)}`,
    "",
    `Task ID: ${record.task.id}`,
    `Status: ${record.status}`,
    `Created: ${record.createdAt}`,
    `Updated: ${record.updatedAt}`,
    ...(record.completedAt === null
      ? []
      : [`Completed: ${record.completedAt}`]),
    ...(record.archivedAt === null
      ? []
      : [`Archived: ${record.archivedAt}`]),
    "",
    "## Acceptance criteria",
    ""
  ];
  for (const criterion of record.task.criteria) {
    const references = record.evidence[criterion.id] ?? [];
    lines.push(
      `- ${references.length > 0 ? "[x]" : "[ ]"} ${safeTaskText(
        criterion.description
      )} (\`${criterion.id}\`)`,
      `  - Verifiers: ${criterion.verifierIds
        .map((id) => `\`${id}\``)
        .join(", ")}`
    );
    if (references.length === 0) {
      lines.push("  - Evidence: none");
    } else {
      lines.push(
        "  - Evidence:",
        ...references.map(
          (reference) => `    - ${safeTaskText(reference)}`
        )
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
