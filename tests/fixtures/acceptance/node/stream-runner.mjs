import { run } from "node:test";
import { pathToFileURL } from "node:url";

const reporter = (await import(pathToFileURL(process.argv[2]).href)).default;
const file = new URL("./stream-probe.test.mjs", import.meta.url).pathname;
for await (const chunk of reporter(run({ files: [file], concurrency: true }))) {
  process.stdout.write(chunk);
}
