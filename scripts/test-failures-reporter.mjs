import {inspect} from "node:util";

// Keep failing-test identity off the verbose TAP stream, whose tail is bounded.
export default async function* failures(events) {
  for await (const {type, data} of events) {
    if (type !== "test:fail") continue;
    const error = data.details?.error;
    yield `${data.name} (${data.file}:${data.line}:${data.column})\n${inspect(error?.cause ?? error, {colors: false, depth: 4})}\n`;
  }
}
