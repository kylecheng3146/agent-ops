import test from "node:test";
import {fileURLToPath, pathToFileURL} from "node:url";
import {resolve} from "node:path";
process.env.AGENT_OPS_DEBUG_TEST_BUILD = fileURLToPath(new URL("../../", import.meta.url));
const {automationChecks} = await import(pathToFileURL(resolve("tests/learning/pipeline-checks.mjs")).href);
for (const [id, check] of Object.entries(automationChecks)) test(id, async () => {await (check as () => Promise<void>)();});
