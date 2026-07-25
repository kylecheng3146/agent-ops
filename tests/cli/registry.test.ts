import assert from "node:assert/strict";
import test from "node:test";

import { COMMAND_NAMES } from "../../packages/cli/src/args.js";
import { createCommandRegistry } from "../../packages/cli/src/commands/index.js";
import { okEnvelope } from "../../packages/cli/src/output.js";

test("command registry exposes every parsed top-level command", async () => {
  const registry = createCommandRegistry(
    Object.fromEntries(
      COMMAND_NAMES.map((name) => [
        name,
        async () => okEnvelope(`TEST_${name.toUpperCase()}`, null)
      ])
    )
  );
  for (const name of COMMAND_NAMES) {
    assert.equal(typeof registry.get(name), "function", name);
    assert.equal((await registry.get(name)?.({
      command: name,
      profiles: [],
      dryRun: false,
      json: true,
      yes: false
    }))?.status, "ok");
  }
});
