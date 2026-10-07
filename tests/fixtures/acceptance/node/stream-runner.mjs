import { run } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const reporter = (await import(pathToFileURL(process.argv[2]).href)).default;
const file = fileURLToPath(new URL("./stream-probe.test.mjs", import.meta.url));
for await (const chunk of reporter(run({ files: [file], concurrency: true }))) {
  process.stdout.write(chunk);
}
