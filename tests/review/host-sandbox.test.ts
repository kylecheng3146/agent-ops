import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import test from "node:test";

import {
  BIND_DEPENDENT_TARGETS,
  REACH_TIMEOUT_MS,
  TARGET_API_HOST,
  detectHostRestriction,
  probeHostReachable,
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

test("the real probe resolves to a boolean on restricted and unrestricted hosts", async () => {
  assert.equal(typeof await probeLoopbackBind(), "boolean");
});

test("agy is the target that needs a loopback listener", () => {
  assert.deepEqual([...BIND_DEPENDENT_TARGETS], ["agy"]);
});

test("each target is checked against its own API host", () => {
  assert.deepEqual(TARGET_API_HOST, {
    agy: "cloudcode-pa.googleapis.com",
    codex: "api.openai.com",
    claude: "api.anthropic.com"
  });
});

test("the reachability check is short and tells an open port from a closed one", async (t) => {
  assert.ok(REACH_TIMEOUT_MS <= 2_000);
  if (!(await probeLoopbackBind())) {
    t.skip("loopback listeners are blocked on this host");
    return;
  }
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    assert.equal(await probeHostReachable("127.0.0.1", port), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // The listener is closed now, so the same port refuses the connection.
  assert.equal(await probeHostReachable("127.0.0.1", port), false);
});
