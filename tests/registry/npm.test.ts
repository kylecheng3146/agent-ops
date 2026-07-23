import assert from "node:assert/strict";
import test from "node:test";

import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import {
  NpmRegistryClient,
  type RegistryFetch
} from "../../runtime/src/registry/npm.js";

function response(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" }
  });
}

function errorWithCode(
  code: string,
  forbiddenText?: string
): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof AgentOpsError &&
    error.code === code &&
    (forbiddenText === undefined ||
      !error.message.includes(forbiddenText)) &&
    error.cause === undefined;
}

test("fetches only when requested using fixed HTTPS GET policy", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: RegistryFetch = async (
    url: string,
    init: RequestInit
  ) => {
    calls.push({ url, init });
    return response(
      JSON.stringify({
        "dist-tags": { latest: "1.2.3-beta.1+build.5" }
      })
    );
  };
  const client = new NpmRegistryClient({ fetch });

  assert.equal(calls.length, 0);
  assert.equal(
    await client.latestVersion("agent-ops"),
    "1.2.3-beta.1+build.5"
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://registry.npmjs.org/agent-ops");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.redirect, "error");
  assert.ok(calls[0]?.init.signal instanceof AbortSignal);
});

test("encodes a scoped package name as one exact URL path segment", async () => {
  let requestedUrl = "";
  const client = new NpmRegistryClient({
    fetch: async (url: string) => {
      requestedUrl = url;
      return response(
        JSON.stringify({ "dist-tags": { latest: "2.0.0" } })
      );
    }
  });

  assert.equal(await client.latestVersion("@scope/package"), "2.0.0");
  assert.equal(
    requestedUrl,
    "https://registry.npmjs.org/%40scope%2Fpackage"
  );
});

test("rejects non-200 and redirect responses without exposing bodies", async () => {
  const secretBody = "RAW_REGISTRY_TOKEN";
  for (const status of [302, 503]) {
    const client = new NpmRegistryClient({
      fetch: async () => response(secretBody, status)
    });

    await assert.rejects(
      () => client.latestVersion("agent-ops"),
      errorWithCode("REGISTRY_HTTP_STATUS", secretBody)
    );
  }
});

test("rejects malformed JSON and invalid latest tags", async () => {
  const invalidBodies = [
    "not json",
    "[]",
    JSON.stringify({}),
    JSON.stringify({ "dist-tags": {} }),
    JSON.stringify({ "dist-tags": { latest: "" } }),
    JSON.stringify({ "dist-tags": { latest: "latest" } })
  ];

  for (const body of invalidBodies) {
    const client = new NpmRegistryClient({
      fetch: async () => response(body)
    });
    await assert.rejects(
      () => client.latestVersion("agent-ops"),
      errorWithCode("REGISTRY_RESPONSE_INVALID", body)
    );
  }
});

test("rejects responses that exceed the configured byte bound", async () => {
  const oversized = JSON.stringify({
    "dist-tags": { latest: "1.2.3" },
    payload: "RAW_REGISTRY_TOKEN"
  });
  const client = new NpmRegistryClient({
    fetch: async () => response(oversized),
    maxResponseBytes: 16
  });

  await assert.rejects(
    () => client.latestVersion("agent-ops"),
    errorWithCode("REGISTRY_RESPONSE_TOO_LARGE", "RAW_REGISTRY_TOKEN")
  );
});

test("aborts and reports a stable timeout without exposing fetch errors", async () => {
  const fetch: RegistryFetch = async (
    _url: string,
    init: RequestInit
  ) =>
    await new Promise<Response>((_resolve, reject) => {
      const rejectOnAbort = () =>
        reject(new Error("RAW_REGISTRY_TOKEN"));
      if (init.signal?.aborted === true) {
        rejectOnAbort();
        return;
      }
      init.signal?.addEventListener("abort", rejectOnAbort, {
        once: true
      });
    });
  const client = new NpmRegistryClient({ fetch, timeoutMs: 10 });

  await assert.rejects(
    () => client.latestVersion("agent-ops"),
    errorWithCode("REGISTRY_TIMEOUT", "RAW_REGISTRY_TOKEN")
  );
});
