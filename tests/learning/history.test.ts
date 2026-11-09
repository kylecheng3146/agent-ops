import test from "node:test";
import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";

process.env.AGENT_OPS_DEBUG_TEST_BUILD = fileURLToPath(new URL("../../", import.meta.url));
const {adviceChecks} = await import(pathToFileURL(resolve("tests/learning/advice-checks.mjs")).href);
for (const id of ["learning-advisory-proposals", "learning-history-snapshots"]) {
  test(id, async () => {await adviceChecks[id]();});
}
