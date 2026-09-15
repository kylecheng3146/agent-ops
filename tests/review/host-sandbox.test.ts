import assert from "node:assert/strict";
import test from "node:test";

import {
  BIND_DEPENDENT_TARGETS,
  detectHostRestriction,
  probeLoopbackBind
} from "../../runtime/src/review/host-sandbox.js";

test("a declared network block is read without probing anything", async () => {
  let probed = false;
  const restriction = await detectHostRestriction({
    env: { CODEX_SANDBOX: "seatbelt", CODEX_SANDBOX_NETWORK_DISABLED: "1" },
    probeBind: async () => {
      probed = true;
      return true;
    }
  });

  assert.equal(restriction, "network-blocked");
  // No reviewer can reach its API without a network, so the narrower loopback
  // question adds latency to an answer that is already settled.
  assert.equal(probed, false);
});

test("the bind probe decides when the host declares nothing", async () => {
  assert.equal(
    await detectHostRestriction({ env: {}, probeBind: async () => false }),
    "bind-blocked"
  );
  assert.equal(
    await detectHostRestriction({ env: {}, probeBind: async () => true }),
    "none"
  );
  // A sandbox marker on its own is not a restriction: seatbelt with the
  // network proxied still lets every target answer.
  assert.equal(
    await detectHostRestriction({
      env: { CODEX_SANDBOX: "seatbelt" },
      probeBind: async () => true
    }),
    "none"
  );
});

test("the real probe answers on an unrestricted host", async () => {
  assert.equal(await probeLoopbackBind(), true);
});

test("agy is the target that needs a loopback listener", () => {
  assert.deepEqual([...BIND_DEPENDENT_TARGETS], ["agy"]);
});
