import {
  isolateTestEnvironment,
  runTestEntry
} from "./run-tests-lib.mjs";

try {
  await runTestEntry(process.argv.slice(2), {
    environment: isolateTestEnvironment()
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
