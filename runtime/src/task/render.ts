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
    ...(record.task.parentTaskId === undefined
      ? []
      : [`Parent task: ${record.task.parentTaskId}`]),
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

/**
 * The compact form a recovery entry point injects. It carries what the next
 * step needs — which task, what is still unproven — and points at evidence
 * rather than quoting it: one real task's evidence runs to thousands of
 * characters, far past any context budget, and evidence describes work already
 * proven rather than work still to do.
 */
/** Ceilings for the elastic fields; the rest of the checkpoint is required. */
const MAX_CHECKPOINT_TITLE = 120;
const MAX_CHECKPOINT_DESCRIPTION = 160;
const MIN_CHECKPOINT_TITLE = 16;
const MIN_CHECKPOINT_DESCRIPTION = 24;
export const DEFAULT_CHECKPOINT_BUDGET = 700;

function shorten(value: string, limit: number): string {
  const text = safeTaskText(value);
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}\u2026`;
}

/**
 * The compact form a recovery entry point injects. It carries what the next
 * step needs — which task, what is still unproven — and points at evidence
 * rather than quoting it: one real task's evidence runs to thousands of
 * characters, far past any context budget, and evidence describes work
 * already proven rather than work still to do.
 *
 * Everything that identifies the work is required and is never dropped: the
 * task line, the counts, every unsatisfied criterion id, and the evidence
 * line. Only the title and the descriptions flex, in that order, so a task at
 * the maximum of five long criteria cannot push the evidence pointer or a
 * criterion out of the budget.
 */
export function renderTaskCheckpoint(
  record: StoredTaskRecord,
  budget: number = DEFAULT_CHECKPOINT_BUDGET,
  /**
   * Applied to whole task text before anything is shortened. Truncating
   * first would cut a credential down to a prefix the detector no longer
   * recognizes, so the check has to see the original string; returning
   * undefined drops that field.
   */
  sanitize: (value: string) => string | undefined = (value) => value
): string {
  const unsatisfied = record.task.criteria.filter(
    (criterion) => (record.evidence[criterion.id] ?? []).length === 0
  );
  const satisfied = record.task.criteria.length - unsatisfied.length;
  const references = Object.values(record.evidence).reduce(
    (total, list) => total + list.length,
    0
  );
  const head = `Task ${record.task.id} (${record.status}): `;
  const counts = `Criteria satisfied: ${satisfied}/${record.task.criteria.length}.`;
  const closing = unsatisfied.length === 0
    ? "All criteria carry evidence; verify and review before completing."
    : "Still unproven:";
  // Always stated, including zero: "no evidence yet" is the most important
  // thing a recovered session can know about a task it is about to continue.
  const evidence = `Evidence: ${references} reference(s) under ` +
    `.agent-ops/tasks/evidence/${record.task.id}/; read them with ` +
    `\`agent-ops task status --task ${record.task.id}\`.`;
  // Ids are required content, so a credential-shaped one is redacted in place
  // rather than dropped: losing the id would hide the unproven work itself.
  const stems = unsatisfied.map(
    (criterion) => `- ${sanitize(criterion.id) ?? "(identifier withheld)"}:`
  );
  const required = [head, counts, closing, ...stems, evidence]
    .reduce((total, line) => total + line.length + 1, 0);

  // Descriptions are allocated before the title, and the budget stretches
  // when required content alone fills it: five ids at the schema's maximum
  // length otherwise leave nothing, and an id without its description does
  // not say what is still unproven.
  const descriptionFloor = stems.length * (MIN_CHECKPOINT_DESCRIPTION + 1);
  const remaining = Math.max(
    descriptionFloor,
    Math.max(0, budget - required)
  );
  const descriptionRoom = remaining - MIN_CHECKPOINT_TITLE >= descriptionFloor
    ? remaining - MIN_CHECKPOINT_TITLE
    : remaining;
  const perDescription = stems.length === 0
    ? 0
    : Math.min(
        MAX_CHECKPOINT_DESCRIPTION,
        Math.floor(descriptionRoom / stems.length) - 1
      );

  const body: string[] = [];
  for (const [index, criterion] of unsatisfied.entries()) {
    const description = sanitize(criterion.description);
    body.push(
      description !== undefined && perDescription >= MIN_CHECKPOINT_DESCRIPTION
        ? `${stems[index]} ${shorten(description, perDescription)}`
        : stems[index] ?? ""
    );
  }
  const spent = body.reduce(
    (total, line, index) => total + line.length - (stems[index]?.length ?? 0),
    0
  );
  const safeTitle = sanitize(record.task.title);
  const titleRoom = Math.min(MAX_CHECKPOINT_TITLE, remaining - spent);
  const title = safeTitle !== undefined && titleRoom >= MIN_CHECKPOINT_TITLE
    ? shorten(safeTitle, titleRoom)
    : "";
  return [
    `${head}${title}`.trimEnd(),
    counts,
    closing,
    ...body,
    evidence
  ].join("\n");
}
