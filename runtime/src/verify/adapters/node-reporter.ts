/** JSONL reporter for node --test; preserves assertion Error metadata. */
function errorData(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (value instanceof Error) return {name: value.name,
    code: (value as NodeJS.ErrnoException).code,
    cause: errorData(value.cause, seen)};
  if (Array.isArray(value)) return value.map(item => errorData(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, errorData(item, seen)]));
}

export default async function* nodeAcceptanceReporter(events: AsyncIterable<unknown>): AsyncGenerator<string> {
  for await (const event of events) yield JSON.stringify(errorData(event)) + "\n";
}
