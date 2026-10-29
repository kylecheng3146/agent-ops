import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import test from "node:test";

const {installRunnerChecks}: {installRunnerChecks: Record<string, (build: string) => Promise<void>>} =
  await import(pathToFileURL(resolve("tests/install/runner-checks.mjs")).href);

for (const [name, check] of Object.entries(installRunnerChecks)) {
  test(name, () => check(resolve(".tmp/test-dist")));
}
