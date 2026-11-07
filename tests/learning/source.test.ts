import test from "node:test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";

test("learning collection requires real sealed delivery, preserves ordinary origins and leaves source proof current", async () => {
  await promisify(execFile)(process.execPath, ["tests/learning/source-check.mjs"], {
    cwd: process.cwd(), env: {...process.env, AGENT_OPS_DEBUG_TEST_BUILD: resolve(".tmp/test-dist")},
    timeout: 60_000, maxBuffer: 1024 * 1024
  });
});
