import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { withPrivateFileLock } from "../../runtime/src/security/permissions.js";

// Node 26 turns a FileHandle closed by garbage collection into an uncaught
// error; Node 22 reports the same event as DEP0137.
test("a private-state heartbeat handle survives mocked timers being reset", async (t) => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const root = await mkdtemp(join(tmpdir(), "agent-ops-heartbeat-"));
  const warnings: string[] = [];
  const onWarning = (warning: Error & { code?: string }) => { warnings.push(warning.code ?? warning.message); };
  process.on("warning", onWarning);
  try {
    t.mock.timers.enable({ apis: ["setInterval"] });
    await withPrivateFileLock(join(root, "state", "record.json"), root, async () => undefined);
    t.mock.timers.reset();
    for (let round = 0; round < 5; round++) {
      gc();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(warnings.filter((code) => code === "DEP0137"), []);
  } finally {
    process.off("warning", onWarning);
    await rm(root, { recursive: true, force: true });
  }
});
